import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { app, BrowserWindow, ipcMain, session, shell } from 'electron';
import fs from 'fs';
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
import { OpenClawConfigImpact } from '../../libs/openclawConfigImpact';
import { buildOpenClawMcpServers, safeServerKey } from '../../libs/openclawConfigSync';
import {
  clearMcpOAuthCredentialsBestEffort,
  isMcpOAuthIdentityRemoved,
  type McpOAuthCliContext,
  McpOAuthCliError,
  type McpOAuthCliServer,
  readMcpOAuthStatuses,
  runMcpOAuthLogin,
  runMcpOAuthLogout,
} from '../../mcp/mcpOAuthCli';
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
  syncOpenClawConfig: (options: {
    reason: string;
    restartGatewayIfRunning?: boolean;
    expectedImpact?: OpenClawConfigImpact;
  }) => Promise<{ success: boolean; changed: boolean }>;
  /** Paths for running `openclaw mcp …`; null when the runtime is not installed. */
  getOAuthCliContext: () => McpOAuthCliContext | null;
}

function isOAuthRemoteServer(server: McpServerRecord | null): server is McpServerRecord {
  return Boolean(server && server.transportType !== 'stdio' && server.auth === McpAuthMode.OAuth);
}

/**
 * The server's openclaw.json entry, built the way config sync writes it, for the
 * CLI's own config. Null when the stored URL is not valid (config sync skips it too).
 */
function toOAuthCliServer(server: McpServerRecord): McpOAuthCliServer | null {
  const key = safeServerKey(server.name);
  const entry = buildOpenClawMcpServers([{
    name: server.name,
    transportType: server.transportType,
    url: server.url,
    headers: server.headers,
    auth: McpAuthMode.OAuth,
  }])[key];
  return entry ? { key, entry } : null;
}

const INVALID_URL_ERROR = 'MCP server URL must be an absolute HTTP or HTTPS URL.';

// In-flight sign-ins by server id. Aborting one kills its `openclaw mcp login`,
// which also frees the loopback callback port.
const oauthLoginControllers = new Map<string, AbortController>();

function cancelMcpOAuthLogin(id: string): void {
  oauthLoginControllers.get(id)?.abort();
}

/** Called on app quit so no `openclaw mcp login` outlives the app holding 127.0.0.1:8989. */
export function cancelAllMcpOAuthLogins(): void {
  for (const controller of oauthLoginControllers.values()) controller.abort();
}

function toOAuthFailure(error: unknown, fallback: string): McpOAuthActionResult {
  if (error instanceof McpOAuthCliError) return { success: false, code: error.code, error: error.message };
  return { success: false, code: McpOAuthErrorCode.Failed, error: error instanceof Error ? error.message : fallback };
}

