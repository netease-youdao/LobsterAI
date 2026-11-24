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
// - `DshChannelsBridge` (retained IM platforms via `@lobsterai/dsh-channels`)
// - Isolated Dual-Track DSH Ecosystem Web View (`BrowserWindow`)

import type Database from 'better-sqlite3';
import { app, BrowserWindow, safeStorage, session } from 'electron';
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
  DSH_PERMISSION_PRESET_KV_KEY,
  DSH_PROFILE_DIR_NAME,
  DshHostPhase,
  type DshPermissionPreset,
  parseDshPermissionPreset,
  WORKSPACES_DIR_NAME,
} from '../../../shared/dshEngine/hostConstants';
import { McpIpcChannel } from '../../../shared/mcp/constants';
import { OpenClawEnginePhase } from '../../../shared/openclawEngine/constants';
import {
  type DshChannelInstanceConfig,
  DshChannelsBridge,
  filterRetainedChannelInstances,
} from '../../im/dshChannelsBridge';
import {
  decodePlainOrBase64McpOAuthToken,
  type McpOAuthFetch,
  McpOAuthManager,
  McpOAuthRefreshScheduler,
} from '../../mcp/mcpOAuthManager';
import { LobsterMemoryService } from '../../memory/lobsterMemoryService';
import {
  backfillLegacyDreamDiariesFromBackup,
  backfillLegacyMcpOAuthTokensFromBackup,
  backfillLegacyScheduledTasksFromBackup,
  backfillLegacyTavilyFromBackup,
  backfillLegacyUserMemories,
  cleanupLegacyOpenClawDisposableCaches,
  type LegacyDreamDiaryBackfillResult,
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
import {
  ensureElectronNodeShim,
  getCachedUserShellPath,
  getElectronNodeRuntimePath,
  getFallbackCommonShellPaths,
  resolveUserShellPathAsync,
  seedUserShellPathCache,
} from '../coworkUtil';
import {
  clearDshCleanShutdownMarker,
  reapOrphanedDshRuntimes,
  writeDshCleanShutdownMarker,
} from '../dshOrphanReaper';
import { resolveDshBundledGitBinDir } from '../dshRuntime';
import { appendPythonRuntimeToEnv } from '../pythonRuntime';
import {
  type ApprovalAllowRulePort,
  type HostToolProvider,
  wireDshHostBridge,
} from './dshHostBridgeWiring';
import {
  type DshBridgeWebSearchHandler,
  type DshChildEnvAdditions,
  type DshHostAgentSpec,
  DshHostManager,
  type DshHostStatus,
  type DshHostWebAccessPolicy,
  resolveBundledDshPaths,
} from './dshHostManager';
import { resolveInitialDshPermissionPreset } from './dshPermissionPresetStorage';
import type { DshNodeToolchain } from './dshProfileManager';
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
  memoryEnabled?: boolean;
  webAccessPolicy?: DshHostWebAccessPolicy;
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

export interface DshBootstrapSyncOptions {
  /**
   * Startup fast path: await only turn-critical in-memory syncs and local MCP
   * registration, then run remote SSE MCP handshakes, OAuth MCP token refresh,
   * and IM channel connections asynchronously in the background.
   */
  deferExternalSync?: boolean;
  /** Skip `syncDynamicHostTools()` when the caller just ran it immediately prior. */
  skipHostToolsSync?: boolean;
}

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
      modelOverride?: string,
      options?: { scheduledTaskId?: string | null },
    ) => { id: string };
  };
  getDefaultCwd: (agentId?: string) => string;
  getMemoryEnabled?: () => boolean;
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
  webSearchHandler?: DshBridgeWebSearchHandler;
  instanceId?: string;
  ecosystemWindowTitle?: string;
  mcpOAuthFetcher?: McpOAuthFetch;
  onMcpOAuthNeedsReauth?: (serverIds: string[]) => void;
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

export interface SingleFlightAsyncTracker<T> {
  getInFlight(): Promise<T> | null;
  run(factory: () => Promise<T>, options?: { force?: boolean }): Promise<T>;
}

