import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { app, BrowserWindow, ipcMain, session, shell } from 'electron';
import fs from 'fs';
import http from 'http';
import https from 'https';

import {
  McpAuthMode,
  type McpOAuthActionResult,
  McpOAuthErrorCode,
  McpOAuthState,
  type McpOAuthStatusResult,
} from '../../../shared/mcp/auth';
import { McpIpcChannel } from '../../../shared/mcp/constants';
import {
  McpToolDiscoveryErrorCode,
  type McpToolDiscoveryResult,
} from '../../../shared/mcp/toolDiscovery';
import { normalizeMcpServerUrlInput } from '../../../shared/mcp/url';
import { createAuthRequiredIpcError } from '../../libs/authAccessPolicy';
import {
  DEFAULT_MCP_OAUTH_CLIENT_ID,
  type McpOAuthClientCredentials,
  type McpOAuthManager,
} from '../../mcp/mcpOAuthManager';
import type { McpRuntime } from '../../mcp/mcpRuntime';
import type { McpServerFormData, McpServerRecord } from '../../mcp/mcpStore';
import {
  discoverMcpTools,
  McpToolDiscoveryError,
  McpToolDiscoveryTimeoutMs,
  normalizeMcpToolDiscoveryRequest,
} from '../../mcp/mcpToolDiscovery';
import { startQichachaMcpApiKeyLogin } from '../../mcp/qichachaMcpAuth';

export interface McpHandlerDeps {
  getMcpRuntime: () => McpRuntime;
  syncDshConfig: (options: { reason: string }) => Promise<{ success: boolean; changed: boolean }>;
  getMcpOAuthManager: () => McpOAuthManager | null;
  isAuthGateBlocked?: () => boolean;
}

function isOAuthRemoteServer(server: McpServerRecord | null): server is McpServerRecord {
  return Boolean(server && server.transportType !== 'stdio' && server.auth === McpAuthMode.OAuth);
}

function isMcpOAuthIdentityRemoved(
  existing: McpServerRecord,
  patch: Partial<McpServerFormData>,
): boolean {
  if (patch.auth !== undefined && patch.auth !== McpAuthMode.OAuth) return true;
  if (patch.transportType !== undefined && patch.transportType === 'stdio') return true;
  if (patch.url !== undefined && patch.url !== existing.url) return true;
  return false;
}

const INVALID_URL_ERROR = 'MCP server URL must be an absolute HTTP or HTTPS URL.';
const OAUTH_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const oauthLoginControllers = new Map<string, AbortController>();

function cancelMcpOAuthLogin(id: string): void {
  oauthLoginControllers.get(id)?.abort();
}

export function cancelAllMcpOAuthLogins(): void {
  for (const controller of oauthLoginControllers.values()) controller.abort();
}

async function openAuthorizationUrl(url: string): Promise<void> {
  const protocol = new URL(url).protocol;
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new Error(`Refusing to open ${protocol} URL`);
  }
  await shell.openExternal(url);
}

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 10000 }, res => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => resolve(body));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

const MCP_SYNC_AWAIT_TIMEOUT_MS = 5_000;

/**
 * Serialize MCP config sync calls so rapid create/update/delete/toggle actions
 * never race and overwrite DSH with stale state. Each returned promise settles
 * cleanly without unhandled rejections and caps UI wait time.
 */
