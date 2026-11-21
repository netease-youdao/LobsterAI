import http from 'http';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { McpAuthMode, McpOAuthState } from '../../../shared/mcp/auth';
import { McpIpcChannel } from '../../../shared/mcp/constants';
import {
  DEFAULT_MCP_OAUTH_CLIENT_ID,
  type McpOAuthFetch,
  McpOAuthManager,
} from '../../mcp/mcpOAuthManager';
import type { McpServerRecord } from '../../mcp/mcpStore';

const registeredHandlers = new Map<string, (...args: unknown[]) => unknown>();
const openExternalMock = vi.fn(async (_url: string) => undefined);

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.0.0',
    isPackaged: false,
  },
  BrowserWindow: {
    fromWebContents: () => null,
    getAllWindows: () => [],
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, handler);
    },
  },
  session: {
    defaultSession: {
      fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
    },
  },
  shell: {
    openExternal: (url: string) => openExternalMock(url),
  },
}));

import { createSerializedMcpConfigSync, registerMcpHandlers } from './handlers';

describe('createSerializedMcpConfigSync', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('serializes overlapping toggle calls in strict FIFO order without stale races', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const syncDshConfig = vi.fn(async ({ reason }: { reason: string }) => {
      order.push(`start:${reason}`);
      if (reason === 'toggle-off') {
        await firstGate;
      }
      order.push(`end:${reason}`);
      return { success: true, changed: true };
    });

    const syncMcpConfig = createSerializedMcpConfigSync(syncDshConfig, 5_000);
    const first = syncMcpConfig('toggle-off');
    const second = syncMcpConfig('toggle-on');

    await Promise.resolve();
    expect(order).toEqual(['start:toggle-off']);

    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual([
      'start:toggle-off',
      'end:toggle-off',
      'start:toggle-on',
      'end:toggle-on',
    ]);
  });

  test('swallows and logs sync errors without unhandled rejections and stays bounded on slow syncs', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    const syncDshConfig = vi.fn(async ({ reason }: { reason: string }) => {
      if (reason === 'throws') throw new Error('boom');
      if (reason === 'fails') return { success: false, changed: false };
      if (reason === 'slow') {
        await slowGate;
        return { success: true, changed: true };
      }
      return { success: true, changed: true };
    });

    const syncMcpConfig = createSerializedMcpConfigSync(syncDshConfig, 25);
    await expect(syncMcpConfig('throws')).resolves.toBeUndefined();
    await expect(syncMcpConfig('fails')).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    const started = Date.now();
    await expect(syncMcpConfig('slow')).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(500);

    // Cleanly settle background slow promise.
    releaseSlow();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});

function createMemoryStorage() {
  const map = new Map<string, string>();
  return {
    get: (k: string) => map.get(k) ?? null,
    set: (k: string, v: string) => {
      map.set(k, v);
    },
    delete: (k: string) => {
      map.delete(k);
    },
  };
}

