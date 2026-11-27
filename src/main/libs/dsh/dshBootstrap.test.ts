import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, test, vi } from 'vitest';

const orphanReapMock = vi.hoisted(() => vi.fn(async () => 0));
const cronBackfillMock = vi.hoisted(() => vi.fn(async () => ({
  status: 'skipped' as const,
  tasksImported: 0,
  runsImported: 0,
})));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => os.tmpdir(),
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
  },
}));

vi.mock('../dshOrphanReaper', () => ({
  reapOrphanedDshRuntimes: orphanReapMock,
  clearDshCleanShutdownMarker: vi.fn(),
  writeDshCleanShutdownMarker: vi.fn(),
}));

vi.mock('../../migration/legacyOpenClawMigrator', async () => {
  const actual = await vi.importActual<typeof import('../../migration/legacyOpenClawMigrator')>(
    '../../migration/legacyOpenClawMigrator',
  );
  return {
    ...actual,
    backfillLegacyScheduledTasksFromBackup: cronBackfillMock,
  };
});

import {
  DECISION_EVALUATE_TOOL_NAME,
  DecisionModelProvider,
} from '../../../shared/decisionModel/constants';
import { DshHostPhase } from '../../../shared/dshEngine/hostConstants';
import {
  OpenClawEngineErrorCode,
  OpenClawEnginePhase,
} from '../../../shared/openclawEngine/constants';
import { type DecisionModelConfig, DEFAULT_DECISION_MODEL_CONFIG } from '../decisionModelConfig';
import { type LoopbackBlockCheck, LoopbackSelfTestOutcome } from '../loopbackSelfTest';
import {
  createSingleFlightAsyncTracker,
  DshBootstrap,
  type DshCompatEngineStatus,
} from './dshBootstrap';
import { createDshDecisionToolProvider } from './dshDecisionTool';
import { DshHostBootTimeoutError } from './dshHostManager';

const tempDirs: string[] = [];
const openDbs: Database.Database[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-dsh-bootstrap-test-'));
  tempDirs.push(dir);
  return dir;
}

function createTestBootstrap(options: {
  onStatusChange?: (status: DshCompatEngineStatus) => void;
  platform?: NodeJS.Platform;
  detectLoopbackBlock?: () => Promise<LoopbackBlockCheck>;
} = {}) {
  const userDataDir = createTempDir();
  const db = new Database(path.join(userDataDir, 'lobsterai.sqlite'));
  db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)');

  const bootstrap = new DshBootstrap({
    userDataDir,
    db,
    skillsDir: path.join(userDataDir, 'SKILLs'),
    coworkStore: {
      getSession: () => null,
      addMessage: () => ({ id: 'm1', type: 'user', content: '', timestamp: Date.now() }),
      updateMessageContent: () => undefined,
      updateSession: () => undefined,
    },
    getDefaultCwd: () => userDataDir,
    runtimePaths: {
      runtimeDir: path.join(userDataDir, 'runtime'),
      hostBundleDir: path.join(userDataDir, 'host-bundle'),
      channelsBundleDir: null,
    },
    executablePath: process.execPath,
    skipElectronRunAsNode: true,
    platform: options.platform,
    detectLoopbackBlock: options.detectLoopbackBlock,
    onStatusChange: (compat) => options.onStatusChange?.(compat),
  });

  return { bootstrap, db, userDataDir };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.clearAllMocks();
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

test('preserves Cordis severity and the default levels of ordinary host output', async () => {
  const { bootstrap, db } = createTestBootstrap();
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
  try {
    for (const [level, sink] of [['info', info], ['warn', warn], ['error', error]] as const) {
      const text = `[dsh-logger][${level}][probe] message`;
      bootstrap.hostManager.emit('log', { stream: 'stderr', text });
      expect(sink).toHaveBeenCalledWith(text);
    }
    bootstrap.hostManager.emit('log', { stream: 'stderr', text: 'plain stderr' });
    bootstrap.hostManager.emit('log', { stream: 'stdout', text: 'plain stdout' });
    expect(warn).toHaveBeenCalledWith('[DSH:stderr] plain stderr');
    expect(debug).toHaveBeenCalledWith('[DSH:stdout] plain stdout');
  } finally {
    vi.restoreAllMocks();
    await bootstrap.stop();
    db.close();
  }
});

