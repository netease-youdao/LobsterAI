import crypto from 'crypto';
import { app, BrowserWindow } from 'electron';
import path from 'path';

import { COMPUTER_USE_MCP_TOOL_CALL_TIMEOUT_MS } from '../../shared/computerUse/constants';
import { ASK_USER_QUESTION_TOOL_NAME, SESSION_AGNOSTIC_PERMISSION_SESSION_ID } from '../../shared/cowork/constants';
import { McpAuthMode } from '../../shared/mcp/auth';
import { McpIpcChannel, McpManagedConnection } from '../../shared/mcp/constants';
import type { McpToolDiscoveryRequest } from '../../shared/mcp/toolDiscovery';
import { type MediaConfirmationCommand, MediaConfirmationReason } from '../../shared/media/confirmation';
import { NeteaseMail } from '../../shared/neteaseMail/constants';
import { getNeteaseMailNativeTools, getNeteaseMailScopes } from '../../shared/neteaseMail/scopes';
import {
  isComputerUseKitInstalled,
  isComputerUseSkillEnabled,
  syncComputerUseSkillFromRuntime,
} from '../computerUse/computerUseKit';
import { resolveComputerUseMcpServer } from '../computerUse/computerUseMcpServer';
import { installComputerUseRuntime } from '../computerUse/computerUseRuntime';
import { ensureElectronNodeShim, getElectronNodeRuntimePath } from '../libs/coworkUtil';
import {
  type AskUserOptions,
  type AskUserRequest,
  type AskUserResponse,
  type BrowserToolRequest,
  type BrowserToolResponse,
  type DecisionToolHandler,
  type EditorToolHandler,
  McpBridgeServer,
  type MediaGenerationRequest,
  type MediaGenerationResponse,
} from '../libs/mcpBridgeServer';
import { applyNodeSystemCaDefault } from '../libs/nodeSystemCaEnv';
import { resolveLocalDesktopCoworkSessionIdByOpenClawSessionKey } from '../libs/openclawLocalSessionResolver';
import { applyPythonEncodingDefaults } from '../libs/pythonEncodingEnv';
import { appendPythonRuntimeToEnv } from '../libs/pythonRuntime';
import { resolveStdioCommand } from '../libs/resolveStdioCommand';
import type { SqliteStore } from '../sqliteStore';
import { createMcpLaunchSourceFingerprint, McpLaunchResolutionStatus } from './mcpLaunchResolution';
import { McpLaunchResolverManager } from './mcpLaunchResolverManager';
import type { McpOAuthTokenRecord } from './mcpOAuthManager';
import { type McpServerRecord, McpStore } from './mcpStore';
import type { McpToolDiscoveryLaunch } from './mcpToolDiscovery';
import { getNeteaseMailOAuthConfig, matchesNeteaseMailRegistration } from './neteaseMailConfig';
import type { ResolvedMcpServer } from './types';

export type { AskUserResponse, MediaGenerationRequest, MediaGenerationResponse };

// Covers the host's bounded connection wait and the surrounding config sync.
const MANAGED_MCP_SYNC_TIMEOUT_MS = 18_000;

interface ManagedLaunchConnection {
  sourceFingerprint: string;
  serverUpdatedAt: number;
  pending: Promise<void> | null;
}

const getPackagedNpmBinDir = (): string => (app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'npm', 'bin')
  : '');

/** Runtime env omitted by the MCP inheritance allowlist; server overrides win. */
function buildMcpShimEnv(...overrides: (Record<string, string> | undefined)[]): Record<string, string> {
  let shimEnv: Record<string, string> = {
    LOBSTERAI_ELECTRON_PATH: getElectronNodeRuntimePath(),
  };
  const npmBinDir = getPackagedNpmBinDir();
  if (npmBinDir) {
    shimEnv.LOBSTERAI_NPM_BIN_DIR = npmBinDir;
  }
  for (const override of overrides) {
    shimEnv = { ...shimEnv, ...override };
  }
  applyPythonEncodingDefaults(shimEnv, { sources: [process.env, ...overrides] });
  applyNodeSystemCaDefault(shimEnv);
  return shimEnv;
}

/**
 * PATH as the gateway passes it to its MCP children (see startGateway in
 * openclawEngineManager): node/npx shims and the Windows Python runtime first.
 */