function makeOAuthServer(overrides: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    id: 'srv-uuid-oauth-1',
    name: 'Linear',
    description: 'Linear MCP',
    enabled: true,
    transportType: 'http',
    url: 'https://mcp.linear.example/mcp',
    auth: McpAuthMode.OAuth,
    isBuiltIn: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('registerMcpHandlers OAuth IPC', () => {
  beforeEach(() => {
    registeredHandlers.clear();
    openExternalMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('OAuthLogin runs DCR + PKCE loopback callback and awaits syncDshConfig before resolving', async () => {
    let clock = 1_000_000;
    let dcrCalled = false;
    const fetcher = vi.fn<McpOAuthFetch>(async (url, init) => {
      if (url === 'https://mcp.linear.example/.well-known/oauth-protected-resource/mcp') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            resource: 'https://mcp.linear.example/mcp',
            authorization_servers: ['https://auth.linear.example/v1'],
          }),
          text: async () => '',
        };
      }
      if (url === 'https://auth.linear.example/.well-known/oauth-authorization-server/v1') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            authorization_endpoint: 'https://auth.linear.example/v1/authorize',
            token_endpoint: 'https://auth.linear.example/v1/token',
            registration_endpoint: 'https://auth.linear.example/v1/register',
          }),
          text: async () => '',
        };
      }
      if (url === 'https://auth.linear.example/v1/register' && init?.method === 'POST') {
        dcrCalled = true;
        return {
          ok: true,
          status: 201,
          json: async () => ({
            client_id: 'dcr-linear-id',
            client_secret: 'dcr-linear-secret',
          }),
          text: async () => '',
        };
      }
      if (url === 'https://auth.linear.example/v1/token' && init?.method === 'POST') {
        const params = new URLSearchParams(init.body ?? '');
        expect(params.get('client_id')).toBe('dcr-linear-id');
        expect(params.get('client_secret')).toBe('dcr-linear-secret');
        expect(params.get('resource')).toBe('https://mcp.linear.example/mcp');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'access-linear-1',
            refresh_token: 'refresh-linear-1',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
          text: async () => '',
        };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
    });

    const serverRecord = makeOAuthServer();
    const oauthManager = new McpOAuthManager({
      storage: createMemoryStorage(),
      fetcher,
      now: () => clock,
    });

    // Simulate browser completing redirect back to the loopback listener.
    openExternalMock.mockImplementation(async (authUrl: string) => {
      const parsed = new URL(authUrl);
      const redirectUri = parsed.searchParams.get('redirect_uri')!;
      const state = parsed.searchParams.get('state')!;
      expect(parsed.searchParams.get('client_id')).toBe('dcr-linear-id');
      expect(parsed.searchParams.get('resource')).toBe('https://mcp.linear.example/mcp');
      const callbackUrl = `${redirectUri}?code=test-auth-code&state=${encodeURIComponent(state)}`;
      await new Promise<void>((resolve, reject) => {
        http.get(callbackUrl, (res) => {
          res.resume();
          res.on('end', () => resolve());
        }).on('error', reject);
      });
    });

    let resolveSync!: () => void;
    let syncCompleted = false;
    const syncDshConfig = vi.fn(
      () => new Promise<{ success: boolean; changed: boolean }>((resolve) => {
        resolveSync = () => {
          syncCompleted = true;
          resolve({ success: true, changed: true });
        };
      }),
    );

    registerMcpHandlers({
      getMcpRuntime: () => ({
        getStore: () => ({
          getServer: (id: string) => (id === serverRecord.id ? serverRecord : null),
          listServers: () => [serverRecord],
        }),
      }) as never,
      syncDshConfig,
      getMcpOAuthManager: () => oauthManager,
    });

    const loginHandler = registeredHandlers.get(McpIpcChannel.OAuthLogin)!;
    let loginResolved = false;
    const loginPromise = (loginHandler({}, serverRecord.id) as Promise<unknown>).then((res) => {
      loginResolved = true;
      return res;
    });

    // Wait until syncDshConfig has been called.
    await vi.waitFor(() => {
      expect(syncDshConfig).toHaveBeenCalledWith({ reason: 'mcp-oauth-authorized' });
    });

    // Login IPC must NOT resolve before syncDshConfig completes!
    expect(dcrCalled).toBe(true);
    expect(syncCompleted).toBe(false);
    expect(loginResolved).toBe(false);

    resolveSync();
    const loginResult = await loginPromise;
    expect(syncCompleted).toBe(true);
    expect(loginResult).toEqual({ success: true, state: McpOAuthState.Authorized });
    expect(oauthManager.getToken(serverRecord.id)?.accessToken).toBe('access-linear-1');
    clock += 1;
  });

  test('OAuthLogin falls back to lobsterai-desktop when registrationEndpoint is absent', async () => {
    const fetcher = vi.fn<McpOAuthFetch>(async (url, init) => {
      if (url === 'https://mcp.nodcr.example/.well-known/oauth-authorization-server') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            authorization_endpoint: 'https://mcp.nodcr.example/authorize',
            token_endpoint: 'https://mcp.nodcr.example/token',
          }),
          text: async () => '',
        };
      }
      if (url === 'https://mcp.nodcr.example/token' && init?.method === 'POST') {
        const params = new URLSearchParams(init.body ?? '');
        expect(params.get('client_id')).toBe(DEFAULT_MCP_OAUTH_CLIENT_ID);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'tok-static-client',
            token_type: 'Bearer',
            expires_in: 600,
          }),
          text: async () => '',
        };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
    });

    const serverRecord = makeOAuthServer({
      id: 'srv-nodcr',
      url: 'https://mcp.nodcr.example/mcp',
    });
    const oauthManager = new McpOAuthManager({
      storage: createMemoryStorage(),
      fetcher,
    });

    openExternalMock.mockImplementation(async (authUrl: string) => {
      const parsed = new URL(authUrl);
      expect(parsed.searchParams.get('client_id')).toBe(DEFAULT_MCP_OAUTH_CLIENT_ID);
      const callbackUrl = `${parsed.searchParams.get('redirect_uri')}?code=c1&state=${encodeURIComponent(parsed.searchParams.get('state')!)}`;
      await new Promise<void>((resolve, reject) => {
        http.get(callbackUrl, (res) => {
          res.resume();
          res.on('end', () => resolve());
        }).on('error', reject);
      });
    });

    registerMcpHandlers({
      getMcpRuntime: () => ({
        getStore: () => ({
          getServer: (id: string) => (id === serverRecord.id ? serverRecord : null),
          listServers: () => [serverRecord],
        }),
      }) as never,
      syncDshConfig: vi.fn(async () => ({ success: true, changed: true })),
      getMcpOAuthManager: () => oauthManager,
    });

    const loginHandler = registeredHandlers.get(McpIpcChannel.OAuthLogin)!;
    const res = await loginHandler({}, serverRecord.id);
    expect(res).toEqual({ success: true, state: McpOAuthState.Authorized });
  });

  test('OAuthLogout deletes token and awaits syncDshConfig before resolving', async () => {
    const serverRecord = makeOAuthServer();
    const oauthManager = new McpOAuthManager({ storage: createMemoryStorage() });
    oauthManager.saveToken({
      serverId: serverRecord.id,
      accessToken: 'tok-to-revoke',
      tokenType: 'Bearer',
      updatedAt: 100,
    });

    let resolveSync!: () => void;
    const syncDshConfig = vi.fn(
      () => new Promise<{ success: boolean; changed: boolean }>((resolve) => {
        resolveSync = () => resolve({ success: true, changed: true });
      }),
    );

    registerMcpHandlers({
      getMcpRuntime: () => ({
        getStore: () => ({
          getServer: (id: string) => (id === serverRecord.id ? serverRecord : null),
          listServers: () => [serverRecord],
        }),
      }) as never,
      syncDshConfig,
      getMcpOAuthManager: () => oauthManager,
    });

    const logoutHandler = registeredHandlers.get(McpIpcChannel.OAuthLogout)!;
    let logoutResolved = false;
    const logoutPromise = (logoutHandler({}, serverRecord.id) as Promise<unknown>).then((res) => {
      logoutResolved = true;
      return res;
    });

    await vi.waitFor(() => {
      expect(syncDshConfig).toHaveBeenCalledWith({ reason: 'mcp-oauth-logout' });
    });
    expect(oauthManager.getToken(serverRecord.id)).toBeNull();
    expect(logoutResolved).toBe(false);

    resolveSync();
    expect(await logoutPromise).toEqual({
      success: true,
      state: McpOAuthState.RequiresAuthorization,
    });
  });

  test('OAuthStatus checks token expiry, auto-refreshes expiring refreshable tokens, and flags expired/failed ones', async () => {
    const clock = 5_000_000;
    const fetcher = vi.fn<McpOAuthFetch>(async (url, init) => {
      if (url === 'https://auth.good.example/token' && init?.body?.includes('grant_type=refresh_token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'refreshed-tok',
            refresh_token: 'ref-2',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
          text: async () => '',
        };
      }
      return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }), text: async () => 'bad' };
    });

    const srvValid = makeOAuthServer({ id: 'srv-valid', name: 'Valid' });
    const srvExpiredNoRefresh = makeOAuthServer({ id: 'srv-expired-noref', name: 'ExpiredNoRef' });
    const srvExpiringRefreshOk = makeOAuthServer({ id: 'srv-refresh-ok', name: 'RefreshOk' });
    const srvExpiredRefreshFail = makeOAuthServer({ id: 'srv-refresh-fail', name: 'RefreshFail' });
    const srvDisabled = makeOAuthServer({ id: 'srv-disabled', name: 'Disabled', enabled: false });

    const oauthManager = new McpOAuthManager({
      storage: createMemoryStorage(),
      fetcher,
      now: () => clock,
    });
    oauthManager.saveToken({
      serverId: srvValid.id,
      accessToken: 'tok-valid',
      tokenType: 'Bearer',
      expiresAtMs: clock + 3_600_000,
      updatedAt: clock - 1000,
    });
    oauthManager.saveToken({
      serverId: srvExpiredNoRefresh.id,
      accessToken: 'tok-dead',
      tokenType: 'Bearer',
      expiresAtMs: clock - 10_000,
      updatedAt: clock - 20_000,
    });
    oauthManager.saveToken({
      serverId: srvExpiringRefreshOk.id,
      accessToken: 'tok-expiring',
      refreshToken: 'ref-1',
      tokenType: 'Bearer',
      tokenEndpoint: 'https://auth.good.example/token',
      expiresAtMs: clock + 10_000, // inside 60s leeway -> triggers refresh
      updatedAt: clock - 50_000,
    });
    oauthManager.saveToken({
      serverId: srvExpiredRefreshFail.id,
      accessToken: 'tok-badref',
      refreshToken: 'ref-revoked',
      tokenType: 'Bearer',
      tokenEndpoint: 'https://auth.bad.example/token',
      expiresAtMs: clock - 5_000,
      updatedAt: clock - 50_000,
    });

    const syncDshConfig = vi.fn(async () => ({ success: true, changed: true }));
    registerMcpHandlers({
      getMcpRuntime: () => ({
        getStore: () => ({
          listServers: () => [
            srvValid,
            srvExpiredNoRefresh,
            srvExpiringRefreshOk,
            srvExpiredRefreshFail,
            srvDisabled,
          ],
        }),
      }) as never,
      syncDshConfig,
      getMcpOAuthManager: () => oauthManager,
    });

    const statusHandler = registeredHandlers.get(McpIpcChannel.OAuthStatus)!;
    const result = await statusHandler({});
    expect(result).toEqual({
      success: true,
      states: {
        [srvValid.id]: McpOAuthState.Authorized,
        [srvExpiredNoRefresh.id]: McpOAuthState.RequiresAuthorization,
        [srvExpiringRefreshOk.id]: McpOAuthState.Authorized,
        [srvExpiredRefreshFail.id]: McpOAuthState.RequiresAuthorization,
        [srvDisabled.id]: McpOAuthState.Unknown,
      },
    });
    expect(oauthManager.getToken(srvExpiringRefreshOk.id)?.accessToken).toBe('refreshed-tok');
    expect(syncDshConfig).toHaveBeenCalledWith({ reason: 'mcp-oauth-refreshed' });
  });
});
