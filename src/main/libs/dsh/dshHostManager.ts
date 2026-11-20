// Primary DeepSeek Harness (DSH) Host Process & Local Callback Bridge Manager.
//
// Owns:
// 1. Preparing LobsterAI's isolated App-Owned Profile (`<userData>/dsh-profile`)
//    and `dsh` CLI shim.
// 2. Running Electron Main's authenticated local loopback bridge for host tools
//    (Memory, Office, Browser, Credentials, Computer Use, Media, Decision),
//    tool pre-execution approval evaluation, and IM channel callbacks.
// 3. Spawning, supervising, authenticating (`DshTypertClient`), and auto-replaying
//    synced state (providers, MCP servers, skills policy, host tools) on restarts.
//
// Zero Electron imports — paths and executable are injected via options so this
// module stays directly testable under Node Vitest.

import { type ChildProcess, spawn } from 'child_process';
import { randomBytes, timingSafeEqual } from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

import {
  DEFAULT_DSH_PERMISSION_PRESET,
  DSH_PROFILE_DIR_NAME,
  DSH_PROFILE_NAME,
  DshHostBundleEnvVar,
  DshHostPhase,
  DshOpsAction,
  DshPermissionPreset,
  DshSearchPolicy,
  WORKSPACES_DIR_NAME,
} from '../../../shared/dshEngine/hostConstants';
import { DSH_NODE_EXEC_ARGV } from '../dshRuntime';
import {
  ensureAppOwnedProfile,
  resolveLobsterDshProfileDir,
  writeDshCliShim,
} from './dshProfileManager';
import { DshTypertClient } from './dshTypertClient';

export interface DshHostProviderModelSpec {
  id: string;
  name?: string;
  api?: string;
  baseURL?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: Array<'text' | 'image'>;
  supportsImage?: boolean;
  reasoning?: boolean;
  compat?: Record<string, unknown>;
}

export interface DshHostProviderSpec {
  id: string;
  displayName?: string;
  api: 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generative-ai';
  baseURL: string;
  apiKey?: string;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  models: DshHostProviderModelSpec[];
}

export interface DshHostMcpServerSpec {
  name: string;
  enabled?: boolean;
  transport: 'stdio' | 'streamable-http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  startupTimeoutMs?: number;
  toolCallTimeoutMs?: number;
}

export interface DshHostToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  timeoutMs?: number;
  deferLoading?: boolean;
  isConcurrencySafe?: boolean;
}

export interface DshHostSkillsPolicy {
  enabledIds?: string[] | null;
  disabledIds?: string[];
  extraDirs?: string[];
  skillsDir?: string;
}

export interface DshHostSessionContext {
  sessionId: string;
  agentId?: string;
  coworkSessionId?: string;
  traceId?: string;
  workspaceDir?: string;
  allowedSkillIds?: string[] | null;
  customSystemPrompt?: string;
  executionMode?: string;
  permissionPreset?: DshPermissionPreset;
  unbind?: boolean;
}

export interface DshBridgeToolExecuteRequest {
  signal?: AbortSignal;
  toolName: string;
  args: Record<string, unknown>;
  callId?: string;
  sessionId?: string;
  agentId: string;
  coworkSessionId?: string;
}

export type DshBridgeToolHandler = (
  request: DshBridgeToolExecuteRequest,
) => Promise<unknown> | unknown;

export interface DshBridgeApprovalEvaluateRequest {
  toolName: string;
  args: unknown;
  callId?: string;
  sessionId?: string;
  agentId: string;
  coworkSessionId?: string;
  executionMode?: string;
  permissionPreset?: DshPermissionPreset;
}

export interface DshApprovalCallContext {
  toolName: string;
  args: Record<string, unknown>;
  permissionPreset?: DshPermissionPreset;
  recordedAt: number;
}

export type DshBridgeApprovalDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason?: string }
  | { kind: 'ask'; reason?: string }
  | { kind: 'cancel' }
  | { kind: 'passthrough' };