function buildGatewayChildPath(): string {
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH || process.env.Path || '',
  };
  appendPythonRuntimeToEnv(env);
  const npmBinDir = getPackagedNpmBinDir() || path.join(app.getAppPath(), 'node_modules', 'npm', 'bin');
  const nodeShimDir = ensureElectronNodeShim(getElectronNodeRuntimePath(), npmBinDir);
  return [nodeShimDir, env.PATH].filter(Boolean).join(path.delimiter);
}

export interface McpRuntimeDeps {
  getMailToken?: (serverId: string) => McpOAuthTokenRecord | null;
  getStore: () => SqliteStore;
  syncOpenClawConfig: (options: {
    reason: string;
    restartGatewayIfRunning?: boolean;
    expectedImpact?: string;
    waitForMcpServerId?: string;
  }) => Promise<{ success: boolean; changed: boolean; mcpServerConnected?: boolean }>;
  /** Fired when an AskUserQuestion request is surfaced to the renderer. */
  onAskUserRequested?: (sessionId: string, request: { requestId: string; toolName: string }) => void;
  /** Fired when a pending AskUserQuestion request is dismissed upstream. */
  onAskUserDismissed?: (requestId: string) => void;
  /** Persisted bridge secret; openclaw.json must stay stable across launches. */
  bridgeSecret?: string;
  /** Callback-server port from the previous launch. */
  getBridgePreferredPort?: () => number | undefined;
  onBridgePortBound?: (port: number) => void;
}

export class McpRuntime {
  private mcpStore: McpStore | null = null;
  private launchResolverManager: McpLaunchResolverManager | null = null;
  private readonly launchConnections = new Map<string, ManagedLaunchConnection>();
  private bridgeServer: McpBridgeServer | null = null;
  private readonly bridgeSecret: string;
  private resolvedServersCache: ResolvedMcpServer[] = [];
  private mediaGenerationHandler:
    | ((request: MediaGenerationRequest) => Promise<MediaGenerationResponse>)
    | null = null;
  private browserToolHandler:
    | ((request: BrowserToolRequest) => Promise<BrowserToolResponse>)
    | null = null;
  private decisionToolHandler: DecisionToolHandler | null = null;
  private readonly editorToolHandlers = new Map<string, { editorName: string; handler: EditorToolHandler }>();

  constructor(private readonly deps: McpRuntimeDeps) {
    this.bridgeSecret = deps.bridgeSecret || crypto.randomUUID();
  }

  getStore(): McpStore {
    if (!this.mcpStore) {
      const sqliteStore = this.deps.getStore();
      this.mcpStore = new McpStore(sqliteStore.getDatabase());
    }
    return this.mcpStore;
  }

  getLaunchResolverManager(): McpLaunchResolverManager {
    if (!this.launchResolverManager) {
      this.launchResolverManager = new McpLaunchResolverManager(
        this.getStore(),
        () => this.broadcastServersChanged(),
        (reason, readyServerId) => this.syncLaunchConnection(reason, readyServerId),
      );
    }
    return this.launchResolverManager;
  }

  ensureLaunchResolution(serverId: string, reason: string): void {
    this.getLaunchResolverManager().ensureResolved(serverId, reason);
  }

  private getLaunchConnection(server: McpServerRecord): ManagedLaunchConnection | undefined {
    const connection = this.launchConnections.get(server.id);
    if (
      !server.enabled
      || connection?.serverUpdatedAt !== server.updatedAt
      || connection.sourceFingerprint !== server.launchResolution?.sourceFingerprint
    ) return undefined;
    return connection;
  }

  getDisplayServers(): Array<McpServerRecord & { runtimeConnection?: McpManagedConnection }> {
    return this.getStore().listServers().map(server => {
      const connection = this.getLaunchConnection(server);
      return connection ? {
        ...server,
        runtimeConnection: connection.pending ? McpManagedConnection.Connecting : McpManagedConnection.Connected,
      } : server;
    });
  }