describe('DshBootstrap startup deduplication and initial config sync gate', () => {
  test('deduplicates concurrent start() calls and keeps engine in Starting until syncInitialConfig completes', async () => {
    const phases: OpenClawEnginePhase[] = [];
    const { bootstrap, db } = createTestBootstrap({
      onStatusChange: (status) => phases.push(status.phase),
    });

    try {
      let hostReady = false;
      const hostStartGate = deferred<void>();
      const syncGate = deferred<{ success: boolean }>();

      const hostStartSpy = vi.spyOn(bootstrap.hostManager, 'start').mockImplementation(async () => {
        await hostStartGate.promise;
        hostReady = true;
        bootstrap.hostManager.emit('phaseChange', DshHostPhase.Ready, {
          ...bootstrap.hostManager.getStatus(),
          phase: DshHostPhase.Ready,
        });
      });
      vi.spyOn(bootstrap.hostManager, 'isReady').mockImplementation(() => hostReady);
      vi.spyOn(bootstrap.hostManager, 'getStatus').mockImplementation(() => ({
        phase: hostReady ? DshHostPhase.Ready : DshHostPhase.Starting,
        origin: hostReady ? 'http://127.0.0.1:9999' : null,
        authenticatedWebUrl: null,
        pid: hostReady ? 12345 : null,
        runtimeVersion: '0.2.2-rc.5',
        profileDir: '/tmp/profile',
        dshHomeDir: '/tmp/dsh-profile',
        cliShimPath: null,
        lastError: null,
        startedAt: hostReady ? Date.now() : null,
        restartCount: 0,
      }));

      const syncToolsSpy = vi
        .spyOn(bootstrap['bridgeWiring'], 'syncDynamicHostTools')
        .mockResolvedValue({ ok: true });
      const schedulerStartSpy = vi.spyOn(bootstrap.scheduler, 'start').mockImplementation(() => undefined);

      const syncInitialConfig = vi.fn(async () => syncGate.promise);

      // Fire 3 concurrent start() calls (simulating startup + early user prompt + cron).
      const p1 = bootstrap.start({ syncInitialConfig });
      const p2 = bootstrap.start({ syncInitialConfig });
      const p3 = bootstrap.start();

      // Let hostManager become ready while syncInitialConfig is still pending!
      hostStartGate.resolve();
      await new Promise((r) => setTimeout(r, 25));

      // CRITICAL: hostManager is Ready, yet initial config sync has NOT completed:
      // - isReadyForTurns() MUST remain false
      // - getEngineStatus().phase MUST remain Starting (not Running!)
      // - scheduler MUST NOT have started yet
      expect(bootstrap.hostManager.isReady()).toBe(true);
      expect(bootstrap.isInitialConfigSynced()).toBe(false);
      expect(bootstrap.isReadyForTurns()).toBe(false);
      expect(bootstrap.getEngineStatus().phase).toBe(OpenClawEnginePhase.Starting);
      expect(schedulerStartSpy).not.toHaveBeenCalled();

      // Release initial config sync.
      syncGate.resolve({ success: true });
      const [s1, s2, s3] = await Promise.all([p1, p2, p3]);

      expect(s1.phase).toBe(OpenClawEnginePhase.Running);
      expect(s2.phase).toBe(OpenClawEnginePhase.Running);
      expect(s3.phase).toBe(OpenClawEnginePhase.Running);
      expect(bootstrap.isInitialConfigSynced()).toBe(true);
      expect(bootstrap.isReadyForTurns()).toBe(true);
      expect(phases.at(-1)).toBe(OpenClawEnginePhase.Running);

      // Every startup side effect executed ONCE despite 3 concurrent callers.
      expect(orphanReapMock).toHaveBeenCalledTimes(1);
      expect(hostStartSpy).toHaveBeenCalledTimes(1);
      expect(syncToolsSpy).toHaveBeenCalledTimes(1);
      expect(syncInitialConfig).toHaveBeenCalledTimes(1);
      expect(schedulerStartSpy).toHaveBeenCalledTimes(1);

      // Subsequent start() call is an O(1) idempotent no-op.
      const s4 = await bootstrap.start({ syncInitialConfig });
      expect(s4.phase).toBe(OpenClawEnginePhase.Running);
      expect(hostStartSpy).toHaveBeenCalledTimes(1);
      expect(syncInitialConfig).toHaveBeenCalledTimes(1);
    } finally {
      await bootstrap.stop();
      db.close();
    }
  });

  test('restores initial config and starts the scheduler once after a host launch timeout', async () => {
    const { bootstrap, db } = createTestBootstrap();
    try {
      let hostReady = false;
      const start = vi.spyOn(bootstrap.hostManager, 'start')
        .mockRejectedValueOnce(new DshHostBootTimeoutError(90_000, ''))
        .mockImplementation(async () => { hostReady = true; });
      vi.spyOn(bootstrap.hostManager, 'isReady').mockImplementation(() => hostReady);
      vi.spyOn(bootstrap['bridgeWiring'], 'syncDynamicHostTools').mockResolvedValue({ ok: true });
      const syncInitialConfig = vi.fn(async () => ({ success: true }));
      const schedulerStart = vi.spyOn(bootstrap.scheduler, 'start').mockImplementation(() => undefined);

      await Promise.all([bootstrap.start({ syncInitialConfig }), bootstrap.start({ syncInitialConfig })]);

      expect(start).toHaveBeenCalledTimes(2);
      expect(syncInitialConfig).toHaveBeenCalledTimes(1);
      expect(schedulerStart).toHaveBeenCalledTimes(1);
      expect(syncInitialConfig).toHaveBeenCalledBefore(schedulerStart);
      expect(bootstrap.isReadyForTurns()).toBe(true);
    } finally {
      await bootstrap.stop();
      db.close();
    }
  });

  test('returns the second host timeout without starting the scheduler or resyncing', async () => {
    const { bootstrap, db } = createTestBootstrap();
    try {
      const timeout = new DshHostBootTimeoutError(90_000, '');
      const start = vi.spyOn(bootstrap.hostManager, 'start').mockRejectedValue(timeout);
      const schedulerStart = vi.spyOn(bootstrap.scheduler, 'start');
      const syncInitialConfig = vi.fn(async () => ({ success: true }));

      await expect(bootstrap.start({ syncInitialConfig })).rejects.toBe(timeout);
      expect(start).toHaveBeenCalledTimes(2);
      expect(syncInitialConfig).not.toHaveBeenCalled();
      expect(schedulerStart).not.toHaveBeenCalled();
      expect(bootstrap.isReadyForTurns()).toBe(false);
    } finally {
      await bootstrap.stop();
      db.close();
    }
  });

  test('clears in-flight startPromise on boot failure so subsequent retries succeed cleanly', async () => {
    const { bootstrap, db } = createTestBootstrap();

    try {
      let attempt = 0;
      let hostReady = false;
      vi.spyOn(bootstrap.hostManager, 'start').mockImplementation(async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error('transient spawn failure');
        }
        hostReady = true;
      });
      vi.spyOn(bootstrap.hostManager, 'isReady').mockImplementation(() => hostReady);
      vi.spyOn(bootstrap.hostManager, 'getStatus').mockImplementation(() => ({
        phase: hostReady ? DshHostPhase.Ready : DshHostPhase.Failed,
        origin: null,
        authenticatedWebUrl: null,
        pid: null,
        runtimeVersion: '0.2.2-rc.5',
        profileDir: '/tmp/profile',
        dshHomeDir: '/tmp/dsh-profile',
        cliShimPath: null,
        lastError: hostReady ? null : 'transient spawn failure',
        startedAt: null,
        restartCount: 0,
      }));
      vi.spyOn(bootstrap['bridgeWiring'], 'syncDynamicHostTools').mockResolvedValue({ ok: true });
      vi.spyOn(bootstrap.scheduler, 'start').mockImplementation(() => undefined);

      await expect(bootstrap.start()).rejects.toThrow('transient spawn failure');
      expect(bootstrap.isReadyForTurns()).toBe(false);

      const syncInitialConfig = vi.fn(async () => ({ success: true }));
      const status = await bootstrap.start({ syncInitialConfig });
      expect(status.phase).toBe(OpenClawEnginePhase.Running);
      expect(bootstrap.isReadyForTurns()).toBe(true);
      expect(syncInitialConfig).toHaveBeenCalledTimes(1);
    } finally {
      await bootstrap.stop();
      db.close();
    }
  });

  test('retries initial config sync when a previous sync returned { success: false } without re-booting host', async () => {
    const { bootstrap, db } = createTestBootstrap();

    try {
      let hostReady = false;
      const hostStartSpy = vi.spyOn(bootstrap.hostManager, 'start').mockImplementation(async () => {
        hostReady = true;
      });
      vi.spyOn(bootstrap.hostManager, 'isReady').mockImplementation(() => hostReady);
      vi.spyOn(bootstrap.hostManager, 'getStatus').mockImplementation(() => ({
        phase: hostReady ? DshHostPhase.Ready : DshHostPhase.Stopped,
        origin: null,
        authenticatedWebUrl: null,
        pid: null,
        runtimeVersion: '0.2.2-rc.5',
        profileDir: '/tmp/profile',
        dshHomeDir: '/tmp/dsh-profile',
        cliShimPath: null,
        lastError: null,
        startedAt: null,
        restartCount: 0,
      }));
      vi.spyOn(bootstrap['bridgeWiring'], 'syncDynamicHostTools').mockResolvedValue({ ok: true });
      vi.spyOn(bootstrap.scheduler, 'start').mockImplementation(() => undefined);

      const failingSync = vi.fn(async () => ({ success: false }));
      await bootstrap.start({ syncInitialConfig: failingSync });
      expect(bootstrap.isInitialConfigSynced()).toBe(false);
      expect(bootstrap.isReadyForTurns()).toBe(false);

      const succeedingSync = vi.fn(async () => ({ success: true }));
      await bootstrap.start({ syncInitialConfig: succeedingSync });
      expect(bootstrap.isInitialConfigSynced()).toBe(true);
      expect(bootstrap.isReadyForTurns()).toBe(true);
      // Host was NOT restarted for the config sync retry.
      expect(hostStartSpy).toHaveBeenCalledTimes(1);
      expect(succeedingSync).toHaveBeenCalledTimes(1);
    } finally {
      await bootstrap.stop();
      db.close();
    }
  });

  test('pauses Windows DSH startup with LoopbackBlocked when loopback self-test is blocked, and recovers after restart()', async () => {
    let blocked = true;
    const emitted: DshCompatEngineStatus[] = [];
    const { bootstrap, db } = createTestBootstrap({
      platform: 'win32',
      detectLoopbackBlock: async () => (
        blocked
          ? {
              blocked: true,
              attempts: 2,
              last: { outcome: LoopbackSelfTestOutcome.Blocked, code: 'ETIMEDOUT', elapsedMs: 610 },
            }
          : {
              blocked: false,
              attempts: 1,
              last: { outcome: LoopbackSelfTestOutcome.Ok, elapsedMs: 4 },
            }
      ),
      onStatusChange: (status) => emitted.push(status),
    });

    try {
      let hostReady = false;
      const hostStartSpy = vi.spyOn(bootstrap.hostManager, 'start').mockImplementation(async () => {
        hostReady = true;
      });
      const hostRestartSpy = vi.spyOn(bootstrap.hostManager, 'restart').mockImplementation(async () => {
        hostReady = true;
      });
      vi.spyOn(bootstrap.hostManager, 'isReady').mockImplementation(() => hostReady);
      vi.spyOn(bootstrap.hostManager, 'getStatus').mockImplementation(() => ({
        phase: hostReady ? DshHostPhase.Ready : DshHostPhase.Stopped,
        origin: hostReady ? 'http://127.0.0.1:9999' : null,
        authenticatedWebUrl: null,
        pid: hostReady ? 12345 : null,
        runtimeVersion: '0.2.2-rc.5',
        profileDir: '/tmp/profile',
        dshHomeDir: '/tmp/dsh-profile',
        cliShimPath: null,
        lastError: null,
        startedAt: hostReady ? Date.now() : null,
        restartCount: 0,
      }));
      vi.spyOn(bootstrap['bridgeWiring'], 'syncDynamicHostTools').mockResolvedValue({ ok: true });
      const schedulerStartSpy = vi.spyOn(bootstrap.scheduler, 'start').mockImplementation(() => undefined);
      const syncInitialConfig = vi.fn(async () => ({ success: true }));

      const blockedStatus = await bootstrap.start({ syncInitialConfig });
      expect(blockedStatus.phase).toBe(OpenClawEnginePhase.Error);
      expect(blockedStatus.errorCode).toBe(OpenClawEngineErrorCode.LoopbackBlocked);
      expect(blockedStatus.canRetry).toBe(true);
      expect(blockedStatus.message).toContain('ETIMEDOUT');
      expect(bootstrap.getEngineStatus()).toEqual(blockedStatus);
      expect(emitted.at(-1)).toEqual(blockedStatus);
      expect(hostStartSpy).not.toHaveBeenCalled();
      expect(syncInitialConfig).not.toHaveBeenCalled();
      expect(schedulerStartSpy).not.toHaveBeenCalled();
      expect(bootstrap.isReadyForTurns()).toBe(false);

      // Simulate user clicking "Allow Local Connections" and repairing the firewall.
      blocked = false;
      const recovered = await bootstrap.restart();
      expect(recovered.phase).toBe(OpenClawEnginePhase.Running);
      expect(recovered.errorCode).toBeUndefined();
      expect(hostRestartSpy).toHaveBeenCalledTimes(1);
      expect(syncInitialConfig).toHaveBeenCalledTimes(1);
      expect(schedulerStartSpy).toHaveBeenCalledTimes(1);
      expect(bootstrap.isReadyForTurns()).toBe(true);
    } finally {
      await bootstrap.stop();
      db.close();
    }
  });

  test('continues Windows DSH startup when loopback self-test is inconclusive', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { bootstrap, db } = createTestBootstrap({
      platform: 'win32',
      detectLoopbackBlock: async () => ({
        blocked: false,
        attempts: 1,
        last: { outcome: LoopbackSelfTestOutcome.Inconclusive, code: 'ECONNRESET', elapsedMs: 12 },
      }),
    });

    try {
      let hostReady = false;
      const hostStartSpy = vi.spyOn(bootstrap.hostManager, 'start').mockImplementation(async () => {
        hostReady = true;
      });
      vi.spyOn(bootstrap.hostManager, 'isReady').mockImplementation(() => hostReady);
      vi.spyOn(bootstrap.hostManager, 'getStatus').mockImplementation(() => ({
        phase: hostReady ? DshHostPhase.Ready : DshHostPhase.Starting,
        origin: hostReady ? 'http://127.0.0.1:9999' : null,
        authenticatedWebUrl: null,
        pid: hostReady ? 12345 : null,
        runtimeVersion: '0.2.2-rc.5',
        profileDir: '/tmp/profile',
        dshHomeDir: '/tmp/dsh-profile',
        cliShimPath: null,
        lastError: null,
        startedAt: hostReady ? Date.now() : null,
        restartCount: 0,
      }));
      vi.spyOn(bootstrap['bridgeWiring'], 'syncDynamicHostTools').mockResolvedValue({ ok: true });
      vi.spyOn(bootstrap.scheduler, 'start').mockImplementation(() => undefined);

      const status = await bootstrap.start({ syncInitialConfig: async () => ({ success: true }) });
      expect(status.phase).toBe(OpenClawEnginePhase.Running);
      expect(hostStartSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('loopback self-test inconclusive (ECONNRESET)'));
    } finally {
      warnSpy.mockRestore();
      await bootstrap.stop();
      db.close();
    }
  });
});