/**
 * Tracks a single in-flight async operation (such as main-process DSH engine
 * bootstrap/retry), clearing the tracked reference as soon as the exact
 * derived `.finally()` promise settles (fulfilled or rejected).
 *
 * Passing `force: true` bypasses any prior in-flight promise and replaces it
 * with the newer attempt so concurrent waiters join the retry and an earlier
 * attempt settling later never clears the newer reference.
 */
export function createSingleFlightAsyncTracker<T>(): SingleFlightAsyncTracker<T> {
  let activePromise: Promise<T> | null = null;
  return {
    getInFlight: () => activePromise,
    run(factory: () => Promise<T>, options?: { force?: boolean }): Promise<T> {
      if (!options?.force && activePromise) {
        return activePromise;
      }
      let inner: Promise<T>;
      try {
        inner = factory();
      } catch (error) {
        return Promise.reject(error);
      }
      const pending = inner.finally(() => {
        if (activePromise === pending) {
          activePromise = null;
        }
      });
      activePromise = pending;
      return pending;
    },
  };
}

/**
 * Run the pure-offline 6-step OpenClaw -> DSH v2 migrator before SQLite is
 * opened by the app store, ensuring clean snapshot, archival, and rollback.
 */
export { cleanupLegacyOpenClawDisposableCaches };

export function runPreBootLegacyOpenClawMigration(options: {
  userDataDir: string;
  sqlitePath: string;
}): LegacyOpenClawMigrationResult {
  try {
    const result = runLegacyOpenClawMigration({
      userDataDir: options.userDataDir,
      sqlitePath: options.sqlitePath,
      deferDisposableCacheCleanup: true,
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
      return decodePlainOrBase64McpOAuthToken(encoded);
    },
  };
}

function resolveBundledNpmBinDir(): string | undefined {
  const candidate = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'npm', 'bin')
    : path.join(app.getAppPath(), 'node_modules', 'npm', 'bin');
  return fs.existsSync(candidate) ? candidate : undefined;
}

const DSH_CACHED_SHELL_PATH_KV_KEY = 'dsh_cached_shell_path_v1';
const DSH_CLEAN_SHUTDOWN_MARKER_FILENAME = 'clean-shutdown.json';
const FIRST_LAUNCH_SHELL_PATH_TIMEOUT_MS = 1_500;

function resolveDshChildEnvAdditions(
  executablePath: string,
): DshChildEnvAdditions {
  const npmBinDir = resolveBundledNpmBinDir();
  const nodeShimDir = ensureElectronNodeShim(executablePath, npmBinDir);
  const prependPathDirs: string[] = [];
  const appendPathDirs: string[] = [];
  const extraEnv: Record<string, string | undefined> = {};

  if (process.platform !== 'win32' && app.isPackaged) {
    // Never run `execSync(shell -lc ...)` on the Electron main thread during boot;
    // use the KV-seeded / async-resolved shell PATH with safe POSIX fallbacks.
    const shellPath = getCachedUserShellPath();
    if (shellPath) {
      appendPathDirs.push(...shellPath.split(path.delimiter).filter(Boolean));
    } else {
      appendPathDirs.push(...getFallbackCommonShellPaths());
    }
  }

  try {
    const pyEnv: Record<string, string | undefined> = { PATH: '' };
    appendPythonRuntimeToEnv(pyEnv);
    const pyPathDirs = (pyEnv.PATH || '').split(path.delimiter).filter(Boolean);
    if (pyPathDirs.length > 0) {
      // On Windows, keep bundled Python ahead of Microsoft Store WindowsApps stubs.
      prependPathDirs.push(...pyPathDirs);
    }
    for (const [key, value] of Object.entries(pyEnv)) {
      if (key.toLowerCase() === 'path' || value === undefined) continue;
      extraEnv[key] = value;
    }
  } catch (error) {
    console.warn('[DshBootstrap] Failed to resolve bundled Python runtime env:', error);
  }

  return {
    nodeShimDir,
    npmBinDir,
    prependPathDirs,
    appendPathDirs,
    extraEnv,
  };
}