export function createSerializedMcpConfigSync(
  syncDshConfig: McpHandlerDeps['syncDshConfig'],
  awaitTimeoutMs = MCP_SYNC_AWAIT_TIMEOUT_MS,
): (reason: string) => Promise<void> {
  let tail: Promise<void> = Promise.resolve();
  return async (reason: string): Promise<void> => {
    const run = tail.then(async () => {
      try {
        const result = await syncDshConfig({ reason });
        if (result && result.success === false) {
          console.warn(`[MCP] config sync reported failure (reason=${reason})`);
        }
      } catch (err) {
        console.error(`[MCP] config sync error (reason=${reason}):`, err);
      }
    });
    tail = run;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        run,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, awaitTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}

const sessionFetch: FetchLike = (url, init) =>
  session.defaultSession.fetch(url instanceof URL ? url.href : url, init);

function normalizeMcpServerInput(data: Partial<McpServerFormData>): Partial<McpServerFormData> {
  if (
    (data.transportType === 'sse' || data.transportType === 'http')
    && data.url !== undefined
  ) {
    const normalized = normalizeMcpServerUrlInput(data.url);
    if (!normalized.ok) {
      throw new Error(INVALID_URL_ERROR);
    }
    return { ...data, url: normalized.url };
  }
  return data;
}

/**
 * Run a browser-based OAuth 2.1 PKCE login flow via an ephemeral loopback HTTP
 * callback listener and exchange the authorization code through `McpOAuthManager`.
 */
export async function runNativeMcpOAuthLogin(options: {
  oauthManager: McpOAuthManager;
  serverId: string;
  serverUrl: string;
  signal: AbortSignal;
  openExternal?: (url: string) => Promise<void>;
  timeoutMs?: number;
}): Promise<void> {
  const { oauthManager, serverId, serverUrl, signal } = options;
  const openExternal = options.openExternal ?? openAuthorizationUrl;
  const timeoutMs = options.timeoutMs ?? OAUTH_LOGIN_TIMEOUT_MS;

  let resolveCallback!: (params: { code: string; state: string }) => void;
  let rejectCallback!: (error: Error) => void;
  const callbackPromise = new Promise<{ code: string; state: string }>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (reqUrl.pathname !== '/oauth/callback') {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const errParam = reqUrl.searchParams.get('error');
    const code = reqUrl.searchParams.get('code');
    const state = reqUrl.searchParams.get('state');
    if (errParam) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body><h3>Authorization failed. You may close this tab.</h3></body></html>');
      rejectCallback(new Error(reqUrl.searchParams.get('error_description') || errParam));
      return;
    }
    if (!code || !state) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body><h3>Missing authorization code or state.</h3></body></html>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body><h3>Authorization complete. You may close this tab and return to LobsterAI.</h3></body></html>');
    resolveCallback({ code, state });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const port = addr && typeof addr !== 'string' ? addr.port : 0;
  const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;

  const onAbort = () => {
    rejectCallback(new Error('CANCELLED'));
  };
  if (signal.aborted) {
    server.close();
    throw new Error('CANCELLED');
  }
  signal.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => {
    rejectCallback(new Error('TIMEOUT'));
  }, timeoutMs);

  try {
    const metadata = await oauthManager.discoverMetadata(serverUrl);
    if (signal.aborted) throw new Error('CANCELLED');

    let clientCredentials: McpOAuthClientCredentials = { clientId: DEFAULT_MCP_OAUTH_CLIENT_ID };
    if (metadata.registrationEndpoint) {
      clientCredentials = await oauthManager.registerDynamicClient({
        registrationEndpoint: metadata.registrationEndpoint,
        redirectUri,
        scope: metadata.defaultScope,
      });
      if (signal.aborted) throw new Error('CANCELLED');
    }

    const pkce = oauthManager.beginPkceFlow({
      serverId,
      metadata,
      redirectUri,
      clientId: clientCredentials.clientId,
      clientSecret: clientCredentials.clientSecret,
      tokenEndpointAuthMethod: clientCredentials.tokenEndpointAuthMethod,
      scope: metadata.defaultScope,
      resource: metadata.resource,
    });
    await openExternal(pkce.authorizationUrl);
    const { code, state } = await callbackPromise;
    await oauthManager.completePkceFlow(state, code);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', onAbort);
    server.close();
  }
}

const QICHACHA_REGISTRY_ID = 'qichacha';