export type DshBridgeApprovalEvaluator = (
  request: DshBridgeApprovalEvaluateRequest,
) => Promise<DshBridgeApprovalDecision> | DshBridgeApprovalDecision;

export type DshBridgeChannelEventHandler = (payload: Record<string, unknown>) => Promise<unknown> | unknown;

export interface DshHostStatus {
  phase: DshHostPhase;
  origin: string | null;
  authenticatedWebUrl: string | null;
  pid: number | null;
  runtimeVersion: string | null;
  profileDir: string;
  dshHomeDir: string;
  cliShimPath: string | null;
  lastError: string | null;
  startedAt: number | null;
  restartCount: number;
}

export interface DshHostManagerOptions {
  /** Electron userData directory (e.g. `app.getPath('userData')`). */
  userDataDir: string;
  /** Bundled DSH runtime directory containing `lib/bin.js` and `node_modules/`. */
  runtimeDir: string;
  /** Bundled `@lobsterai/dsh-bundle` directory. */
  hostBundleDir: string;
  /** Optional bundled `@lobsterai/dsh-channels` directory. */
  channelsBundleDir?: string | null;
  /** Path to LobsterAI's `SKILLs` directory. */
  skillsDir: string;
  /** Path to Electron (or Node in tests) executable used with `ELECTRON_RUN_AS_NODE=1`. */
  executablePath: string;
  /** Optional stable instance ID sent via `X-LobsterAI-Instance`. */
  instanceId?: string;
  /** Search routing policy passed to `@lobsterai/dsh-bundle`. */
  searchPolicy?: DshSearchPolicy;
  /** Boot timeout in ms (default 35_000). */
  bootTimeoutMs?: number;
  /** Max automatic crash restarts before entering Failed phase (default 3). */
  maxAutoRestarts?: number;
  /** Optional pre-built client (useful in unit tests). */
  clientFactory?: () => DshTypertClient;
  /** Set true in pure Node tests when running plain node instead of Electron binary. */
  skipElectronRunAsNode?: boolean;
}

const DEFAULT_BOOT_TIMEOUT_MS = 35_000;
const DEFAULT_MAX_AUTO_RESTARTS = 3;
const MAX_BRIDGE_BODY_BYTES = 32 * 1024 * 1024;
const LAUNCH_URL_PATTERN = /dsh web:\s*(https?:\/\/\S+)/;

/**
 * Resolve runtime and bundle directories for packaged vs dev layouts.
 */
export function resolveBundledDshPaths(options: {
  isPackaged: boolean;
  appRootDir: string;
  resourcesDir?: string;
}): {
  runtimeDir: string;
  hostBundleDir: string;
  channelsBundleDir: string | null;
} {
  const baseDir = options.isPackaged && options.resourcesDir
    ? options.resourcesDir
    : options.appRootDir;
  const runtimeDir = options.isPackaged && options.resourcesDir
    ? path.join(options.resourcesDir, 'dsh-runtime')
    : path.join(options.appRootDir, 'vendor', 'dsh-runtime', 'current');
  const hostBundleDir = path.join(baseDir, 'dsh-bundles', 'lobsterai-host');
  const candidateChannels = path.join(baseDir, 'dsh-bundles', 'lobsterai-channels');
  const channelsBundleDir = fs.existsSync(path.join(candidateChannels, 'package.json'))
    ? candidateChannels
    : null;
  return { runtimeDir, hostBundleDir, channelsBundleDir };
}

/**
 * Build a strictly isolated environment for LobsterAI's embedded DSH child
 * process so a co-installed standalone native DSH (using `~/.dsh`, `~/.agents`,
 * or exported `DSH_*` / pnpm store env vars) never interferes with LobsterAI,
 * and LobsterAI never mutates the user's standalone DSH data or plugins.
 */