function createProxyAwareOAuthFetcher(): McpOAuthFetch {
  return (url, init) => {
    if (session?.defaultSession && typeof session.defaultSession.fetch === 'function') {
      return session.defaultSession.fetch(url, init);
    }
    return fetch(url, init);
  };
}

function webOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function resolveDshNodeToolchain(electronPath: string): DshNodeToolchain {
  const npmBinDir = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'npm', 'bin')
    : path.join(app.getAppPath(), 'node_modules', 'npm', 'bin');
  const hasNpm = fs.existsSync(npmBinDir);
  let nodeShimDir: string | null = null;
  try {
    nodeShimDir = ensureElectronNodeShim(electronPath, hasNpm ? npmBinDir : undefined);
  } catch (error) {
    console.warn('[DshBootstrap] Failed to prepare Electron Node shims for DSH pnpm:', error);
  }
  const gitBinDir = resolveDshBundledGitBinDir(
    app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources'),
    process.platform,
    fs.existsSync,
    path.join,
  );
  return {
    electronPath,
    nodeShimDir,
    npmBinDir: hasNpm ? npmBinDir : null,
    gitBinDir,
  };
}

export class DshBootstrap {
  readonly runtimeDir: string;
  readonly hostBundleDir: string;
  readonly channelsBundleDir: string | null;
  readonly executablePath: string;
  readonly nodeToolchain: DshNodeToolchain;
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
  private dreamDiaryBackfillPromise: Promise<LegacyDreamDiaryBackfillResult> | null = null;
  private lastMcpServerRecords: LobsterMcpServerRecord[] = [];
  private lastNeedsReauthMcpKey = '';
  private readonly mcpOAuthRefreshScheduler: McpOAuthRefreshScheduler;
  private readonly cleanShutdownMarkerPath: string;
  private initialShellPathProbe: Promise<string | null> | null = null;

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
    this.nodeToolchain = resolveDshNodeToolchain(this.executablePath);
    this.workspacesDir = path.join(options.userDataDir, WORKSPACES_DIR_NAME);

    fs.mkdirSync(this.workspacesDir, { recursive: true });

    this.kvStorage = createSqliteKvStoragePort(options.db);
    this.defaultPermissionPreset = resolveInitialDshPermissionPreset(options.db, this.kvStorage);
    this.cleanShutdownMarkerPath = path.join(
      options.userDataDir,
      DSH_PROFILE_DIR_NAME,
      DSH_CLEAN_SHUTDOWN_MARKER_FILENAME,
    );

    if (process.platform !== 'win32' && app.isPackaged) {
      const persistedShellPath = this.kvStorage.get(DSH_CACHED_SHELL_PATH_KV_KEY);
      if (persistedShellPath) {
        seedUserShellPathCache(persistedShellPath);
        // Refresh silently in background so next launch picks up any PATH updates.
        void resolveUserShellPathAsync({ forceRefresh: true }).then((fresh) => {
          if (fresh && fresh !== persistedShellPath) {
            try {
              this.kvStorage.set(DSH_CACHED_SHELL_PATH_KV_KEY, fresh);
            } catch {
              // DB may already be closed during rapid quit.
            }
          }
        }).catch((): void => undefined);
      } else {
        this.initialShellPathProbe = resolveUserShellPathAsync({
          timeoutMs: FIRST_LAUNCH_SHELL_PATH_TIMEOUT_MS,
        }).then((resolved) => {
          if (resolved) {
            try {
              this.kvStorage.set(DSH_CACHED_SHELL_PATH_KV_KEY, resolved);
            } catch {
              // DB may already be closed during rapid quit.
            }
          }
          return resolved;
        }).catch((): string | null => null);
      }
    }