  private syncLaunchConnection(reason: string, serverId?: string): void {
    const server = serverId ? this.getStore().getServer(serverId) : null;
    const resolution = server?.enabled ? this.getLaunchResolverManager().getReadyResolution(server) : undefined;
    const waitForMcpServerId = resolution && server ? server.id : undefined;
    const sync = Promise.resolve().then(() => this.deps.syncOpenClawConfig({
      reason,
      expectedImpact: 'sync',
      ...(waitForMcpServerId ? { waitForMcpServerId } : {}),
    })).catch((err): null => {
      console.error('[MCP] config sync error after launch resolution:', err);
      return null;
    });
    if (!server || !resolution) return;

    const connection: ManagedLaunchConnection = {
      sourceFingerprint: resolution.sourceFingerprint,
      serverUpdatedAt: server.updatedAt,
      pending: null,
    };
    const timeout = AbortSignal.timeout(MANAGED_MCP_SYNC_TIMEOUT_MS);
    connection.pending = new Promise<void>(resolve => {
      const finish = (connected: boolean) => {
        timeout.removeEventListener('abort', onTimeout);
        if (this.launchConnections.get(server.id) === connection) {
          if (connected) connection.pending = null;
          else this.launchConnections.delete(server.id);
          this.broadcastServersChanged();
        }
        resolve();
      };
      const onTimeout = () => finish(false);
      timeout.addEventListener('abort', onTimeout, { once: true });
      void sync.then(result => finish(result?.success === true && result.mcpServerConnected === true));
    });
    this.launchConnections.set(server.id, connection);
  }

  async waitForPendingLaunchConnections(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const pending: Promise<void>[] = [];
    for (const [id, connection] of this.launchConnections) {
      if (!connection.pending) continue;
      const server = this.getStore().getServer(id);
      if (server && this.getLaunchConnection(server) === connection) pending.push(connection.pending);
    }
    if (pending.length === 0) return;

    await new Promise<void>(resolve => {
      const finish = () => {
        signal.removeEventListener('abort', finish);
        resolve();
      };
      signal.addEventListener('abort', finish, { once: true });
      void Promise.all(pending).then(finish, finish);
    });
  }

  setMediaGenerationHandler(
    handler: (request: MediaGenerationRequest) => Promise<MediaGenerationResponse>,
  ): void {
    this.mediaGenerationHandler = handler;
  }

  async executeMediaGeneration(request: MediaGenerationRequest): Promise<MediaGenerationResponse> {
    if (!this.mediaGenerationHandler) {
      return {
        content: [{ type: 'text', text: 'Media generation service is not ready yet.' }],
        isError: true,
      };
    }
    return await this.mediaGenerationHandler(request);
  }

  setBrowserToolHandler(
    handler: (request: BrowserToolRequest) => Promise<BrowserToolResponse>,
  ): void {
    this.browserToolHandler = handler;
    this.bridgeServer?.onBrowserTool(handler);
  }

  setDecisionToolHandler(handler: DecisionToolHandler): void {
    this.decisionToolHandler = handler;
  }

  /** Serve a document editor's agent tools on the bridge at `/<route>/tool`. */
  setEditorToolHandler(route: string, editorName: string, handler: EditorToolHandler): void {
    this.editorToolHandlers.set(route, { editorName, handler });
    this.bridgeServer?.onEditorTool(route, editorName, handler);
  }

  getEditorCallbackUrl(route: string): string | null {
    return this.bridgeServer?.editorCallbackUrl(route) ?? null;
  }

  getAskUserCallbackUrl(): string | null {
    return this.bridgeServer?.askUserCallbackUrl ?? null;
  }

  getMediaCallbackUrl(): string | null {
    return this.bridgeServer?.mediaCallbackUrl ?? null;
  }

  getBrowserCallbackUrl(): string | null {
    return this.bridgeServer?.browserCallbackUrl ?? null;
  }

  getDecisionCallbackUrl(): string | null {
    return this.bridgeServer?.decisionCallbackUrl ?? null;
  }

  getHostInfoUrl(): string | null {
    return this.bridgeServer?.hostInfoUrl ?? null;
  }

  getBridgeSecret(): string {
    return this.bridgeSecret;
  }

  getResolvedServersCache(): ResolvedMcpServer[] {
    return this.resolvedServersCache;
  }

  async refreshResolvedServersCache(): Promise<ResolvedMcpServer[]> {
    this.resolvedServersCache = await this.getResolvedServers();
    return this.resolvedServersCache;
  }