export function buildIsolatedDshChildEnv(params: {
  baseEnv?: NodeJS.ProcessEnv;
  dshHomeDir: string;
  bridgeUrl: string;
  bridgeSecret: string;
  workspacesDir: string;
  skillsDir: string;
  searchPolicy: DshSearchPolicy;
  runtimeDir: string;
  instanceId?: string;
  skipElectronRunAsNode?: boolean;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(params.baseEnv ?? process.env)) {
    // Strip any inherited native DSH or global pnpm/npm store overrides.
    if (/^dsh_/i.test(key)) continue;
    if (/^npm_config_(?:store_dir|cache)$/i.test(key)) continue;
    env[key] = value;
  }

  env.DSH_HOME = params.dshHomeDir;
  env.DSH_AGENTS_HOME = path.join(params.dshHomeDir, 'agents-home');
  env.DSH_TELEMETRY_DISABLED = '1';
  env.npm_config_store_dir = path.join(params.dshHomeDir, 'cache', 'pnpm-store');
  env.npm_config_cache = path.join(params.dshHomeDir, 'cache', 'npm-cache');
  env[DshHostBundleEnvVar.BridgeUrl] = params.bridgeUrl;
  env[DshHostBundleEnvVar.BridgeSecret] = params.bridgeSecret;
  env[DshHostBundleEnvVar.WorkspacesDir] = params.workspacesDir;
  env[DshHostBundleEnvVar.SkillsDir] = params.skillsDir;
  env[DshHostBundleEnvVar.SearchPolicy] = params.searchPolicy;

  if (!params.skipElectronRunAsNode) {
    env.ELECTRON_RUN_AS_NODE = '1';
  }
  if (params.instanceId) {
    env[DshHostBundleEnvVar.InstanceId] = params.instanceId;
  }
  // Prepend bundled package-manager dir so `dsh-plugin-manager` finds bundled pnpm.
  const pmDir = path.join(params.runtimeDir, 'package-manager');
  if (fs.existsSync(pmDir)) {
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
    env[pathKey] = env[pathKey] ? `${pmDir}${path.delimiter}${env[pathKey]}` : pmDir;
  }
  return env;
}

export class DshHostManager extends EventEmitter {
  private readonly options: DshHostManagerOptions;
  private readonly dshHomeDir: string;
  private readonly profileDir: string;
  private readonly workspacesDir: string;
  private readonly bridgeSecret: string;

  private phase: DshHostPhase = DshHostPhase.Stopped;
  private child: ChildProcess | null = null;
  private client: DshTypertClient | null = null;
  private bridgeServer: http.Server | null = null;
  private bridgeUrl = '';
  private authenticatedWebUrl: string | null = null;
  private origin: string | null = null;
  private cliShimPath: string | null = null;
  private runtimeVersion: string | null = null;
  private lastError: string | null = null;
  private startedAt: number | null = null;
  private restartCount = 0;
  private stopping = false;
  private startPromise: Promise<void> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly toolHandlers = new Map<string, DshBridgeToolHandler>();
  private fallbackToolHandler: DshBridgeToolHandler | null = null;
  private approvalEvaluator: DshBridgeApprovalEvaluator | null = null;
  private channelEventHandler: DshBridgeChannelEventHandler | null = null;

  // Cached sync payloads replayed automatically after any restart.
  private lastProvidersPayload: {
    providers: DshHostProviderSpec[];
    virtualAliases?: Record<string, { provider: string; model: string }>;
  } | null = null;
  private lastMcpServers: DshHostMcpServerSpec[] | null = null;
  private lastSkillsPolicy: DshHostSkillsPolicy | null = null;
  private lastHostTools: DshHostToolDescriptor[] | null = null;
  private lastPermissionPreset: DshPermissionPreset = DEFAULT_DSH_PERMISSION_PRESET;
  private readonly approvalCallContexts = new Map<string, DshApprovalCallContext>();

  constructor(options: DshHostManagerOptions) {
    super();
    this.options = options;
    this.dshHomeDir = path.join(options.userDataDir, DSH_PROFILE_DIR_NAME);
    this.profileDir = resolveLobsterDshProfileDir(this.dshHomeDir);
    this.workspacesDir = path.join(options.userDataDir, WORKSPACES_DIR_NAME);
    this.bridgeSecret = randomBytes(32).toString('hex');
  }

