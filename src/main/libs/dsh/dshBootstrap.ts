// Main-process orchestration hub for DeepSeek Harness (DSH) as LobsterAI's
// primary agent runtime.
//
// Owns:
// - Pre-boot offline OpenClaw -> DSH v2 migration (`runLegacyOpenClawMigration`)
// - `DshHostManager` (App-Owned Profile, process supervision, local callback bridge)
// - `DshRuntimeAdapter` (`CoworkRuntime` over DSH Typert WS/HTTP)
// - `LobsterMemoryService` (`<userData>/workspaces/<agentId>/` + FTS5)
// - `LobsterScheduler` (SQLite-backed scheduled tasks -> DSH turns + IM delivery)
// - `McpOAuthManager` (encrypted Remote MCP OAuth 2.1 PKCE token manager)
// - `DshChannelsBridge` (7 retained mainstream IM platforms via `@lobsterai/dsh-channels`)
// - Isolated Dual-Track DSH Ecosystem Web View (`BrowserWindow`)

import type Database from 'better-sqlite3';
import { app, BrowserWindow, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

import {
  DeliveryMode,
  IpcChannel as ScheduledTaskIpc,
  RunDeliveryStatus,
} from '../../../scheduledTask/constants';
import type {
  ScheduledTask,
  ScheduledTaskRunEvent,
  ScheduledTaskStatusEvent,
} from '../../../scheduledTask/types';
import {
  DEFAULT_DSH_PERMISSION_PRESET,
  DSH_PERMISSION_PRESET_KV_KEY,
  DshHostPhase,
  DshPermissionPreset,
  WORKSPACES_DIR_NAME,
} from '../../../shared/dshEngine/hostConstants';
import { OpenClawEnginePhase } from '../../../shared/openclawEngine/constants';
import { type DshChannelInstanceConfig, DshChannelsBridge } from '../../im/dshChannelsBridge';
import { McpOAuthManager } from '../../mcp/mcpOAuthManager';
import { LobsterMemoryService } from '../../memory/lobsterMemoryService';
import {
  backfillLegacyScheduledTasksFromBackup,
  type LegacyOpenClawMigrationResult,
  runLegacyOpenClawMigration,
} from '../../migration/legacyOpenClawMigrator';
import {
  LobsterScheduler,
  type LobsterSchedulerRunResult,
} from '../../scheduledTask/lobsterScheduler';
import {
  type DshCoworkStorePort,
  type DshModelSelection,
  DshRuntimeAdapter,
} from '../agentEngine/dshRuntimeAdapter';
import { ensureElectronNodeShim, getElectronNodeRuntimePath } from '../coworkUtil';
import { reapOrphanedDshRuntimes } from '../dshOrphanReaper';
import { resolveDshBundledGitBinDir } from '../dshRuntime';
import {
  type ApprovalAllowRulePort,
  type HostToolProvider,
  wireDshHostBridge,
} from './dshHostBridgeWiring';
import {
  type DshHostAgentSpec,
  DshHostManager,
  type DshHostStatus,
  resolveBundledDshPaths,
} from './dshHostManager';
import type { DshNodeToolchain } from './dshProfileManager';
import {
  buildDshMcpServerSpecs,
  buildDshProvidersPayload,
  type LobsterMcpServerRecord,
  type LobsterProviderConfig,
} from './dshProviderSync';
import { runScheduledTurn } from './dshScheduledTurn';
import { DshSubagentSessions } from './dshSubagentSessions';

export interface DshCompatEngineStatus {
  phase: OpenClawEnginePhase;
  version: string;
  message?: string;
  progress?: number;
}

export interface DshBootstrapSyncInput {
  providers: Record<string, LobsterProviderConfig>;
  modelAuthProxyUrl?: string | null;
  modelAuthProxySecret?: string | null;
  virtualAliases?: Record<string, { provider: string; model: string }>;
  mcpServers: LobsterMcpServerRecord[];
  skillsPolicy: {
    enabledIds?: string[] | null;
    disabledIds?: string[];
    extraDirs?: string[];
    skillsDir?: string;
  };
  agents?: DshHostAgentSpec[];
  imInstances?: Array<{
    platform: string;
    instanceId?: string;
    enabled?: boolean;
    agentId?: string;
    cwd?: string;
    config?: Record<string, unknown>;
  }>;
}

export type DshInitialConfigSyncFn = () => Promise<{ success?: boolean } | boolean | void>;

export interface DshBootstrapStartOptions {
  /**
   * Optional initial config sync (providers, MCP, skills, agents, IM channels)
   * executed before startup completes and before scheduled tasks begin firing.
   */
  syncInitialConfig?: DshInitialConfigSyncFn;
}

export interface DshBootstrapOptions {
  userDataDir: string;
  db: Database.Database;
  skillsDir: string;
  coworkStore: DshCoworkStorePort & {
    createSession?: (
      title: string,
      cwd: string,
      systemPrompt?: string,
      executionMode?: 'auto' | 'local' | 'sandbox',
      activeSkillIds?: string[],
      agentId?: string,
    ) => { id: string };
  };
  getDefaultCwd: (agentId?: string) => string;
  resolveModelSelection?: (
    sessionId: string,
    override?: string | null,
    thinkingLevelOverride?: string | null,
  ) => Promise<DshModelSelection | null> | DshModelSelection | null;
  resolveAllowedSkillIds?: (
    sessionId: string,
    agentId: string,
    optionSkillIds?: string[],
  ) => string[] | null;
  allowRules?: ApprovalAllowRulePort;
  toolProviders?: HostToolProvider[];
  instanceId?: string;
  ecosystemWindowTitle?: string;
  onStatusChange?: (status: DshCompatEngineStatus, hostStatus: DshHostStatus) => void;
  /** Optional runtime/bundle path override (useful in tests). */
  runtimePaths?: {
    runtimeDir: string;
    hostBundleDir: string;
    channelsBundleDir: string | null;
  };
  /** Optional Node/Electron executable override (useful in tests). */
  executablePath?: string;
  /** Pass through to DshHostManager when spawning plain Node in tests. */
  skipElectronRunAsNode?: boolean;
  /** Optional boot timeout override for DshHostManager. */
  bootTimeoutMs?: number;
}

/**
 * Run the pure-offline 6-step OpenClaw -> DSH v2 migrator before SQLite is
 * opened by the app store, ensuring clean snapshot, archival, and rollback.
 */
export function runPreBootLegacyOpenClawMigration(options: {
  userDataDir: string;
  sqlitePath: string;
}): LegacyOpenClawMigrationResult {
  try {
    const result = runLegacyOpenClawMigration({
      userDataDir: options.userDataDir,
      sqlitePath: options.sqlitePath,
    });
    console.log(`[MigrationV2] startup check completed: status=${result.status}`);
    if (result.error) {
      console.error('[MigrationV2] migration failed (rolled back):', result.error);
    }
    return result;
  } catch (error) {
    console.error('[MigrationV2] unexpected startup migration error:', error);
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function mapDshHostStatusToEngineStatus(hostStatus: DshHostStatus): DshCompatEngineStatus {
  const version = hostStatus.runtimeVersion ?? '0.2.2-rc.5';
  switch (hostStatus.phase) {
    case DshHostPhase.Ready:
      return { phase: OpenClawEnginePhase.Running, version };
    case DshHostPhase.Starting:
    case DshHostPhase.Restarting:
      return {
        phase: OpenClawEnginePhase.Starting,
        version,
        message: 'Starting DeepSeek Harness runtime...',
      };
    case DshHostPhase.Failed:
      return {
        phase: OpenClawEnginePhase.Error,
        version,
        message: hostStatus.lastError ?? 'DeepSeek Harness host failed to start',
      };
    case DshHostPhase.Stopped:
    default:
      return {
        phase: OpenClawEnginePhase.Ready,
        version,
      };
  }
}

function createSqliteKvStoragePort(db: Database.Database): {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
} {
  db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)');
  return {
    get(key: string): string | null {
      const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
        | { value?: string }
        | undefined;
      return typeof row?.value === 'string' ? row.value : null;
    },
    set(key: string, value: string): void {
      db.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(
        key,
        value,
        Date.now(),
      );
    },
    delete(key: string): void {
      db.prepare('DELETE FROM kv WHERE key = ?').run(key);
    },
  };
}

function createSafeStorageCipher(): {
  encrypt(plain: string): string;
  decrypt(encoded: string): string;
} {
  return {
    encrypt(plain: string): string {
      try {
        if (safeStorage.isEncryptionAvailable()) {
          return `safe:${safeStorage.encryptString(plain).toString('base64')}`;
        }
      } catch {
        // Fall through to base64 when OS keyring is unavailable.
      }
      return `b64:${Buffer.from(plain, 'utf8').toString('base64')}`;
    },
    decrypt(encoded: string): string {
      if (encoded.startsWith('safe:')) {
        return safeStorage.decryptString(Buffer.from(encoded.slice(5), 'base64'));
      }
      if (encoded.startsWith('b64:')) {
        return Buffer.from(encoded.slice(4), 'base64').toString('utf8');
      }
      return Buffer.from(encoded, 'base64').toString('utf8');
    },
  };
}

function webOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export class DshBootstrap {
  readonly runtimeDir: string;
  readonly hostBundleDir: string;
  readonly channelsBundleDir: string | null;
  readonly executablePath: string;
  readonly workspacesDir: string;

  readonly memoryService: LobsterMemoryService;
  readonly mcpOAuthManager: McpOAuthManager;
  readonly hostManager: DshHostManager;
  readonly channelsBridge: DshChannelsBridge;
  readonly runtimeAdapter: DshRuntimeAdapter;
  readonly subagentSessions: DshSubagentSessions;
  readonly scheduler: LobsterScheduler;

  private readonly options: DshBootstrapOptions;
  private readonly kvStorage: {
    get(key: string): string | null;
    set(key: string, value: string): void;
    delete(key: string): void;
  };
  private defaultPermissionPreset: DshPermissionPreset;
  private readonly bridgeWiring: {
    syncDynamicHostTools: () => Promise<Record<string, unknown>>;
    dispose: () => void;
  };
  private ecosystemWindow: BrowserWindow | null = null;
  private lastImInstances: DshChannelInstanceConfig[] | null = null;
  private startPromise: Promise<DshCompatEngineStatus> | null = null;
  private started = false;
  private startingInProgress = false;
  private initialConfigSynced = false;
  private initialSyncPromise: Promise<boolean> | null = null;

  constructor(options: DshBootstrapOptions) {
    this.options = options;
    const bundled = options.runtimePaths ?? resolveBundledDshPaths({
      isPackaged: app.isPackaged,
      appRootDir: app.getAppPath(),
      resourcesDir: process.resourcesPath,
    });
    this.runtimeDir = bundled.runtimeDir;
    this.hostBundleDir = bundled.hostBundleDir;
    this.channelsBundleDir = bundled.channelsBundleDir;
    this.executablePath = options.executablePath ?? getElectronNodeRuntimePath();
    this.workspacesDir = path.join(options.userDataDir, WORKSPACES_DIR_NAME);

    fs.mkdirSync(this.workspacesDir, { recursive: true });

    this.kvStorage = createSqliteKvStoragePort(options.db);
    const storedPreset = this.kvStorage.get(DSH_PERMISSION_PRESET_KV_KEY);
    this.defaultPermissionPreset =
      storedPreset === DshPermissionPreset.ReadOnly
      || storedPreset === DshPermissionPreset.WorkspaceWrite
      || storedPreset === DshPermissionPreset.FullAccess
        ? storedPreset
        : DEFAULT_DSH_PERMISSION_PRESET;

    this.memoryService = new LobsterMemoryService(this.workspacesDir);
    this.mcpOAuthManager = new McpOAuthManager({
      storage: this.kvStorage,
      cipher: createSafeStorageCipher(),
    });

    this.hostManager = new DshHostManager({
      userDataDir: options.userDataDir,
      runtimeDir: this.runtimeDir,
      hostBundleDir: this.hostBundleDir,
      channelsBundleDir: this.channelsBundleDir,
      skillsDir: options.skillsDir,
      executablePath: this.executablePath,
      instanceId: options.instanceId,
      skipElectronRunAsNode: options.skipElectronRunAsNode,
      bootTimeoutMs: options.bootTimeoutMs,
      nodeToolchainSource: () => this.resolveNodeToolchain(),
    });

    this.channelsBridge = new DshChannelsBridge({
      hostManager: this.hostManager,
    });

    this.subagentSessions = new DshSubagentSessions(options.db, this.hostManager,
      id => options.coworkStore.getSession(id, Number.MAX_SAFE_INTEGER)?.messages ?? []);
    this.hostManager.setSubagentBindingHandler((request) => {
      if (request.action === 'delete') {
        this.subagentSessions.deleteAgentBinding(request.childSessionId);
        return;
      }
      this.subagentSessions.recordAgentBinding({
        childSessionId: request.childSessionId,
        parentDshSessionId: request.parentDshSessionId,
        rootCoworkSessionId: request.rootCoworkSessionId,
        targetAgentId: request.targetAgentId,
      });
    });
    const persistedBindings = this.subagentSessions.listAgentBindings();
    if (persistedBindings.length > 0) {
      void this.hostManager.syncSubagentBindings(persistedBindings, { replace: true }).catch((): void => undefined);
    }
    this.runtimeAdapter = new DshRuntimeAdapter({
      subagentSessions: this.subagentSessions,
      hostManager: this.hostManager,
      store: options.coworkStore,
      resolveModelSelection: options.resolveModelSelection,
      resolveAllowedSkillIds: options.resolveAllowedSkillIds,
      resolveDefaultPermissionPreset: () => this.defaultPermissionPreset,
      onPermissionPresetChanged: async (preset, coworkSessionId) => {
        if (!coworkSessionId) {
          this.defaultPermissionPreset = preset;
          this.kvStorage.set(DSH_PERMISSION_PRESET_KV_KEY, preset);
        }
      },
    });

    const combinedAllowRules: ApprovalAllowRulePort = {
      isToolAllowedAlways: (params) => (
        this.runtimeAdapter.isToolAllowedInSession(params)
        || Boolean(options.allowRules?.isToolAllowedAlways(params))
      ),
    };

    this.scheduler = new LobsterScheduler({
      db: options.db,
      executor: (task, signal) => this.executeScheduledTask(task, signal),
    });

    this.scheduler.on('statusUpdate', (event: ScheduledTaskStatusEvent) => {
      this.broadcastScheduledTaskEvent(ScheduledTaskIpc.StatusUpdate, event);
    });
    this.scheduler.on('runUpdate', (event: ScheduledTaskRunEvent) => {
      this.broadcastScheduledTaskEvent(ScheduledTaskIpc.RunUpdate, event);
    });

    this.bridgeWiring = wireDshHostBridge({
      hostManager: this.hostManager,
      memoryService: this.memoryService,
      scheduler: this.scheduler,
      onScheduleMutated: () => {
        this.broadcastScheduledTaskEvent(ScheduledTaskIpc.Refresh);
      },
      allowRules: combinedAllowRules,
      toolProviders: options.toolProviders,
    });

    // Seed initial persisted permission preset into DshHostManager so it replays on boot.
    void this.hostManager.setPermissionPreset(this.defaultPermissionPreset).catch((): void => undefined);

    this.hostManager.on('phaseChange', (_phase, hostStatus: DshHostStatus) => {
      options.onStatusChange?.(this.mapEffectiveEngineStatus(hostStatus), hostStatus);
      if (hostStatus.phase === DshHostPhase.Ready && this.lastImInstances) {
        void this.channelsBridge.syncInstances(this.lastImInstances).catch((error) => {
          console.warn('[DshBootstrap] Failed to replay IM channels after host ready:', error);
        });
      }
    });

    this.hostManager.on('log', (entry: { stream: string; text: string }) => {
      const trimmed = entry.text.trim();
      if (!trimmed) return;
      if (entry.stream === 'stderr') {
        console.warn(`[DSH:stderr] ${trimmed}`);
      } else {
        console.debug(`[DSH:stdout] ${trimmed}`);
      }
    });
  }

  private mapEffectiveEngineStatus(hostStatus: DshHostStatus): DshCompatEngineStatus {
    const mapped = mapDshHostStatusToEngineStatus(hostStatus);
    if (this.startingInProgress && mapped.phase === OpenClawEnginePhase.Running) {
      return {
        phase: OpenClawEnginePhase.Starting,
        version: mapped.version,
        message: 'Synchronizing DeepSeek Harness configuration...',
      };
    }
    return mapped;
  }

  private emitStatusChange(): void {
    const hostStatus = this.hostManager.getStatus();
    this.options.onStatusChange?.(this.mapEffectiveEngineStatus(hostStatus), hostStatus);
  }

  getEngineStatus(): DshCompatEngineStatus {
    return this.mapEffectiveEngineStatus(this.hostManager.getStatus());
  }

  isInitialConfigSynced(): boolean {
    return this.initialConfigSynced;
  }

  /**
   * True once the DSH host is healthy, bootstrap startup has completed, and the
   * initial providers/MCP/skills/agents config sync has landed in the live host.
   */
  isReadyForTurns(): boolean {
    return this.started && !this.startingInProgress && this.hostManager.isReady() && this.initialConfigSynced;
  }

  resolveNodeToolchain(): DshNodeToolchain {
    const npmBinDir = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'npm', 'bin')
      : path.join(app.getAppPath(), 'node_modules', 'npm', 'bin');
    const hasNpm = fs.existsSync(npmBinDir);
    let nodeShimDir: string | null = null;
    try {
      nodeShimDir = ensureElectronNodeShim(this.executablePath, hasNpm ? npmBinDir : undefined);
    } catch (error) {
      console.warn('[DshBootstrap] Could not prepare Electron node shims for bundled pnpm:', error);
    }
    const resourcesDir = app.isPackaged
      ? process.resourcesPath
      : path.join(app.getAppPath(), 'resources');
    const gitBinDir = resolveDshBundledGitBinDir(
      resourcesDir,
      process.platform,
      fs.existsSync,
      path.join,
    );
    return {
      electronPath: this.executablePath,
      nodeShimDir,
      npmBinDir: hasNpm ? npmBinDir : null,
      gitBinDir,
    };
  }

  getPermissionPreset(sessionId?: string): {
    preset: DshPermissionPreset;
    defaultPreset: DshPermissionPreset;
  } {
    return {
      preset: this.runtimeAdapter.getEffectivePermissionPreset(sessionId),
      defaultPreset: this.defaultPermissionPreset,
    };
  }

  async setPermissionPreset(
    preset: DshPermissionPreset,
    sessionId?: string,
  ): Promise<{ preset: DshPermissionPreset; defaultPreset: DshPermissionPreset }> {
    if (
      preset !== DshPermissionPreset.ReadOnly
      && preset !== DshPermissionPreset.WorkspaceWrite
      && preset !== DshPermissionPreset.FullAccess
    ) {
      throw new Error(`Unsupported DSH permission preset: "${String(preset)}"`);
    }
    // Always persist as default when global (no sessionId) OR when user switches
    // from the composer/settings without specifying a session-only scope.
    if (!sessionId) {
      this.defaultPermissionPreset = preset;
      this.kvStorage.set(DSH_PERMISSION_PRESET_KV_KEY, preset);
    }
    await this.runtimeAdapter.setSessionPermissionPreset(preset, sessionId);
    return this.getPermissionPreset(sessionId);
  }

  private broadcastScheduledTaskEvent(channel: string, payload?: unknown): void {
    if (typeof BrowserWindow?.getAllWindows !== 'function') return;
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      if (payload === undefined) {
        win.webContents.send(channel);
      } else {
        win.webContents.send(channel, payload);
      }
    }
  }

  /**
   * Deduplicated startup: concurrent callers share a single in-flight boot
   * promise so orphan reaping, host startup, dynamic host tool registration,
   * optional initial config sync, and scheduler activation never run twice
   * concurrently. Failed boots clear the in-flight promise so retries succeed.
   */
  async start(options?: DshBootstrapStartOptions): Promise<DshCompatEngineStatus> {
    if (this.started && this.hostManager.isReady()) {
      if (options?.syncInitialConfig && !this.initialConfigSynced) {
        await this.runInitialConfigSync(options.syncInitialConfig);
      }
      return this.getEngineStatus();
    }

    if (this.startPromise) {
      await this.startPromise;
      if (options?.syncInitialConfig && !this.initialConfigSynced && this.hostManager.isReady()) {
        await this.runInitialConfigSync(options.syncInitialConfig);
      }
      return this.getEngineStatus();
    }

    const run = this.doStart(options).finally(() => {
      if (this.startPromise === run) {
        this.startPromise = null;
      }
    });
    this.startPromise = run;
    return run;
  }

  private async doStart(options?: DshBootstrapStartOptions): Promise<DshCompatEngineStatus> {
    this.startingInProgress = true;
    try {
      // One-shot idempotent backfill for users who completed v2 migration before
      // `cron_jobs` / run-history extraction landed. Runs concurrently with DSH boot
      // and returns instantaneously once `engine.migration.v2.cronBackfillCompleted` is set.
      const cronBackfillPromise = backfillLegacyScheduledTasksFromBackup({
        userDataDir: this.options.userDataDir,
        db: this.options.db,
      }).catch((error) => {
        console.warn('[MigrationV2] scheduled task backup backfill failed:', error);
        return { status: 'failed' as const, tasksImported: 0, runsImported: 0 };
      });

      await reapOrphanedDshRuntimes({ executablePath: this.executablePath }).catch(() => 0);
      await this.hostManager.start();
      await this.bridgeWiring.syncDynamicHostTools().catch((error) => {
        console.warn('[DshBootstrap] Failed to sync dynamic host tools:', error);
      });

      const backfill = await cronBackfillPromise;
      if (backfill.tasksImported > 0 || backfill.runsImported > 0) {
        console.log(
          `[MigrationV2] backfilled ${backfill.tasksImported} scheduled tasks and ${backfill.runsImported} run records from legacy backup`,
        );
        this.broadcastScheduledTaskEvent(ScheduledTaskIpc.Refresh);
      }

      if (options?.syncInitialConfig) {
        await this.runInitialConfigSync(options.syncInitialConfig);
      }

      this.scheduler.start();
      this.started = true;
      this.startingInProgress = false;
      this.emitStatusChange();
      return this.getEngineStatus();
    } catch (error) {
      this.startingInProgress = false;
      this.emitStatusChange();
      throw error;
    }
  }

  /**
   * Run (or join) the initial config sync against the live DSH host.
   * Deduplicates concurrent callers and allows retries when a previous attempt
   * failed or returned `{ success: false }`.
   */
  async runInitialConfigSync(
    syncFn: DshInitialConfigSyncFn,
    options: { force?: boolean } = {},
  ): Promise<boolean> {
    if (!options.force && this.initialConfigSynced && this.hostManager.isReady()) {
      return true;
    }
    if (!options.force && this.initialSyncPromise) {
      return this.initialSyncPromise;
    }
    const run = (async (): Promise<boolean> => {
      const outcome = await syncFn();
      const ok = outcome === undefined
        ? true
        : typeof outcome === 'boolean'
          ? outcome
          : typeof outcome === 'object' && outcome !== null
            ? outcome.success !== false
            : true;
      if (ok && this.hostManager.isReady()) {
        this.initialConfigSynced = true;
      }
      return ok;
    })().finally(() => {
      if (this.initialSyncPromise === run) {
        this.initialSyncPromise = null;
      }
    });
    this.initialSyncPromise = run;
    return run;
  }

  async restart(options?: DshBootstrapStartOptions): Promise<DshCompatEngineStatus> {
    this.startingInProgress = true;
    try {
      await this.hostManager.restart();
      await this.bridgeWiring.syncDynamicHostTools().catch((error) => {
        console.warn('[DshBootstrap] Failed to sync dynamic host tools after restart:', error);
      });
      if (options?.syncInitialConfig) {
        await this.runInitialConfigSync(options.syncInitialConfig, { force: true });
      }
      this.started = true;
      this.startingInProgress = false;
      this.emitStatusChange();
      return this.getEngineStatus();
    } catch (error) {
      this.startingInProgress = false;
      this.emitStatusChange();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    this.startingInProgress = false;
    this.initialConfigSynced = false;
    this.initialSyncPromise = null;
    this.scheduler.stop();
    this.closeEcosystemWindow();
    this.runtimeAdapter.stopAllSessions();
    this.bridgeWiring.dispose();
    try {
      await this.hostManager.stop();
    } finally {
      try {
        this.memoryService.close();
      } catch (error) {
        console.warn('[DshBootstrap] Failed to close memory service:', error);
      }
    }
  }

  async syncAllConfig(input: DshBootstrapSyncInput): Promise<{
    success: boolean;
    changed: boolean;
    needsReauthMcpIds: string[];
    error?: string;
  }> {
    try {
      const providersPayload = buildDshProvidersPayload({
        providers: input.providers,
        modelAuthProxyUrl: input.modelAuthProxyUrl,
        modelAuthProxySecret: input.modelAuthProxySecret,
        virtualAliases: input.virtualAliases,
      });
      await this.hostManager.syncProviders(providersPayload);

      const { servers, needsReauthIds } = await buildDshMcpServerSpecs(
        input.mcpServers,
        this.mcpOAuthManager,
      );
      await this.hostManager.syncMcpServers(servers);
      await this.hostManager.syncSkillsPolicy(input.skillsPolicy);
      if (input.agents) {
        await this.hostManager.syncAgents(input.agents);
      }

      if (input.imInstances) {
        if (this.hostManager.isReady() && this.channelsBundleDir) {
          const synced = await this.channelsBridge.syncInstances(input.imInstances);
          this.lastImInstances = input.imInstances
            .filter((entry) => !synced.skippedRetiredPlatforms.includes(entry.platform))
            .map((entry) => ({
              platform: entry.platform as DshChannelInstanceConfig['platform'],
              instanceId: entry.instanceId ?? 'default',
              enabled: entry.enabled !== false,
              agentId: entry.agentId,
              cwd: entry.cwd,
              config: entry.config ?? {},
            }));
        }
      }

      if (this.hostManager.isReady()) {
        this.initialConfigSynced = true;
      }

      return { success: true, changed: true, needsReauthMcpIds: needsReauthIds };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[DshBootstrap] syncAllConfig failed:', message);
      return { success: false, changed: false, needsReauthMcpIds: [], error: message };
    }
  }

  openEcosystemWindow(authenticatedUrl: string, routeHash?: string): void {
    const targetUrl = routeHash
      ? `${authenticatedUrl.split('#')[0]}#${routeHash.replace(/^#/, '')}`
      : authenticatedUrl;

    if (this.ecosystemWindow && !this.ecosystemWindow.isDestroyed()) {
      const currentOrigin = webOrigin(this.ecosystemWindow.webContents.getURL());
      const nextOrigin = webOrigin(targetUrl);
      if (currentOrigin !== nextOrigin || routeHash) {
        void this.ecosystemWindow.loadURL(targetUrl);
      }
      if (this.ecosystemWindow.isMinimized()) {
        this.ecosystemWindow.restore();
      }
      this.ecosystemWindow.focus();
      return;
    }

    this.ecosystemWindow = new BrowserWindow({
      width: 1320,
      height: 880,
      title: this.options.ecosystemWindowTitle ?? 'DeepSeek Harness Ecosystem',
      autoHideMenuBar: true,
      webPreferences: {
        partition: 'persist:dsh-ecosystem',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    this.ecosystemWindow.on('closed', () => {
      this.ecosystemWindow = null;
    });

    void this.ecosystemWindow.loadURL(targetUrl);
  }

  closeEcosystemWindow(): void {
    if (this.ecosystemWindow && !this.ecosystemWindow.isDestroyed()) {
      this.ecosystemWindow.close();
    }
    this.ecosystemWindow = null;
  }

  private async executeScheduledTask(
    task: ScheduledTask,
    signal: AbortSignal,
  ): Promise<LobsterSchedulerRunResult> {
    signal.throwIfAborted();
    if (!this.started || !this.hostManager.isReady()) {
      await this.start();
    }
    if (this.initialSyncPromise) {
      await this.initialSyncPromise;
    }
    signal.throwIfAborted();

    const promptText =
      task.payload.kind === 'agentTurn'
        ? task.payload.message
        : task.payload.text;

    const agentId = task.agentId || 'main';
    const cwd = this.options.getDefaultCwd(agentId);

    const sessionId = this.options.coworkStore.createSession?.(
      `[定时] ${task.name}`, cwd, undefined, 'auto', undefined, agentId,
    ).id;
    if (!sessionId) throw new Error('Unable to create a Cowork session for the scheduled task.');

    const stopped = await runScheduledTurn(this.runtimeAdapter, sessionId, agentId, promptText, signal);
    if (stopped || signal.aborted) {
      return { sessionId, stopped: true, deliveryStatus: RunDeliveryStatus.NotRequested };
    }

    const session = this.options.coworkStore.getSession(sessionId);
    const lastAssistant = [...(session?.messages ?? [])]
      .reverse()
      .find((m) => m.type === 'assistant' && m.content.trim().length > 0);
    const summary = lastAssistant?.content.trim() ?? '';

    let deliveryStatus: RunDeliveryStatus = RunDeliveryStatus.NotRequested;
    let deliveryError: string | null = null;
    if (
      task.delivery.mode === DeliveryMode.Announce
      && task.delivery.channel
      && task.delivery.to
      && this.channelsBundleDir
    ) {
      try {
        await this.channelsBridge.sendProactiveMessage({
          platform: task.delivery.channel,
          instanceId: task.delivery.accountId,
          chatId: task.delivery.to,
          text: summary || `[${task.name}] Completed.`,
        });
        deliveryStatus = RunDeliveryStatus.Delivered;
      } catch (error) {
        deliveryStatus = RunDeliveryStatus.NotDelivered;
        deliveryError = error instanceof Error ? error.message : String(error);
      }
    }

    return {
      sessionId,
      summary,
      deliveryStatus,
      deliveryError,
    };
  }
}