const QICHACHA_MCP_SERVERS: Array<{
  name: string;
  description: string;
  url: string;
}> = [
  {
    name: 'qcc-company',
    description: 'Qichacha company data MCP server',
    url: 'https://agent.qcc.com/mcp/company/stream',
  },
  {
    name: 'qcc-risk',
    description: 'Qichacha risk data MCP server',
    url: 'https://agent.qcc.com/mcp/risk/stream',
  },
  {
    name: 'qcc-ipr',
    description: 'Qichacha intellectual property data MCP server',
    url: 'https://agent.qcc.com/mcp/ipr/stream',
  },
  {
    name: 'qcc-operation',
    description: 'Qichacha operation data MCP server',
    url: 'https://agent.qcc.com/mcp/operation/stream',
  },
  {
    name: 'qcc-executive',
    description: 'Qichacha executive data MCP server',
    url: 'https://agent.qcc.com/mcp/executive/stream',
  },
  {
    name: 'qcc-history',
    description: 'Qichacha historical archive data MCP server',
    url: 'https://agent.qcc.com/mcp/history/stream',
  },
];

function buildQichachaServerData(
  server: typeof QICHACHA_MCP_SERVERS[number],
  apiKey: string,
): McpServerFormData {
  return {
    name: server.name,
    description: server.description,
    transportType: 'http',
    url: server.url,
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    isBuiltIn: true,
    registryId: QICHACHA_REGISTRY_ID,
  };
}