  getStatus(): DshHostStatus {
    return {
      phase: this.phase,
      origin: this.origin,
      authenticatedWebUrl: this.authenticatedWebUrl,
      pid: this.child?.pid ?? null,
      runtimeVersion: this.runtimeVersion,
      profileDir: this.profileDir,
      dshHomeDir: this.dshHomeDir,
      cliShimPath: this.cliShimPath,
      lastError: this.lastError,
      startedAt: this.startedAt,
      restartCount: this.restartCount,
    };
  }

  getAuthenticatedWebUrl(): string | null {
    return this.authenticatedWebUrl;
  }

  getClient(): DshTypertClient {
    if (!this.client || this.phase !== DshHostPhase.Ready) {
      throw new Error(`DSH host is not ready (phase=${this.phase})`);
    }
    return this.client;
  }

  isReady(): boolean {
    return this.phase === DshHostPhase.Ready && this.client !== null && this.client.isConnected();
  }

  registerBridgeToolHandler(toolName: string, handler: DshBridgeToolHandler): () => void {
    this.toolHandlers.set(toolName, handler);
    return () => {
      if (this.toolHandlers.get(toolName) === handler) {
        this.toolHandlers.delete(toolName);
      }
    };
  }

  setFallbackBridgeToolHandler(handler: DshBridgeToolHandler | null): void {
    this.fallbackToolHandler = handler;
  }

  setApprovalEvaluator(evaluator: DshBridgeApprovalEvaluator | null): void {
    this.approvalEvaluator = evaluator;
  }

  setChannelEventHandler(handler: DshBridgeChannelEventHandler | null): void {
    this.channelEventHandler = handler;
  }