  clearResolvedServersCache(): void {
    this.resolvedServersCache = [];
  }

  async startAskUserServer(): Promise<void> {
    if (this.bridgeServer?.port) return;

    if (!this.bridgeServer) {
      this.bridgeServer = new McpBridgeServer(this.bridgeSecret);
    }
    console.log('[AskUser] starting HTTP callback server...');
    const port = await this.bridgeServer.start(this.deps.getBridgePreferredPort?.());
    this.deps.onBridgePortBound?.(port);

    this.bridgeServer.onAskUser(request => {
      const sessionId = request.sessionKey
        ? resolveLocalDesktopCoworkSessionIdByOpenClawSessionKey(
            this.deps.getStore().getDatabase(),
            request.sessionKey,
          )
        : SESSION_AGNOSTIC_PERMISSION_SESSION_ID;
      if (!sessionId) {
        console.warn('[AskUser] denied request for non-desktop or unknown session:', request.sessionKey);
        this.resolveAskUser(request.requestId, { behavior: 'deny' });
        return;
      }
      const windows = BrowserWindow.getAllWindows();
      let delivered = false;
      windows.forEach(win => {
        if (win.isDestroyed()) return;
        try {
          win.webContents.send('cowork:stream:permission', {
            sessionId,
            request: {
              requestId: request.requestId,
              toolName: ASK_USER_QUESTION_TOOL_NAME,
              toolInput: {
                questions: request.questions,
                ...(request.mediaConfirmation ? { mediaConfirmation: request.mediaConfirmation } : {}),
                ...(request.sessionKey ? { sessionKey: request.sessionKey } : {}),
              },
            },
          });
          delivered = true;
        } catch (error) {
          console.error('[AskUser] failed to send permission request to window:', error);
        }
      });
      if (request.mediaConfirmation && !delivered) {
        this.resolveAskUser(request.requestId, { behavior: 'deny', reason: MediaConfirmationReason.NoRoute });
        return;
      }
      if (!request.mediaConfirmation || request.mediaConfirmation.sequence === 1) this.deps.onAskUserRequested?.(sessionId, {
        requestId: request.requestId,
        toolName: ASK_USER_QUESTION_TOOL_NAME,
      });
    });

    this.bridgeServer.onAskUserDismiss(requestId => {
      const windows = BrowserWindow.getAllWindows();
      windows.forEach(win => {
        if (win.isDestroyed()) return;
        try {
          win.webContents.send('cowork:stream:permissionDismiss', { requestId });
        } catch {
          // ignore
        }
      });
      this.deps.onAskUserDismissed?.(requestId);
    });

    this.bridgeServer.onMediaGeneration(request => this.executeMediaGeneration(request));

    this.bridgeServer.onDecisionTool(async (request, signal) => {
      if (!this.decisionToolHandler) {
        return {
          content: [{ type: 'text', text: 'The decision model service is not ready yet.' }],
          isError: true,
        };
      }
      return await this.decisionToolHandler(request, signal);
    });

    if (this.browserToolHandler) {
      this.bridgeServer.onBrowserTool(this.browserToolHandler);
    }
    for (const [route, { editorName, handler }] of this.editorToolHandlers) {
      this.bridgeServer.onEditorTool(route, editorName, handler);
    }
  }

  async askUserInternal(
    questions: AskUserRequest['questions'],
    timeoutMs?: number,
    options?: AskUserOptions,
  ): Promise<AskUserResponse | null> {
    if (!this.bridgeServer) return null;
    return await this.bridgeServer.askUserInternal(questions, timeoutMs, options);
  }

  getPendingMediaConfirmations() {
    return (this.bridgeServer?.getPendingMediaConfirmations() ?? []).flatMap(request => {
      const sessionId = request.sessionKey ? resolveLocalDesktopCoworkSessionIdByOpenClawSessionKey(
        this.deps.getStore().getDatabase(), request.sessionKey,
      ) : null;
      if (!sessionId) { this.bridgeServer?.resolveAskUser(request.requestId, { behavior: 'deny' }); return []; }
      return [{ sessionId, requestId: request.requestId, toolName: ASK_USER_QUESTION_TOOL_NAME,
        toolInput: { questions: request.questions, mediaConfirmation: request.mediaConfirmation } }];
    });
  }