export function registerMcpHandlers(deps: McpHandlerDeps): void {
  const { getMcpRuntime, syncDshConfig, getMcpOAuthManager } = deps;
  const syncMcpConfig = createSerializedMcpConfigSync(syncDshConfig);

  const clearOAuthCredentials = (server: McpServerRecord): void => {
    cancelMcpOAuthLogin(server.id);
    getMcpOAuthManager()?.deleteToken(server.id);
  };

  ipcMain.handle(McpIpcChannel.List, () => {
    try {
      const servers = getMcpRuntime().getDisplayServers();
      return { success: true, servers };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list MCP servers',
      };
    }
  });

  ipcMain.handle(
    McpIpcChannel.Create,
    async (
      _event,
      data: {
        name: string;
        description: string;
        transportType: string;
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        url?: string;
        headers?: Record<string, string>;
        auth?: McpServerFormData['auth'];
        tokenValues?: Record<string, string>;
        toolFilter?: McpServerFormData['toolFilter'];
        supportsParallelToolCalls?: boolean;
        requestTimeoutMs?: number;
        connectionTimeoutMs?: number;
      },
    ) => {
      try {
        if (deps.isAuthGateBlocked?.()) return createAuthRequiredIpcError();
        const mcpRuntime = getMcpRuntime();
        const normalizedData = normalizeMcpServerInput(data as McpServerFormData) as McpServerFormData;
        const server = mcpRuntime.getStore().createServer(normalizedData);
        if (server.enabled) {
          mcpRuntime.ensureLaunchResolution(server.id, 'mcp-server-created');
        }
        await syncMcpConfig('mcp-server-created');
        return { success: true, servers: mcpRuntime.getDisplayServers() };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to create MCP server',
        };
      }
    },
  );

  ipcMain.handle(
    McpIpcChannel.Update,
    async (
      _event,
      id: string,
      data: {
        name?: string;
        description?: string;
        transportType?: string;
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        url?: string;
        headers?: Record<string, string>;
        auth?: McpServerFormData['auth'];
        tokenValues?: Record<string, string>;
        toolFilter?: McpServerFormData['toolFilter'];
        supportsParallelToolCalls?: boolean;
        requestTimeoutMs?: number;
        connectionTimeoutMs?: number;
      },
    ) => {
      try {
        if (deps.isAuthGateBlocked?.()) return createAuthRequiredIpcError();
        const mcpRuntime = getMcpRuntime();
        const normalizedData = normalizeMcpServerInput(data as Partial<McpServerFormData>);
        const existing = mcpRuntime.getStore().getServer(id);
        if (isOAuthRemoteServer(existing) && isMcpOAuthIdentityRemoved(existing, normalizedData)) {
          clearOAuthCredentials(existing);
        }
        const server = mcpRuntime.getStore().updateServer(id, normalizedData);
        if (server?.enabled) {
          mcpRuntime.ensureLaunchResolution(server.id, 'mcp-server-updated');
        }
        await syncMcpConfig('mcp-server-updated');
        return { success: true, servers: mcpRuntime.getDisplayServers() };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update MCP server',
        };
      }
    },
  );

  ipcMain.handle(McpIpcChannel.Delete, async (_event, id: string) => {
    if (deps.isAuthGateBlocked?.()) return createAuthRequiredIpcError();
    try {
      const mcpRuntime = getMcpRuntime();
      const existing = mcpRuntime.getStore().getServer(id);
      if (isOAuthRemoteServer(existing)) clearOAuthCredentials(existing);
      mcpRuntime.getStore().deleteServer(id);
      await syncMcpConfig('mcp-server-deleted');
      return { success: true, servers: mcpRuntime.getDisplayServers() };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete MCP server',
      };
    }
  });

  ipcMain.handle(McpIpcChannel.DeleteByRegistryId, async (_event, registryId: string) => {
    if (deps.isAuthGateBlocked?.()) return createAuthRequiredIpcError();
    try {
      const normalizedRegistryId = registryId.trim();
      if (!normalizedRegistryId) {
        throw new Error('MCP registry id is required');
      }
      const mcpRuntime = getMcpRuntime();
      const store = mcpRuntime.getStore();
      const matchingServers = store
        .listServers()
        .filter(server => server.registryId === normalizedRegistryId);
      for (const server of matchingServers) {
        if (isOAuthRemoteServer(server)) clearOAuthCredentials(server);
        store.deleteServer(server.id);
      }
      await syncMcpConfig('mcp-registry-deleted');
      return { success: true, servers: mcpRuntime.getDisplayServers() };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete MCP registry servers',
      };
    }
  });

  ipcMain.handle(McpIpcChannel.SetEnabled, async (_event, options: { id: string; enabled: boolean }) => {
    if (deps.isAuthGateBlocked?.()) return createAuthRequiredIpcError();
    try {
      const mcpRuntime = getMcpRuntime();
      mcpRuntime.getStore().setEnabled(options.id, options.enabled);
      if (options.enabled) {
        mcpRuntime.ensureLaunchResolution(options.id, 'mcp-server-enabled');
      } else {
        cancelMcpOAuthLogin(options.id);
      }
      await syncMcpConfig('mcp-server-toggled');
      return { success: true, servers: mcpRuntime.getDisplayServers() };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update MCP server',
      };
    }
  });

  ipcMain.handle(
    McpIpcChannel.SetEnabledByRegistryId,
    async (_event, options: { registryId: string; enabled: boolean }) => {
      if (deps.isAuthGateBlocked?.()) return createAuthRequiredIpcError();
      try {
        const normalizedRegistryId = options.registryId.trim();
        if (!normalizedRegistryId) {
          throw new Error('MCP registry id is required');
        }
        const mcpRuntime = getMcpRuntime();
        const store = mcpRuntime.getStore();
        const matchingServers = store
          .listServers()
          .filter(server => server.registryId === normalizedRegistryId);
        for (const server of matchingServers) {
          store.setEnabled(server.id, options.enabled);
          if (options.enabled) {
            mcpRuntime.ensureLaunchResolution(server.id, 'mcp-registry-enabled');
          } else {
            cancelMcpOAuthLogin(server.id);
          }
        }
        await syncMcpConfig('mcp-registry-toggled');
        return { success: true, servers: mcpRuntime.getDisplayServers() };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update MCP registry servers',
        };
      }
    },
  );

  ipcMain.handle(McpIpcChannel.RetryLaunchResolution, async (_event, id: string) => {
    try {
      const mcpRuntime = getMcpRuntime();
      await mcpRuntime.getLaunchResolverManager().retry(id);
      await syncMcpConfig('mcp-launch-manual-retry');
      return { success: true, servers: mcpRuntime.getDisplayServers() };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to retry MCP launch resolution',
      };
    }
  });

  ipcMain.handle(
    McpIpcChannel.ListTools,
    async (_event, rawRequest: unknown): Promise<McpToolDiscoveryResult> => {
      const request = normalizeMcpToolDiscoveryRequest(rawRequest);
      if (typeof request === 'string') {
        return { success: false, code: McpToolDiscoveryErrorCode.InvalidRequest, error: request };
      }
      const startedAt = Date.now();
      const timeoutMs = request.transportType === 'stdio'
        ? McpToolDiscoveryTimeoutMs.Stdio
        : McpToolDiscoveryTimeoutMs.Remote;
      try {
        const launch = await getMcpRuntime().resolveToolDiscoveryLaunch(request);
        if (launch.transportType !== 'stdio' && request.serverId) {
          const saved = getMcpRuntime().getStore().getServer(request.serverId);
          if (isOAuthRemoteServer(saved)) {
            const authHeaders = await getMcpOAuthManager()
              ?.resolveAuthorizationHeaders(saved.id)
              .catch((): null => null);
            if (authHeaders) {
              const mergedHeaders: Record<string, string> = { ...(launch.headers ?? {}) };
              for (const key of Object.keys(mergedHeaders)) {
                if (key.toLowerCase() === 'authorization') {
                  delete mergedHeaders[key];
                }
              }
              launch.headers = { ...mergedHeaders, ...authHeaders };
            }
          }
        }
        const tools = await discoverMcpTools(launch, {
          timeoutMs,
          fetch: sessionFetch,
          clientVersion: app.getVersion(),
        });
        const durationMs = Date.now() - startedAt;
        console.log(`[MCP] listed ${tools.length} tool(s) from "${request.name}" (${request.transportType}) in ${durationMs}ms`);
        return { success: true, tools, durationMs };
      } catch (error) {
        const failure = error instanceof McpToolDiscoveryError
          ? error
          : new McpToolDiscoveryError(
            McpToolDiscoveryErrorCode.Failed,
            error instanceof Error ? error.message : String(error),
          );
        console.warn(
          `[MCP] tool discovery failed for "${request.name}" (${request.transportType}, ${failure.code}) after ${Date.now() - startedAt}ms: ${failure.message.split('\n')[0].slice(0, 300)}`,
        );
        return {
          success: false,
          code: failure.code,
          error: failure.message,
          ...(failure.timeoutMs ? { timeoutMs: failure.timeoutMs } : {}),
        };
      }
    },
  );

  ipcMain.handle(McpIpcChannel.ConnectQichacha, async (event) => {
    try {
      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      const apiKey = await startQichachaMcpApiKeyLogin(ownerWindow);
      const mcpRuntime = getMcpRuntime();
      const store = mcpRuntime.getStore();
      const existingServers = store.listServers();

      for (const qichachaServer of QICHACHA_MCP_SERVERS) {
        const data = buildQichachaServerData(qichachaServer, apiKey);
        const existing = existingServers.find(server =>
          server.registryId === QICHACHA_REGISTRY_ID
          && server.name === qichachaServer.name,
        );
        if (existing) {
          store.updateServer(existing.id, data);
        } else {
          store.createServer(data);
        }
      }

      const servers = store.listServers();
      await syncMcpConfig('qichacha-mcp-connected');
      return { success: true, servers };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to connect Qichacha MCP',
      };
    }
  });

  ipcMain.handle(McpIpcChannel.OAuthLogin, async (_event, id: string): Promise<McpOAuthActionResult> => {
    const server = getMcpRuntime().getStore().getServer(id);
    if (!isOAuthRemoteServer(server)) {
      return { success: false, code: McpOAuthErrorCode.NotOAuthServer, error: 'This MCP server does not use OAuth.' };
    }
    if (!server.enabled) {
      return { success: false, code: McpOAuthErrorCode.Failed, error: 'Enable the MCP server before signing in.' };
    }
    if (!server.url) {
      return { success: false, code: McpOAuthErrorCode.Failed, error: INVALID_URL_ERROR };
    }
    const oauthManager = getMcpOAuthManager();
    if (!oauthManager) {
      return { success: false, code: McpOAuthErrorCode.RuntimeUnavailable, error: 'MCP OAuth manager is not initialized.' };
    }
    if (oauthLoginControllers.has(id)) {
      return {
        success: false,
        code: McpOAuthErrorCode.AlreadyInProgress,
        error: 'Sign-in is already in progress for this server.',
      };
    }
    const controller = new AbortController();
    oauthLoginControllers.set(id, controller);
    try {
      await runNativeMcpOAuthLogin({
        oauthManager,
        serverId: server.id,
        serverUrl: server.url,
        signal: controller.signal,
      });
      await syncMcpConfig('mcp-oauth-authorized');
      return { success: true, state: McpOAuthState.Authorized };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg === 'CANCELLED') {
        return { success: false, code: McpOAuthErrorCode.Cancelled, error: 'Sign-in cancelled.' };
      }
      if (msg === 'TIMEOUT') {
        return { success: false, code: McpOAuthErrorCode.Timeout, error: 'OAuth sign-in timed out.' };
      }
      console.warn('[MCP] OAuth sign-in failed:', msg);
      return { success: false, code: McpOAuthErrorCode.Failed, error: msg };
    } finally {
      oauthLoginControllers.delete(id);
    }
  });

  ipcMain.handle(McpIpcChannel.OAuthCancel, (_event, id: string): boolean => {
    const controller = oauthLoginControllers.get(id);
    if (!controller) return false;
    controller.abort();
    return true;
  });

  ipcMain.handle(McpIpcChannel.OAuthLogout, async (_event, id: string): Promise<McpOAuthActionResult> => {
    const server = getMcpRuntime().getStore().getServer(id);
    if (!isOAuthRemoteServer(server)) {
      return { success: false, code: McpOAuthErrorCode.NotOAuthServer, error: 'This MCP server does not use OAuth.' };
    }
    const oauthManager = getMcpOAuthManager();
    if (!oauthManager) {
      return { success: false, code: McpOAuthErrorCode.RuntimeUnavailable, error: 'MCP OAuth manager is not initialized.' };
    }
    cancelMcpOAuthLogin(server.id);
    oauthManager.deleteToken(server.id);
    await syncMcpConfig('mcp-oauth-logout');
    return { success: true, state: McpOAuthState.RequiresAuthorization };
  });

  ipcMain.handle(McpIpcChannel.OAuthStatus, async (): Promise<McpOAuthStatusResult> => {
    const servers = getMcpRuntime().getStore().listServers().filter(isOAuthRemoteServer);
    if (servers.length === 0) return { success: true, states: {} };
    const oauthManager = getMcpOAuthManager();
    const states: Record<string, McpOAuthState> = {};
    let refreshedAny = false;
    for (const server of servers) {
      if (!server.enabled || !oauthManager) {
        states[server.id] = McpOAuthState.Unknown;
        continue;
      }
      const status = await oauthManager.checkAuthorizationStatus(server.id);
      if (status.refreshed) refreshedAny = true;
      states[server.id] = status.authorized
        ? McpOAuthState.Authorized
        : McpOAuthState.RequiresAuthorization;
    }
    if (refreshedAny) {
      await syncMcpConfig('mcp-oauth-refreshed');
    }
    return { success: true, states };
  });

  ipcMain.handle(McpIpcChannel.FetchMarketplace, async () => {
    const localCatalogPath = app.isPackaged ? '' : process.env.LOBSTERAI_MCP_MARKETPLACE_FILE?.trim();
    if (localCatalogPath) {
      try {
        const marketplace = JSON.parse(await fs.promises.readFile(localCatalogPath, 'utf8'));
        console.log('[MCP] using local marketplace catalog from LOBSTERAI_MCP_MARKETPLACE_FILE');
        return { success: true, data: marketplace };
      } catch (error) {
        console.error('[MCP] failed to read LOBSTERAI_MCP_MARKETPLACE_FILE:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Failed to read local marketplace' };
      }
    }
    const url = app.isPackaged
      ? 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/mcp-marketplace'
      : 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/test/mcp-marketplace';
    try {
      const data = await fetchText(url);
      const json = JSON.parse(data);
      const value = json?.data?.value;
      if (!value) {
        return { success: false, error: 'Invalid response: missing data.value' };
      }
      const marketplace = typeof value === 'string' ? JSON.parse(value) : value;
      return { success: true, data: marketplace };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch marketplace',
      };
    }
  });
}