  /**
   * Ensure the DSH host is started, authenticated, and healthy. Concurrent
   * callers share a single in-flight boot promise.
   */
  async start(): Promise<void> {
    if (this.isReady()) return;
    if (this.startPromise) return this.startPromise;
    this.stopping = false;
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async restart(): Promise<void> {
    this.setPhase(DshHostPhase.Restarting);
    await this.stopProcessOnly();
    this.restartCount = 0;
    await this.start();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    await this.stopProcessOnly();
    await this.stopBridgeServer();
    this.setPhase(DshHostPhase.Stopped);
  }

  // ── Live Host Sync Operations ──────────────────────────────────────────────

  async syncProviders(payload: {
    providers: DshHostProviderSpec[];
    virtualAliases?: Record<string, { provider: string; model: string }>;
  }): Promise<Record<string, unknown>> {
    this.lastProvidersPayload = payload;
    if (!this.isReady()) return { deferred: true };
    return this.getClient().callOps(DshOpsAction.SyncProviders, payload);
  }

  async syncMcpServers(servers: DshHostMcpServerSpec[]): Promise<Record<string, unknown>> {
    this.lastMcpServers = servers;
    if (!this.isReady()) return { deferred: true };
    return this.getClient().callOps(DshOpsAction.SyncMcpServers, { servers });
  }

  async syncSkillsPolicy(policy: DshHostSkillsPolicy): Promise<Record<string, unknown>> {
    this.lastSkillsPolicy = policy;
    if (!this.isReady()) return { deferred: true };
    return this.getClient().callOps(DshOpsAction.SyncSkillsPolicy, policy);
  }

  async syncHostTools(tools: DshHostToolDescriptor[]): Promise<Record<string, unknown>> {
    this.lastHostTools = tools;
    if (!this.isReady()) return { deferred: true };
    return this.getClient().callOps(DshOpsAction.SyncHostTools, { tools });
  }

  async bindSessionContext(context: DshHostSessionContext): Promise<Record<string, unknown>> {
    return this.getClient().callOps(DshOpsAction.BindSessionContext, context);
  }

  async deleteSessionFiles(sessionId: string): Promise<Record<string, unknown>> {
    if (!this.isReady()) return { skipped: true };
    return this.getClient().callOps(DshOpsAction.DeleteSessionFiles, { sessionId });
  }

  async setPermissionPreset(
    preset: DshPermissionPreset,
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    if (!sessionId) {
      this.lastPermissionPreset = preset;
    }
    if (!this.isReady()) return { deferred: true, preset };
    return this.getClient().callOps(DshOpsAction.SetPermissionPreset, {
      preset,
      ...(sessionId ? { sessionId } : {}),
    });
  }

  consumeApprovalCallContext(callId: string): DshApprovalCallContext | null {
    if (!callId) return null;
    const entry = this.approvalCallContexts.get(callId) ?? null;
    if (entry) {
      this.approvalCallContexts.delete(callId);
    }
    return entry;
  }

  private recordApprovalCallContext(callId: string, context: DshApprovalCallContext): void {
    this.approvalCallContexts.set(callId, context);
    while (this.approvalCallContexts.size > 128) {
      const oldestKey = this.approvalCallContexts.keys().next().value;
      if (oldestKey === undefined) break;
      this.approvalCallContexts.delete(oldestKey);
    }
  }

  // ── Internal Boot & Supervision ────────────────────────────────────────────

  private async doStart(): Promise<void> {
    this.lastError = null;
    this.setPhase(DshHostPhase.Starting);

    try {
      const runtimeBinPath = path.join(this.options.runtimeDir, 'lib', 'bin.js');
      if (!fs.existsSync(runtimeBinPath)) {
        throw new Error(`DSH runtime binary not found at ${runtimeBinPath}`);
      }
      this.runtimeVersion = this.readRuntimeVersion();

      fs.mkdirSync(this.workspacesDir, { recursive: true });
      ensureAppOwnedProfile({
        profileDir: this.profileDir,
        hostBundleDir: this.options.hostBundleDir,
        channelsBundleDir: this.options.channelsBundleDir,
      });

      this.cliShimPath = writeDshCliShim({
        binDir: path.join(this.dshHomeDir, 'bin'),
        electronPath: this.options.executablePath,
        runtimeEntryPath: runtimeBinPath,
        profileDir: this.profileDir,
        dshHomeDir: this.dshHomeDir,
      });

      await this.ensureBridgeServer();
      const launchUrl = await this.spawnAndWaitForLaunchUrl(runtimeBinPath);

      const client = this.options.clientFactory
        ? this.options.clientFactory()
        : new DshTypertClient();
      await client.connect(launchUrl);
      const health = await client.callOps<{ ok?: boolean }>(DshOpsAction.Health);
      if (health && 'ok' in health && health.ok === false) {
        throw new Error(`DSH host health check failed: ${JSON.stringify(health)}`);
      }

      this.client = client;
      this.authenticatedWebUrl = launchUrl;
      this.origin = new URL(launchUrl).origin;
      this.startedAt = Date.now();
      this.setPhase(DshHostPhase.Ready);

      await this.replayCachedSyncs();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      await this.stopProcessOnly();
      this.setPhase(DshHostPhase.Failed);
      this.emit('error', error instanceof Error ? error : new Error(message));
      throw error;
    }
  }

  private async replayCachedSyncs(): Promise<void> {
    if (!this.isReady()) return;
    if (this.lastProvidersPayload) {
      await this.getClient().callOps(DshOpsAction.SyncProviders, this.lastProvidersPayload);
    }
    if (this.lastSkillsPolicy) {
      await this.getClient().callOps(DshOpsAction.SyncSkillsPolicy, this.lastSkillsPolicy);
    }
    if (this.lastHostTools) {
      await this.getClient().callOps(DshOpsAction.SyncHostTools, { tools: this.lastHostTools });
    }
    if (this.lastMcpServers) {
      await this.getClient().callOps(DshOpsAction.SyncMcpServers, { servers: this.lastMcpServers });
    }
    await this.getClient().callOps(DshOpsAction.SetPermissionPreset, {
      preset: this.lastPermissionPreset,
    });
  }

  private readRuntimeVersion(): string | null {
    try {
      const pkgPath = path.join(this.options.runtimeDir, 'package.json');
      const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: unknown };
      return typeof parsed.version === 'string' ? parsed.version : null;
    } catch {
      return null;
    }
  }