  actOnMediaConfirmation(command: MediaConfirmationCommand): Promise<boolean> {
    return this.bridgeServer?.actOnMediaConfirmation(command) ?? Promise.resolve(false);
  }

  resolveAskUser(requestId: string, response: AskUserResponse): void {
    this.bridgeServer?.resolveAskUser(requestId, response);
  }

  broadcastServersChanged(): void {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach(win => {
      if (win.isDestroyed()) return;
      try {
        win.webContents.send(McpIpcChannel.Changed);
      } catch {
        // ignore destroyed windows
      }
    });
  }

  /**
   * Launch settings for listing a server's tools from the settings form. Uses
   * the same resolution as getResolvedServers() so the names match what
   * OpenClaw loads: a ready managed npx install is reused while the launch
   * fields are unchanged; otherwise the raw command runs (npx may download).
   */
  async resolveToolDiscoveryLaunch(request: McpToolDiscoveryRequest): Promise<McpToolDiscoveryLaunch> {
    if (request.transportType !== 'stdio') {
      return {
        name: request.name,
        transportType: request.transportType,
        url: request.url,
        headers: request.headers,
      };
    }

    const saved = request.serverId ? this.getStore().getServer(request.serverId) : null;
    const now = Date.now();
    const server: McpServerRecord = {
      ...(saved ?? { id: '', description: '', enabled: false, isBuiltIn: false, createdAt: now, updatedAt: now }),
      name: request.name,
      transportType: 'stdio',
      command: request.command,
      args: request.args ?? [],
      env: request.env && Object.keys(request.env).length > 0 ? request.env : undefined,
    };

    const launchResolver = this.getLaunchResolverManager();
    const readyResolution = saved && launchResolver.canOptimize(server)
      ? launchResolver.getReadyResolution(server)
      : undefined;
    let launch: { command: string; args: string[]; env: Record<string, string> };
    if (readyResolution?.command) {
      launch = {
        command: readyResolution.command,
        args: readyResolution.args || [],
        env: buildMcpShimEnv(readyResolution.env, server.env),
      };
    } else {
      const resolvedCommand = await resolveStdioCommand(server);
      launch = {
        command: resolvedCommand.command,
        args: resolvedCommand.args,
        env: buildMcpShimEnv(resolvedCommand.env),
      };
    }

    return {
      name: server.name,
      transportType: 'stdio',
      command: launch.command,
      args: launch.args,
      // A PATH set on the server itself still wins, as it does under OpenClaw.
      env: { PATH: buildGatewayChildPath(), ...launch.env },
    };
  }