describe('DshBootstrap.syncAllConfig', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    while (openDbs.length > 0) openDbs.pop()!.close();
    while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  });

  test('calls syncDynamicHostTools so toggling decision model hot-syncs without restart', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-dsh-bootstrap-'));
    tempDirs.push(userDataDir);
    const db = new Database(':memory:');
    openDbs.push(db);

    let config: DecisionModelConfig = { ...DEFAULT_DECISION_MODEL_CONFIG };
    const bootstrap = new DshBootstrap({
      userDataDir,
      db,
      skillsDir: path.join(userDataDir, 'SKILLs'),
      coworkStore: {
        getSession: () => null,
        addMessage: () => ({
          id: 'msg-1',
          type: 'assistant',
          content: '',
          timestamp: Date.now(),
        }),
        updateMessageContent: () => undefined,
        deleteMessage: () => false,
        updateSession: () => undefined,
      },
      getDefaultCwd: () => userDataDir,
      toolProviders: [
        createDshDecisionToolProvider({
          getConfig: () => config,
          fetch: vi.fn(),
        }),
      ],
    });

    const syncHostToolsSpy = vi.spyOn(bootstrap.hostManager, 'syncHostTools');
    const restartSpy = vi.spyOn(bootstrap.hostManager, 'restart');

    const syncInput = {
      providers: {},
      mcpServers: [],
      skillsPolicy: { enabledIds: null, disabledIds: [] },
    };

    const first = await bootstrap.syncAllConfig(syncInput);
    expect(first.success).toBe(true);
    expect(syncHostToolsSpy).toHaveBeenCalledTimes(1);
    expect(syncHostToolsSpy.mock.calls[0][0]).toEqual([]);

    config = {
      enabled: true,
      provider: DecisionModelProvider.Compatible,
      endpoint: 'http://127.0.0.1:41999/v1/systemone',
      apiKey: 'secret-decision-key',
      apiKeys: { [DecisionModelProvider.Compatible]: 'secret-decision-key' },
    };

    const second = await bootstrap.syncAllConfig(syncInput);
    expect(second.success).toBe(true);
    expect(syncHostToolsSpy).toHaveBeenCalledTimes(2);
    expect(syncHostToolsSpy.mock.calls[1][0].map(tool => tool.name)).toEqual([DECISION_EVALUATE_TOOL_NAME]);
    expect(restartSpy).not.toHaveBeenCalled();

    await bootstrap.stop();
  });

  test('deferExternalSync resolves critical sync immediately without waiting for slow IM sync or OAuth MCP', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-dsh-bootstrap-'));
    tempDirs.push(userDataDir);
    const db = new Database(':memory:');
    openDbs.push(db);

    const bootstrap = new DshBootstrap({
      userDataDir,
      db,
      skillsDir: path.join(userDataDir, 'SKILLs'),
      coworkStore: {
        getSession: () => null,
        addMessage: () => ({
          id: 'msg-1',
          type: 'assistant',
          content: '',
          timestamp: Date.now(),
        }),
        updateMessageContent: () => undefined,
        deleteMessage: () => false,
        updateSession: () => undefined,
      },
      getDefaultCwd: () => userDataDir,
      runtimePaths: {
        runtimeDir: path.join(userDataDir, 'runtime'),
        hostBundleDir: path.join(userDataDir, 'host-bundle'),
        channelsBundleDir: path.join(userDataDir, 'channels-bundle'),
      },
    });

    vi.spyOn(bootstrap.hostManager, 'isReady').mockReturnValue(true);
    vi.spyOn(bootstrap.hostManager, 'syncProviders').mockResolvedValue({ ok: true });
    vi.spyOn(bootstrap.hostManager, 'syncSkillsPolicy').mockResolvedValue({ ok: true });
    const syncMcpSpy = vi.spyOn(bootstrap.hostManager, 'syncMcpServers').mockResolvedValue({ ok: true });
    const syncHostToolsSpy = vi.spyOn(bootstrap.hostManager, 'syncHostTools').mockResolvedValue({ ok: true });
    const imGate = deferred<{
      ok: boolean;
      started: string[];
      stopped: string[];
      errors: Array<{ key: string; error: string }>;
      skippedRetiredPlatforms: string[];
      statuses: unknown[];
    }>();
    const syncImSpy = vi.spyOn(bootstrap.channelsBridge, 'syncInstances').mockImplementation(() => imGate.promise);

    const result = await bootstrap.syncAllConfig(
      {
        providers: {},
        mcpServers: [
          {
            id: 'sse-1',
            name: 'demo-sse',
            transportType: 'sse',
            url: 'https://mcp.example.com/sse',
            enabled: true,
          },
        ],
        skillsPolicy: { enabledIds: null, disabledIds: [] },
        imInstances: [
          {
            platform: 'feishu',
            instanceId: 'default',
            enabled: true,
            config: { appId: 'a', appSecret: 'b' },
          },
        ],
      },
      { deferExternalSync: true, skipHostToolsSync: true },
    );

    expect(result.success).toBe(true);
    expect(syncHostToolsSpy).not.toHaveBeenCalled();
    expect(syncMcpSpy).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: 'demo-sse' })]),
      { deferSseWait: true },
    );

    // Deferred IM sync starts asynchronously in the background after critical sync resolves.
    await new Promise((r) => setTimeout(r, 10));
    expect(syncImSpy).toHaveBeenCalledTimes(1);
    imGate.resolve({
      ok: true,
      started: ['feishu:default'],
      stopped: [],
      errors: [],
      skippedRetiredPlatforms: [],
      statuses: [],
    });
    await bootstrap.stop();
  });

  test('doStart completes without blocking on slow legacy backup backfills', async () => {
    const { bootstrap, db } = createTestBootstrap();
    const slowBackfill = deferred<{ status: 'skipped'; tasksImported: number; runsImported: number }>();
    cronBackfillMock.mockImplementationOnce(() => slowBackfill.promise);

    try {
      let hostReady = false;
      vi.spyOn(bootstrap.hostManager, 'start').mockImplementation(async () => {
        hostReady = true;
      });
      vi.spyOn(bootstrap.hostManager, 'isReady').mockImplementation(() => hostReady);
      vi.spyOn(bootstrap.hostManager, 'getStatus').mockImplementation(() => ({
        phase: hostReady ? DshHostPhase.Ready : DshHostPhase.Starting,
        origin: hostReady ? 'http://127.0.0.1:9999' : null,
        authenticatedWebUrl: null,
        pid: hostReady ? 12345 : null,
        runtimeVersion: '0.2.2-rc.5',
        profileDir: '/tmp/profile',
        dshHomeDir: '/tmp/dsh-profile',
        cliShimPath: null,
        lastError: null,
        startedAt: hostReady ? Date.now() : null,
        restartCount: 0,
      }));
      vi.spyOn(bootstrap['bridgeWiring'], 'syncDynamicHostTools').mockResolvedValue({ ok: true });
      vi.spyOn(bootstrap.scheduler, 'start').mockImplementation(() => undefined);

      // Must resolve even though cronBackfillMock has NOT resolved yet.
      const status = await bootstrap.start({
        syncInitialConfig: async () => ({ success: true }),
      });
      expect(status.phase).toBe(OpenClawEnginePhase.Running);
      expect(bootstrap.isReadyForTurns()).toBe(true);

      slowBackfill.resolve({ status: 'skipped', tasksImported: 0, runsImported: 0 });
    } finally {
      await bootstrap.stop();
      db.close();
    }
  });
});