// Only http(s) authorization URLs reach the system browser.
async function openAuthorizationUrl(url: string): Promise<void> {
  const protocol = new URL(url).protocol;
  if (protocol !== 'https:' && protocol !== 'http:') throw new Error(`Refusing to open ${protocol} URL`);
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

function syncMcpConfig(
  syncOpenClawConfig: McpHandlerDeps['syncOpenClawConfig'],
  reason: string,
): void {
  syncOpenClawConfig({
    reason,
    expectedImpact: OpenClawConfigImpact.Sync,
  }).catch(err =>
    console.error('[MCP] config sync error:', err),
  );
}

// Remote MCP probes follow the app's proxy settings, like other main-process fetches.
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
  const { getMcpRuntime, syncOpenClawConfig, getOAuthCliContext } = deps;

  /**
   * Signs out before a server's OAuth identity goes away (delete, rename, URL or
   * auth change), enabled or not, so its tokens neither linger in OpenClaw's
   * state nor come back when the same server is added again.
   */
  const clearOAuthCredentials = async (server: McpServerRecord): Promise<void> => {
    cancelMcpOAuthLogin(server.id);
    const context = getOAuthCliContext();
    const cliServer = toOAuthCliServer(server);
    if (!context || !cliServer) return;
    await clearMcpOAuthCredentialsBestEffort({ context, server: cliServer });
  };

  ipcMain.handle(McpIpcChannel.List, () => {
    try {
      const servers = getMcpRuntime().getStore().listServers();
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
        const mcpRuntime = getMcpRuntime();
        const normalizedData = normalizeMcpServerInput(data as McpServerFormData) as McpServerFormData;
        const server = mcpRuntime.getStore().createServer(normalizedData);
        if (server.enabled) {
          mcpRuntime.ensureLaunchResolution(server.id, 'mcp-server-created');
        }
        const servers = mcpRuntime.getStore().listServers();
        syncMcpConfig(syncOpenClawConfig, 'mcp-server-created');
        return { success: true, servers };
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
        const mcpRuntime = getMcpRuntime();
        const normalizedData = normalizeMcpServerInput(data as Partial<McpServerFormData>);
        const existing = mcpRuntime.getStore().getServer(id);
        if (isOAuthRemoteServer(existing) && isMcpOAuthIdentityRemoved(existing, normalizedData)) {
          await clearOAuthCredentials(existing);
        }
        const server = mcpRuntime.getStore().updateServer(id, normalizedData);
        if (server?.enabled) {
          mcpRuntime.ensureLaunchResolution(server.id, 'mcp-server-updated');
        }
        const servers = mcpRuntime.getStore().listServers();
        syncMcpConfig(syncOpenClawConfig, 'mcp-server-updated');
        return { success: true, servers };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update MCP server',
        };
      }
    },
  );

  ipcMain.handle(McpIpcChannel.Delete, async (_event, id: string) => {
    try {
      const mcpRuntime = getMcpRuntime();
      const existing = mcpRuntime.getStore().getServer(id);
      if (isOAuthRemoteServer(existing)) await clearOAuthCredentials(existing);
      mcpRuntime.getStore().deleteServer(id);
      const servers = mcpRuntime.getStore().listServers();
      syncMcpConfig(syncOpenClawConfig, 'mcp-server-deleted');
      return { success: true, servers };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete MCP server',
      };
    }
  });

  ipcMain.handle(McpIpcChannel.DeleteByRegistryId, async (_event, registryId: string) => {
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
        if (isOAuthRemoteServer(server)) await clearOAuthCredentials(server);
        store.deleteServer(server.id);
      }
      const servers = store.listServers();
      syncMcpConfig(syncOpenClawConfig, 'mcp-registry-deleted');
      return { success: true, servers };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete MCP registry servers',
      };
    }
  });

  ipcMain.handle(McpIpcChannel.SetEnabled, async (_event, options: { id: string; enabled: boolean }) => {
    try {
      const mcpRuntime = getMcpRuntime();
      mcpRuntime.getStore().setEnabled(options.id, options.enabled);
      if (options.enabled) {
        mcpRuntime.ensureLaunchResolution(options.id, 'mcp-server-enabled');
      } else {
        // A disabled server shows no sign-in, so do not leave one waiting on the browser.
        cancelMcpOAuthLogin(options.id);
      }
      const servers = mcpRuntime.getStore().listServers();
      syncMcpConfig(syncOpenClawConfig, 'mcp-server-toggled');
      return { success: true, servers };
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
        const servers = store.listServers();
        syncMcpConfig(syncOpenClawConfig, 'mcp-registry-toggled');
        return { success: true, servers };
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
      const servers = mcpRuntime.getStore().listServers();
      syncMcpConfig(syncOpenClawConfig, 'mcp-launch-manual-retry');
      return { success: true, servers };
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
        // First line only: the rest is the server's stderr, which may echo secrets.
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
      syncMcpConfig(syncOpenClawConfig, 'qichacha-mcp-connected');
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
    const context = getOAuthCliContext();
    if (!context) {
      return { success: false, code: McpOAuthErrorCode.RuntimeUnavailable, error: 'OpenClaw runtime is not ready.' };
    }
    const cliServer = toOAuthCliServer(server);
    if (!cliServer) return { success: false, code: McpOAuthErrorCode.Failed, error: INVALID_URL_ERROR };
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
      // The CLI runs against its own config, so this needs neither a configured
      // model nor the gateway to have loaded the just-saved server yet. The token
      // is keyed by name + URL, so the gateway uses it once its config lists the server.
      await runMcpOAuthLogin({ context, server: cliServer, openExternal: openAuthorizationUrl, signal: controller.signal });
      return { success: true, state: McpOAuthState.Authorized };
    } catch (error) {
      if (!(error instanceof McpOAuthCliError && error.code === McpOAuthErrorCode.Cancelled)) {
        console.warn('[MCP] OAuth sign-in failed:', error instanceof Error ? error.message : error);
      }
      return toOAuthFailure(error, 'Failed to sign in to the MCP server');
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
    const context = getOAuthCliContext();
    if (!context) {
      return { success: false, code: McpOAuthErrorCode.RuntimeUnavailable, error: 'OpenClaw runtime is not ready.' };
    }
    // Disabled servers show no OAuth state (see OAuthStatus), so there is nothing to sign out of.
    if (!server.enabled) {
      return { success: false, code: McpOAuthErrorCode.ServerNotLoaded, error: 'Enable the MCP server before signing out.' };
    }
    const cliServer = toOAuthCliServer(server);
    if (!cliServer) return { success: false, code: McpOAuthErrorCode.Failed, error: INVALID_URL_ERROR };
    try {
      await runMcpOAuthLogout({ context, server: cliServer });
      return { success: true, state: McpOAuthState.RequiresAuthorization };
    } catch (error) {
      return toOAuthFailure(error, 'Failed to sign out of the MCP server');
    }
  });

  ipcMain.handle(McpIpcChannel.OAuthStatus, async (): Promise<McpOAuthStatusResult> => {
    const servers = getMcpRuntime().getStore().listServers().filter(isOAuthRemoteServer);
    if (servers.length === 0) return { success: true, states: {} };
    // Disabled servers are not loaded by OpenClaw, so they show no OAuth state.
    const cliServers = servers
      .filter(server => server.enabled)
      .map(toOAuthCliServer)
      .filter((server): server is McpOAuthCliServer => server !== null);
    let byKey: Record<string, McpOAuthState> = {};
    if (cliServers.length > 0) {
      const context = getOAuthCliContext();
      if (!context) return { success: false, error: 'OpenClaw runtime is not ready.' };
      try {
        byKey = await readMcpOAuthStatuses({ context, servers: cliServers });
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to read MCP OAuth status' };
      }
    }
    const states = Object.fromEntries(
      servers.map(server => [
        server.id,
        server.enabled ? byKey[safeServerKey(server.name)] ?? McpOAuthState.Unknown : McpOAuthState.Unknown,
      ]),
    );
    return { success: true, states };
  });

  ipcMain.handle(McpIpcChannel.FetchMarketplace, async () => {
    // Development only: preview catalog edits (e.g. new connectors) from a local
    // file shaped like the server's data.value, before ops publishes them.
    const localCatalogPath = app.isPackaged ? '' : process.env.LOBSTERAI_MCP_MARKETPLACE_FILE?.trim();
    if (localCatalogPath) {
      try {
        const marketplace = JSON.parse(await fs.promises.readFile(localCatalogPath, 'utf8'));
        console.log(`[MCP] using local marketplace catalog from LOBSTERAI_MCP_MARKETPLACE_FILE`);
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