  private async getResolvedServers(): Promise<ResolvedMcpServer[]> {
    const startedAt = Date.now();
    const enabledServers = this.getStore().getEnabledServers();
    const resolved: ResolvedMcpServer[] = [];
    let optimizedCount = 0;
    let skippedCount = 0;
    let rawCount = 0;
    let builtInCount = 0;

    const electronPath = getElectronNodeRuntimePath();
    // toolFilter / supportsParallelToolCalls / timeouts ride along to openclaw.json regardless of transport.
    const passthroughFields = (server: typeof enabledServers[number]) => ({
      ...(server.toolFilter ? { toolFilter: server.toolFilter } : {}),
      ...(typeof server.supportsParallelToolCalls === 'boolean'
        ? { supportsParallelToolCalls: server.supportsParallelToolCalls }
        : {}),
      ...(server.requestTimeoutMs ? { requestTimeoutMs: server.requestTimeoutMs } : {}),
      ...(server.connectionTimeoutMs ? { connectionTimeoutMs: server.connectionTimeoutMs } : {}),
    });
    const pushRawStdioServer = async (server: typeof enabledServers[number]): Promise<void> => {
      const r = await resolveStdioCommand(server);
      resolved.push({
        id: server.id,
        name: server.name,
        transportType: 'stdio',
        command: r.command,
        args: r.args,
        env: buildMcpShimEnv(r.env),
        ...passthroughFields(server),
      });
    };

    for (const server of enabledServers) {
      if (server.transportType === 'stdio') {
        const launchResolver = this.getLaunchResolverManager();
        if (launchResolver.canOptimize(server)) {
          const readyResolution = launchResolver.getReadyResolution(server);
          if (readyResolution) {
            optimizedCount++;
            resolved.push({
              id: server.id,
              name: server.name,
              transportType: 'stdio',
              command: readyResolution.command,
              args: readyResolution.args || [],
              env: buildMcpShimEnv(readyResolution.env, server.env),
              ...passthroughFields(server),
            });
            continue;
          }

          const fingerprint = createMcpLaunchSourceFingerprint(server);
          const status = server.launchResolution?.sourceFingerprint === fingerprint
            ? server.launchResolution.status
            : McpLaunchResolutionStatus.Pending;
          if (
            status === McpLaunchResolutionStatus.Failed
            && launchResolver.shouldStartResolution(server, status)
          ) {
            skippedCount++;
            console.log(
              `[MCP] retrying stdio server "${server.name}" after recoverable managed launch resolution failure`,
            );
            this.ensureLaunchResolution(server.id, 'config-sync:recoverable-failed');
            continue;
          }
          if (
            status === McpLaunchResolutionStatus.Unsupported
            || status === McpLaunchResolutionStatus.Failed
          ) {
            rawCount++;
            if (status === McpLaunchResolutionStatus.Failed) {
              console.warn(
                `[MCP] using raw stdio command for server "${server.name}" because managed launch resolution failed`,
              );
            }
            await pushRawStdioServer(server);
            continue;
          }

          skippedCount++;
          console.log(
            `[MCP] skipping stdio server "${server.name}" while managed launch resolution is ${status}`,
          );
          if (launchResolver.shouldStartResolution(server, status)) {
            this.ensureLaunchResolution(server.id, `config-sync:${status}`);
          }
          continue;
        }

        rawCount++;
        await pushRawStdioServer(server);
      } else {
        if (server.registryId === NeteaseMail.RegistryId) {
          const config = getNeteaseMailOAuthConfig(app.isPackaged);
          const token = this.deps.getMailToken?.(server.id);
          if (!config || !matchesNeteaseMailRegistration(token, config)) continue;
          const include = getNeteaseMailNativeTools(getNeteaseMailScopes(token.scope));
          if (include.length) resolved.push({ id: server.id, name: NeteaseMail.RegistryId, transportType: 'http',
            url: config.mcpUrl, auth: McpAuthMode.OAuth, toolFilter: { include } });
          continue;
        }
        resolved.push({
          id: server.id,
          name: server.name,
          transportType: server.transportType,
          url: server.url,
          headers: server.headers,
          ...(server.auth === McpAuthMode.OAuth ? { auth: McpAuthMode.OAuth } : {}),
          ...passthroughFields(server),
        });
      }
    }

    const askUserCallbackUrl = this.getAskUserCallbackUrl();
    const shouldEnableComputerUse = askUserCallbackUrl !== null
      && isComputerUseKitInstalled(this.deps.getStore())
      && isComputerUseSkillEnabled(this.deps.getStore());
    if (shouldEnableComputerUse) {
      const installResult = await installComputerUseRuntime();
      if (!installResult.success) {
        console.warn(`[MCP] failed to install Computer Use runtime: ${installResult.error || 'unknown error'}`);
      } else {
        try {
          syncComputerUseSkillFromRuntime(this.deps.getStore(), installResult.paths?.skillDir);
        } catch (error) {
          console.warn('[MCP] failed to refresh the Computer Use skill from its runtime:', error);
        }
      }
    }

    const computerUseServer = shouldEnableComputerUse
      ? resolveComputerUseMcpServer({
        askUserCallbackUrl,
        electronNodePath: electronPath,
        hostInfoUrl: this.getHostInfoUrl(),
      })
      : null;
    if (computerUseServer) {
      resolved.push({
        ...computerUseServer,
        requestTimeoutMs: computerUseServer.requestTimeoutMs ?? COMPUTER_USE_MCP_TOOL_CALL_TIMEOUT_MS,
      });
      builtInCount++;
    }

    console.log(
      `[MCP] resolved ${resolved.length}/${enabledServers.length} enabled server(s) for OpenClaw in ${Date.now() - startedAt}ms; optimized=${optimizedCount}, raw=${rawCount}, skipped=${skippedCount}, builtIn=${builtInCount}`,
    );
    return resolved;
  }
}