describe('createSingleFlightAsyncTracker', () => {
  test('clears tracked promise after rejection so retry and subsequent admission succeed', async () => {
    const tracker = createSingleFlightAsyncTracker<string>();
    const firstGate = deferred<string>();
    const firstFactory = vi.fn(() => firstGate.promise);

    const p1 = tracker.run(firstFactory);
    const p2 = tracker.run(vi.fn(async () => 'should-not-run'));
    expect(p2).toBe(p1);
    expect(tracker.getInFlight()).toBe(p1);
    expect(firstFactory).toHaveBeenCalledTimes(1);

    firstGate.reject(new Error('DSH runtime binary not found'));
    await expect(p1).rejects.toThrow('DSH runtime binary not found');
    // Allow .finally() cleanup microtask to settle.
    await Promise.resolve();
    expect(tracker.getInFlight()).toBeNull();

    // Subsequent retry succeeds and also clears once settled so future callers re-check live readiness.
    const retryResult = await tracker.run(async () => 'running', { force: true });
    expect(retryResult).toBe('running');
    await Promise.resolve();
    expect(tracker.getInFlight()).toBeNull();

    const nextResult = await tracker.run(async () => 'rechecked');
    expect(nextResult).toBe('rechecked');
  });

  test('force: true replaces in-flight attempt so waiters join retry and older settlement cannot clobber it', async () => {
    const tracker = createSingleFlightAsyncTracker<string>();
    const staleGate = deferred<string>();
    const retryGate = deferred<string>();

    const stale = tracker.run(() => staleGate.promise);
    const retry = tracker.run(() => retryGate.promise, { force: true });

    expect(retry).not.toBe(stale);
    expect(tracker.getInFlight()).toBe(retry);
    // Concurrent waiter joins the active forced retry instead of launching a third attempt.
    expect(tracker.run(vi.fn(async () => 'unexpected'))).toBe(retry);

    // When the superseded attempt fails later, it must NOT clear the active retry reference.
    staleGate.reject(new Error('stale failure'));
    await expect(stale).rejects.toThrow('stale failure');
    await Promise.resolve();
    expect(tracker.getInFlight()).toBe(retry);

    retryGate.resolve('recovered');
    await expect(retry).resolves.toBe('recovered');
    await Promise.resolve();
    expect(tracker.getInFlight()).toBeNull();
  });
});