    this.memoryService = new LobsterMemoryService(this.workspacesDir);
    this.mcpOAuthManager = new McpOAuthManager({
      storage: this.kvStorage,
      cipher: createSafeStorageCipher(),
      fetcher: options.mcpOAuthFetcher ?? createProxyAwareOAuthFetcher(),
    });
    this.mcpOAuthRefreshScheduler = new McpOAuthRefreshScheduler({
      oauthManager: this.mcpOAuthManager,
      onRefreshDue: async (dueServerIds) => {
        console.log(
          `[DshBootstrap] Proactive MCP OAuth refresh triggered for ${dueServerIds.length} server(s): ${dueServerIds.join(', ')}`,
        );
        const result = await this.syncMcpServersOnly('mcp-oauth-proactive-refresh');
        return { needsReauthIds: result.needsReauthIds };
      },
    });

    this.hostManager = new DshHostManager({
      userDataDir: options.userDataDir,
      runtimeDir: this.runtimeDir,
      hostBundleDir: this.hostBundleDir,
      channelsBundleDir: this.channelsBundleDir,
      skillsDir: options.skillsDir,
      executablePath: this.executablePath,
      resolveChildEnvAdditions: () => resolveDshChildEnvAdditions(this.executablePath),
      nodeToolchain: this.nodeToolchain,
      instanceId: options.instanceId,
      skipElectronRunAsNode: options.skipElectronRunAsNode,
      bootTimeoutMs: options.bootTimeoutMs,
      nodeToolchainSource: () => this.resolveNodeToolchain(),
    });
    if (options.webSearchHandler) {
      this.hostManager.setWebSearchHandler(options.webSearchHandler);
    }

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
      isMemoryEnabled: options.getMemoryEnabled,
      scheduler: this.scheduler,
      onScheduleMutated: () => {
        this.broadcastScheduledTaskEvent(ScheduledTaskIpc.Refresh);
      },
      allowRules: combinedAllowRules,
      toolProviders: options.toolProviders,
    });

    // Seed initial persisted permission preset & memory policy into DshHostManager so they replay on boot.
    void this.hostManager.setPermissionPreset(this.defaultPermissionPreset).catch((): void => undefined);
    if (options.getMemoryEnabled) {
      void this.hostManager
        .syncMemoryPolicy({ enabled: options.getMemoryEnabled() !== false })
        .catch((): void => undefined);
    }

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

  isBootstrapInProgress(): boolean {
    return this.startingInProgress || this.startPromise !== null;
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
    const validated = parseDshPermissionPreset(preset);
    if (!validated) {
      throw new Error(`Unsupported DSH permission preset: "${String(preset)}"`);
    }
    const normalizedSessionId = typeof sessionId === 'string' && sessionId.trim()
      ? sessionId.trim()
      : undefined;
    // Update the persisted global default ONLY when switching without a session scope
    // (home / new-session composer). Per-session switches stay isolated to that session.
    if (!normalizedSessionId) {
      this.defaultPermissionPreset = validated;
      this.kvStorage.set(DSH_PERMISSION_PRESET_KV_KEY, validated);
    }
    await this.runtimeAdapter.setSessionPermissionPreset(validated, normalizedSessionId);
    return this.getPermissionPreset(normalizedSessionId);
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
   * Ensure one-shot idempotent backfill of legacy `DREAMS.md` files from
   * `legacy-openclaw-state.tar.gz` has completed before reading diaries.
   */
  ensureDreamDiaryBackfilled(): Promise<LegacyDreamDiaryBackfillResult> {
    if (!this.dreamDiaryBackfillPromise) {
      this.dreamDiaryBackfillPromise = backfillLegacyDreamDiariesFromBackup({
        userDataDir: this.options.userDataDir,
        db: this.options.db,
      })
        .then((result) => {
          if (result.status === 'failed') {
            this.dreamDiaryBackfillPromise = null;
          }
          return result;
        })
        .catch((error) => {
          console.warn('[MigrationV2] dream diary backup backfill failed:', error);
          this.dreamDiaryBackfillPromise = null;
          return {
            status: 'failed' as const,
            diariesRestored: 0,
            error: error instanceof Error ? error.message : String(error),
          };
        });
    }
    return this.dreamDiaryBackfillPromise;
  }

  private broadcastMcpChanged(): void {
    if (typeof BrowserWindow?.getAllWindows !== 'function') return;
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send(McpIpcChannel.Changed);
      } catch {
        // ignore destroyed windows
      }
    }
  }

  private notifyNeedsReauthMcpIds(needsReauthIds: string[], reason: string): void {
    const nextKey = [...needsReauthIds].sort().join(',');
    if (needsReauthIds.length > 0) {
      console.warn(
        `[DshBootstrap] MCP OAuth re-authorization required (${reason}) for ${needsReauthIds.length} server(s): ${needsReauthIds.join(', ')}`,
      );
    }
    if (nextKey !== this.lastNeedsReauthMcpKey) {
      this.lastNeedsReauthMcpKey = nextKey;
      if (needsReauthIds.length > 0) {
        this.options.onMcpOAuthNeedsReauth?.(needsReauthIds);
      }
      this.broadcastMcpChanged();
    }
  }

  async syncMcpServersOnly(reason: string): Promise<{
    success: boolean;
    needsReauthIds: string[];
    error?: string;
  }> {
    try {
      const { servers, needsReauthIds } = await buildDshMcpServerSpecs(
        this.lastMcpServerRecords,
        this.mcpOAuthManager,
      );
      const mcpSyncResult = await this.hostManager.syncMcpServers(servers);
      if (mcpSyncResult && typeof mcpSyncResult === 'object') {
        if (mcpSyncResult.available === false) {
          console.warn(`[DshBootstrap] syncMcpServers (${reason}) reported mcpManager unavailable`);
        }
        const mcpErrors = Array.isArray(mcpSyncResult.errors) ? mcpSyncResult.errors : [];
        if (mcpErrors.length > 0) {
          console.warn(
            `[DshBootstrap] syncMcpServers (${reason}) reported ${mcpErrors.length} error(s): ${mcpErrors.join('; ')}`,
          );
        }
      }
      this.mcpOAuthRefreshScheduler.updateTrackedServers(
        this.lastMcpServerRecords.filter((s) => s.enabled && s.oauthEnabled).map((s) => s.id),
        needsReauthIds,
      );
      this.notifyNeedsReauthMcpIds(needsReauthIds, reason);
      return { success: true, needsReauthIds };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[DshBootstrap] syncMcpServersOnly (${reason}) failed:`, message);
      return { success: false, needsReauthIds: [], error: message };
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
      // One-shot idempotent backfills for users who completed v2 migration before
      // `cron_jobs`, `DREAMS.md`, Tavily, or `mcp_oauth_stores` extraction landed.
      // All run concurrently with DSH boot and return instantaneously once completed.
      const cronBackfillPromise = backfillLegacyScheduledTasksFromBackup({
        userDataDir: this.options.userDataDir,
        db: this.options.db,
      }).catch((error) => {
        console.warn('[MigrationV2] scheduled task backup backfill failed:', error);
        return { status: 'failed' as const, tasksImported: 0, runsImported: 0 };
      });
      const dreamDiaryBackfillPromise = this.ensureDreamDiaryBackfilled();
      const tavilyBackfillPromise = backfillLegacyTavilyFromBackup({
        userDataDir: this.options.userDataDir,
        db: this.options.db,
      }).catch((error) => {
        console.warn('[MigrationV2] legacy Tavily MCP backfill failed:', error);
        return { status: 'failed' as const, migrated: false };
      });
      const mcpOAuthBackfillPromise = backfillLegacyMcpOAuthTokensFromBackup({
        userDataDir: this.options.userDataDir,
        db: this.options.db,
      }).catch((error) => {
        console.warn('[MigrationV2] MCP OAuth backup backfill failed:', error);
        return { status: 'failed' as const, tokensMigrated: 0, migratedServerIds: [] as string[] };
      });

      // One-shot idempotent backfill for already-migrated v2 DBs so SQLite-only
      // active `user_memories` rows are recovered into `workspaces/main/MEMORY.md`.
      try {
        const memoryBackfill = backfillLegacyUserMemories({
          userDataDir: this.options.userDataDir,
          db: this.options.db,
          memoryService: this.memoryService,
        });
        if (memoryBackfill.memoriesImported > 0) {
          console.log(
            `[MigrationV2] backfilled ${memoryBackfill.memoriesImported} legacy SQLite user_memories into MEMORY.md`,
          );
        }
      } catch (error) {
        console.warn('[MigrationV2] legacy user_memories backfill failed:', error);
      }

      await Promise.all([
        reapOrphanedDshRuntimes({
          executablePath: this.executablePath,
          cleanShutdownMarkerPath: this.cleanShutdownMarkerPath,
        }).catch((): number => 0),
        this.initialShellPathProbe?.catch((): string | null => null) ?? Promise.resolve(null),
      ]);
      this.initialShellPathProbe = null;
      if (typeof clearDshCleanShutdownMarker === 'function') {
        clearDshCleanShutdownMarker(this.cleanShutdownMarkerPath);
      }
      await this.hostManager.start();
      await this.bridgeWiring.syncDynamicHostTools().catch((error) => {
        console.warn('[DshBootstrap] Failed to sync dynamic host tools:', error);
      });

      // Legacy backup backfills can extract large tar archives (multi-second I/O);
      // process their results in the background so startup and turns are never blocked.
      void Promise.all([
        cronBackfillPromise,
        dreamDiaryBackfillPromise,
        tavilyBackfillPromise,
        mcpOAuthBackfillPromise,
      ]).then(async ([backfill, dreamDiaryBackfill, tavilyBackfill, oauthBackfill]) => {
        if (backfill.tasksImported > 0 || backfill.runsImported > 0) {
          console.log(
            `[MigrationV2] backfilled ${backfill.tasksImported} scheduled tasks and ${backfill.runsImported} run records from legacy backup`,
          );
          this.broadcastScheduledTaskEvent(ScheduledTaskIpc.Refresh);
        }
        if (dreamDiaryBackfill.diariesRestored > 0) {
          console.log(
            `[MigrationV2] backfilled ${dreamDiaryBackfill.diariesRestored} legacy dream diary file(s) from backup`,
          );
        }
        if (tavilyBackfill.migrated) {
          console.log('[MigrationV2] backfilled legacy Tavily plugin config into SQLite mcp_servers');
          this.broadcastMcpChanged();
        }
        if (oauthBackfill.tokensMigrated > 0) {
          console.log(
            `[MigrationV2] backfilled ${oauthBackfill.tokensMigrated} MCP OAuth token(s) from legacy backup`,
          );
          if (this.lastMcpServerRecords.length > 0 && this.hostManager.isReady()) {
            await this.syncMcpServersOnly('mcp-oauth-legacy-backfill');
          }
          this.broadcastMcpChanged();
        }
      }).catch((error) => {
        console.warn('[MigrationV2] background backfill finalization failed:', error);
      });

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
    this.mcpOAuthRefreshScheduler.stop();
    this.scheduler.stop();
    this.closeEcosystemWindow();
    this.runtimeAdapter.stopAllSessions();
    this.bridgeWiring.dispose();
    try {
      await this.hostManager.stop();
      if (typeof writeDshCleanShutdownMarker === 'function') {
        writeDshCleanShutdownMarker(this.cleanShutdownMarkerPath, this.executablePath);
      }
    } finally {
      try {
        this.memoryService.close();
      } catch (error) {
        console.warn('[DshBootstrap] Failed to close memory service:', error);
      }
    }
  }

  async syncAllConfig(
    input: DshBootstrapSyncInput,
    options: DshBootstrapSyncOptions = {},
  ): Promise<{
    success: boolean;
    changed: boolean;
    needsReauthMcpIds: string[];
    error?: string;
  }> {
    try {
      const deferExternalSync = options.deferExternalSync === true;
      const providersPayload = buildDshProvidersPayload({
        providers: input.providers,
        modelAuthProxyUrl: input.modelAuthProxyUrl,
        modelAuthProxySecret: input.modelAuthProxySecret,
        virtualAliases: input.virtualAliases,
      });

      this.lastMcpServerRecords = input.mcpServers;

      const coreSyncTasks: Array<Promise<unknown>> = [
        this.hostManager.syncProviders(providersPayload),
        this.hostManager.syncSkillsPolicy(input.skillsPolicy),
      ];
      if (typeof input.memoryEnabled === 'boolean') {
        coreSyncTasks.push(this.hostManager.syncMemoryPolicy({ enabled: input.memoryEnabled }));
      }
      if (input.webAccessPolicy) {
        coreSyncTasks.push(this.hostManager.syncWebAccessPolicy(input.webAccessPolicy));
      }
      if (!options.skipHostToolsSync) {
        coreSyncTasks.push(this.bridgeWiring.syncDynamicHostTools());
      }
      if (input.agents) {
        coreSyncTasks.push(this.hostManager.syncAgents(input.agents));
      }

      let needsReauthIds: string[] = [];

      if (deferExternalSync) {
        const hasOAuthMcp = input.mcpServers.some((s) => s.enabled !== false && s.oauthEnabled);
        const nonOAuthRecords = hasOAuthMcp
          ? input.mcpServers.filter((s) => !s.oauthEnabled)
          : input.mcpServers;
        const { servers: immediateMcpServers } = await buildDshMcpServerSpecs(
          nonOAuthRecords,
          this.mcpOAuthManager,
        );
        coreSyncTasks.push(
          this.hostManager.syncMcpServers(immediateMcpServers, { deferSseWait: true }).then((mcpSyncResult) => {
            if (mcpSyncResult && typeof mcpSyncResult === 'object') {
              if (mcpSyncResult.available === false) {
                console.warn('[DshBootstrap] syncMcpServers reported mcpManager unavailable');
              }
              const mcpErrors = Array.isArray(mcpSyncResult.errors) ? mcpSyncResult.errors : [];
              if (mcpErrors.length > 0) {
                console.warn(`[DshBootstrap] syncMcpServers reported ${mcpErrors.length} error(s): ${mcpErrors.join('; ')}`);
              }
            }
          }),
        );

        await Promise.all(coreSyncTasks);

        if (this.hostManager.isReady()) {
          this.initialConfigSynced = true;
        }

        // Phase 2 (non-blocking): OAuth MCP token resolution + IM channel connections.
        if (hasOAuthMcp) {
          void this.syncMcpServersOnly('startup-oauth-mcp');
        } else {
          this.mcpOAuthRefreshScheduler.updateTrackedServers([], []);
          this.notifyNeedsReauthMcpIds([], 'syncAllConfig');
        }

        if (input.imInstances && this.hostManager.isReady() && this.channelsBundleDir) {
          const { retained } = filterRetainedChannelInstances(input.imInstances);
          this.lastImInstances = retained;
          if (retained.length > 0) {
            void this.channelsBridge.syncInstances(retained).catch((error) => {
              console.warn('[DshBootstrap] Background IM channel sync failed:', error);
            });
          }
        }

        return { success: true, changed: true, needsReauthMcpIds: [] };
      }

      const mcpSpecResult = await buildDshMcpServerSpecs(
        input.mcpServers,
        this.mcpOAuthManager,
      );
      needsReauthIds = mcpSpecResult.needsReauthIds;
      coreSyncTasks.push(
        this.hostManager.syncMcpServers(mcpSpecResult.servers).then((mcpSyncResult) => {
          if (mcpSyncResult && typeof mcpSyncResult === 'object') {
            if (mcpSyncResult.available === false) {
              console.warn('[DshBootstrap] syncMcpServers reported mcpManager unavailable');
            }
            const mcpErrors = Array.isArray(mcpSyncResult.errors) ? mcpSyncResult.errors : [];
            if (mcpErrors.length > 0) {
              console.warn(`[DshBootstrap] syncMcpServers reported ${mcpErrors.length} error(s): ${mcpErrors.join('; ')}`);
            }
          }
        }),
      );

      await Promise.all(coreSyncTasks);

      this.mcpOAuthRefreshScheduler.updateTrackedServers(
        input.mcpServers.filter((s) => s.enabled && s.oauthEnabled).map((s) => s.id),
        needsReauthIds,
      );
      this.notifyNeedsReauthMcpIds(needsReauthIds, 'syncAllConfig');

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
