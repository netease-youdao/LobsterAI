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
  IpcChannel as ScheduledTaskIpc,
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
import { BrowserAnnotationAssetStore } from '../browserAnnotationAssetStore';
import { getElectronNodeRuntimePath } from '../coworkUtil';
import { reapOrphanedDshRuntimes } from '../dshOrphanReaper';
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
import {
  buildDshMcpServerSpecs,
  buildDshProvidersPayload,
  type LobsterMcpServerRecord,
  type LobsterProviderConfig,
} from './dshProviderSync';
import { executeDshScheduledTask } from './dshScheduledTurn';
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
      modelOverride?: string,
      options?: { scheduledTaskId?: string | null },
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

  constructor(options: DshBootstrapOptions) {
    this.options = options;
    const bundled = resolveBundledDshPaths({
      isPackaged: app.isPackaged,
      appRootDir: app.getAppPath(),
      resourcesDir: process.resourcesPath,
    });
    this.runtimeDir = bundled.runtimeDir;
    this.hostBundleDir = bundled.hostBundleDir;
    this.channelsBundleDir = bundled.channelsBundleDir;
    this.executablePath = getElectronNodeRuntimePath();
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
    const browserAnnotationAssetStore = new BrowserAnnotationAssetStore(
      path.join(options.userDataDir, 'browser-annotation-assets'),
    );
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
      readBrowserAnnotationAsset: (identity) => {
        try {
          return browserAnnotationAssetStore.read(identity);
        } catch {
          return null;
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
      options.onStatusChange?.(mapDshHostStatusToEngineStatus(hostStatus), hostStatus);
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

  getEngineStatus(): DshCompatEngineStatus {
    return mapDshHostStatusToEngineStatus(this.hostManager.getStatus());
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

  async start(): Promise<DshCompatEngineStatus> {
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

    this.scheduler.start();
    return this.getEngineStatus();
  }

  async restart(): Promise<DshCompatEngineStatus> {
    await this.hostManager.restart();
    await this.bridgeWiring.syncDynamicHostTools().catch((error) => {
      console.warn('[DshBootstrap] Failed to sync dynamic host tools after restart:', error);
    });
    return this.getEngineStatus();
  }

  async stop(): Promise<void> {
    this.scheduler.stop();
    this.closeEcosystemWindow();
    this.runtimeAdapter.stopAllSessions();
    this.bridgeWiring.dispose();
    await this.hostManager.stop();
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
      await this.bridgeWiring.syncDynamicHostTools();
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
    return executeDshScheduledTask(
      {
        hostManager: this.hostManager,
        runtimeAdapter: this.runtimeAdapter,
        coworkStore: this.options.coworkStore,
        getDefaultCwd: this.options.getDefaultCwd,
        channelsBridge: this.channelsBridge,
        channelsBundleDir: this.channelsBundleDir,
      },
      task,
      signal,
    );
  }
}