  private buildChildEnv(): NodeJS.ProcessEnv {
    return buildIsolatedDshChildEnv({
      baseEnv: process.env,
      dshHomeDir: this.dshHomeDir,
      bridgeUrl: this.bridgeUrl,
      bridgeSecret: this.bridgeSecret,
      workspacesDir: this.workspacesDir,
      skillsDir: this.options.skillsDir,
      searchPolicy: this.options.searchPolicy ?? DshSearchPolicy.DeepSeekNativeOnly,
      runtimeDir: this.options.runtimeDir,
      instanceId: this.options.instanceId,
      skipElectronRunAsNode: this.options.skipElectronRunAsNode,
    });
  }

  private spawnAndWaitForLaunchUrl(runtimeBinPath: string): Promise<string> {
    const args = [
      ...DSH_NODE_EXEC_ARGV,
      runtimeBinPath,
      '--profile',
      DSH_PROFILE_NAME,
      '--no-open',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
    ];
    const child = spawn(this.options.executablePath, args, {
      env: this.buildChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    const bootTimeoutMs = this.options.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;

    return new Promise<string>((resolve, reject) => {
      let stdoutBuf = '';
      let stderrBuf = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`DSH host boot timed out after ${bootTimeoutMs}ms.\nSTDERR:\n${stderrBuf.slice(-2000)}`));
      }, bootTimeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        this.emit('log', { stream: 'stdout', text });
        if (!settled) {
          stdoutBuf += text;
          const match = LAUNCH_URL_PATTERN.exec(stdoutBuf);
          if (match) {
            settled = true;
            clearTimeout(timer);
            resolve(match[1]);
          }
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        this.emit('log', { stream: 'stderr', text });
        if (!settled) {
          stderrBuf += text;
        }
      });

      child.once('error', (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      });

      child.once('exit', (code, signal) => {
        if (this.child === child) {
          this.child = null;
        }
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(
            new Error(
              `DSH host exited before ready (code=${String(code)}, signal=${String(signal)}).\nSTDERR:\n${stderrBuf.slice(-2000)}`,
            ),
          );
          return;
        }
        if (!this.stopping) {
          this.handleUnexpectedExit(code, signal);
        }
      });
    });
  }

  private handleUnexpectedExit(code: number | null, signal: NodeJS.Signals | null): void {
    const reason = `DSH host exited unexpectedly (code=${String(code)}, signal=${String(signal)})`;
    this.lastError = reason;
    this.authenticatedWebUrl = null;
    this.origin = null;
    const oldClient = this.client;
    this.client = null;
    void oldClient?.close().catch((): void => undefined);

    const maxRestarts = this.options.maxAutoRestarts ?? DEFAULT_MAX_AUTO_RESTARTS;
    if (this.restartCount >= maxRestarts) {
      this.setPhase(DshHostPhase.Failed);
      this.emit('error', new Error(`${reason}; exceeded max auto-restarts (${maxRestarts})`));
      return;
    }

    this.restartCount += 1;
    this.setPhase(DshHostPhase.Restarting);
    const delayMs = Math.min(8_000, 1_000 * this.restartCount);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      this.start().catch(() => {
        // Error already recorded & emitted in doStart().
      });
    }, delayMs);
  }

  private async stopProcessOnly(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.authenticatedWebUrl = null;
    this.origin = null;
    if (client) {
      await client.close().catch((): void => undefined);
    }

    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.killed) return;

    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Process already gone.
        }
        resolve();
      }, 5_000);
      child.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });
      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(killTimer);
        resolve();
      }
    });
  }

  // ── Authenticated Local Callback Bridge ────────────────────────────────────

  private async ensureBridgeServer(): Promise<void> {
    if (this.bridgeServer && this.bridgeUrl) return;
    const server = http.createServer((req, res) => {
      void this.handleBridgeRequest(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('Failed to bind DSH local callback bridge'));
          return;
        }
        this.bridgeServer = server;
        this.bridgeUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  }

  private async stopBridgeServer(): Promise<void> {
    const server = this.bridgeServer;
    this.bridgeServer = null;
    this.bridgeUrl = '';
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  private isAuthorizedBridgeRequest(req: http.IncomingMessage): boolean {
    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return false;
    const actual = Buffer.from(auth.slice(7), 'utf8');
    const expected = Buffer.from(this.bridgeSecret, 'utf8');
    return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
  }

  private async handleBridgeRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.isAuthorizedBridgeRequest(req)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    let body: Record<string, unknown>;
    try {
      const raw = await readRequestBody(req, MAX_BRIDGE_BODY_BYTES);
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Invalid JSON body' }));
      return;
    }

    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    try {
      if (pathname === '/dsh-bridge/tool-execute') {
        const request: DshBridgeToolExecuteRequest = {
          toolName: String(body.toolName ?? ''),
          args: (body.args && typeof body.args === 'object' ? body.args : {}) as Record<string, unknown>,
          callId: typeof body.callId === 'string' ? body.callId : undefined,
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
          agentId: typeof body.agentId === 'string' && body.agentId ? body.agentId : 'main',
          coworkSessionId: typeof body.coworkSessionId === 'string' ? body.coworkSessionId : undefined,
        };
        const handler = this.toolHandlers.get(request.toolName) ?? this.fallbackToolHandler;
        if (!handler) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: `No host tool handler registered for "${request.toolName}"` }));
          return;
        }
        const controller = new AbortController();
        const onDisconnect = () => controller.abort();
        res.once('close', onDisconnect);
        try {
          if (res.destroyed) return;
          const data = await handler({ ...request, signal: controller.signal });
          if (!res.destroyed) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(data ?? { ok: true }));
          }
        } finally {
          res.off('close', onDisconnect);
        }
        return;
      }

      if (pathname === '/dsh-bridge/approval-evaluate') {
        const callId = typeof body.callId === 'string' ? body.callId : undefined;
        const toolName = String(body.toolName ?? '');
        const rawPreset = typeof body.permissionPreset === 'string' ? body.permissionPreset : undefined;
        const permissionPreset =
          rawPreset === DshPermissionPreset.ReadOnly
          || rawPreset === DshPermissionPreset.WorkspaceWrite
          || rawPreset === DshPermissionPreset.FullAccess
            ? rawPreset
            : undefined;
        if (callId) {
          this.recordApprovalCallContext(callId, {
            toolName,
            args: (body.args && typeof body.args === 'object' && !Array.isArray(body.args)
              ? body.args
              : {}) as Record<string, unknown>,
            permissionPreset,
            recordedAt: Date.now(),
          });
        }
        if (!this.approvalEvaluator) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ kind: 'passthrough' }));
          return;
        }
        const decision = await this.approvalEvaluator({
          toolName,
          args: body.args,
          callId,
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
          agentId: typeof body.agentId === 'string' && body.agentId ? body.agentId : 'main',
          coworkSessionId: typeof body.coworkSessionId === 'string' ? body.coworkSessionId : undefined,
          executionMode: typeof body.executionMode === 'string' ? body.executionMode : undefined,
          permissionPreset,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(decision));
        return;
      }

      if (pathname === '/dsh-bridge/channel-event') {
        const result = this.channelEventHandler ? await this.channelEventHandler(body) : { ok: true };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result ?? { ok: true }));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `Unknown bridge route: ${pathname}` }));
    } catch (error) {
      if (res.destroyed) return;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  }

  private setPhase(next: DshHostPhase): void {
    if (this.phase === next) return;
    this.phase = next;
    this.emit('phaseChange', next, this.getStatus());
  }
}

function readRequestBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        reject(new Error('Bridge request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
