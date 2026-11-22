import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  buildAuthorizationServerDiscoveryUrls,
  buildProtectedResourceMetadataUrls,
  encodeMigratedMcpOAuthToken,
  MCP_OAUTH_TOKEN_KV_PREFIX,
  type McpOAuthFetch,
  McpOAuthManager,
  McpOAuthRefreshScheduler,
  parseWwwAuthenticateBearerChallenge,
} from './mcpOAuthManager';

function createMemoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    get: (k: string) => map.get(k) ?? null,
    set: (k: string, v: string) => {
      map.set(k, v);
    },
    delete: (k: string) => {
      map.delete(k);
    },
  };
}

function makeHeaders(entries: Record<string, string>): { get(name: string): string | null } {
  const lower = Object.fromEntries(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    get: (name: string) => lower[name.toLowerCase()] ?? null,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('McpOAuthManager helpers', () => {
  test('parses RFC 9728 WWW-Authenticate Bearer challenge parameters', () => {
    const parsed = parseWwwAuthenticateBearerChallenge(
      'Bearer realm="mcp", resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/v2/mcp", scope="mcp:read mcp:write", error="invalid_token"',
    );
    expect(parsed).toEqual({
      resourceMetadataUrl: 'https://api.example.com/.well-known/oauth-protected-resource/v2/mcp',
      scope: 'mcp:read mcp:write',
      error: 'invalid_token',
    });

    const unquoted = parseWwwAuthenticateBearerChallenge(
      'bearer resource_metadata=https://mcp.example.com/prm, scope=tools:run',
    );
    expect(unquoted).toEqual({
      resourceMetadataUrl: 'https://mcp.example.com/prm',
      scope: 'tools:run',
    });

    expect(parseWwwAuthenticateBearerChallenge('Basic realm="admin"')).toEqual({});
  });

  test('builds RFC 9728 PRM URLs in challenge -> path-inserted -> root order', () => {
    expect(
      buildProtectedResourceMetadataUrls(
        'https://mcp.example.com/tenant/v1/mcp',
        'https://meta.example.com/custom-prm',
      ),
    ).toEqual([
      'https://meta.example.com/custom-prm',
      'https://mcp.example.com/.well-known/oauth-protected-resource/tenant/v1/mcp',
      'https://mcp.example.com/.well-known/oauth-protected-resource',
    ]);
  });

  test('builds RFC 8414 & OIDC discovery URLs preserving issuer paths', () => {
    expect(buildAuthorizationServerDiscoveryUrls('https://idp.example.com/realms/acme/')).toEqual([
      'https://idp.example.com/.well-known/oauth-authorization-server/realms/acme',
      'https://idp.example.com/.well-known/openid-configuration/realms/acme',
      'https://idp.example.com/realms/acme/.well-known/openid-configuration',
      'https://idp.example.com/.well-known/oauth-authorization-server',
      'https://idp.example.com/.well-known/openid-configuration',
    ]);

    expect(buildAuthorizationServerDiscoveryUrls('https://idp.example.com')).toEqual([
      'https://idp.example.com/.well-known/oauth-authorization-server',
      'https://idp.example.com/.well-known/openid-configuration',
    ]);
  });
});

describe('McpOAuthManager', () => {
  test('discovers OAuth metadata, completes PKCE flow, encrypts token, and auto-refreshes before expiry', async () => {
    let clock = 1_000_000;
    const fetcher = vi.fn<McpOAuthFetch>(async (url, init) => {
      if (url === 'https://mcp.example.com/.well-known/oauth-protected-resource') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ authorization_servers: ['https://auth.example.com'] }),
          text: async () => '',
        };
      }
      if (url === 'https://auth.example.com/.well-known/oauth-authorization-server') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
          }),
          text: async () => '',
        };
      }
      if (url === 'https://auth.example.com/token' && init?.body?.includes('grant_type=authorization_code')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'tok-initial',
            refresh_token: 'ref-1',
            token_type: 'Bearer',
            expires_in: 120,
          }),
          text: async () => '',
        };
      }
      if (url === 'https://auth.example.com/token' && init?.body?.includes('grant_type=refresh_token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'tok-refreshed',
            refresh_token: 'ref-2',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
          text: async () => '',
        };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
    });

    const storage = createMemoryStorage();
    const manager = new McpOAuthManager({
      storage,
      fetcher,
      now: () => clock,
    });

    const meta = await manager.discoverMetadata('https://mcp.example.com/v1');
    expect(meta.tokenEndpoint).toBe('https://auth.example.com/token');
    expect(meta.resource).toBe('https://mcp.example.com/v1');

    const start = manager.beginPkceFlow({
      serverId: 'srv-1',
      metadata: meta,
      clientId: 'lobsterai-client',
      redirectUri: 'http://127.0.0.1:4444/callback',
    });
    expect(start.authorizationUrl).toContain('code_challenge_method=S256');
    expect(start.authorizationUrl).toContain(
      `resource=${encodeURIComponent('https://mcp.example.com/v1')}`,
    );

    const token = await manager.completePkceFlow(start.state, 'auth-code-123');
    expect(token.accessToken).toBe('tok-initial');

    // Fresh token resolves directly without refresh.
    expect(await manager.resolveAuthorizationHeaders('srv-1')).toEqual({
      Authorization: 'Bearer tok-initial',
    });

    // Advance within 60s expiry leeway -> triggers automatic refresh.
    clock += 90_000;
    expect(await manager.resolveAuthorizationHeaders('srv-1')).toEqual({
      Authorization: 'Bearer tok-refreshed',
    });
  });

  test('probes 401 WWW-Authenticate, preserves path-based issuer, falls back to OIDC, and runs RFC 7591 DCR with confidential secret + RFC 8707 resource/scope', async () => {
    let clock = 2_000_000;
    const tokenRequests: Array<{ body: string; headers?: Record<string, string> }> = [];

    const fetcher = vi.fn<McpOAuthFetch>(async (url, init) => {
      if (url === 'https://mcp.corp.example/team/mcp' && init?.method === 'POST') {
        return {
          ok: false,
          status: 401,
          headers: makeHeaders({
            'WWW-Authenticate':
              'Bearer resource_metadata="https://mcp.corp.example/.well-known/oauth-protected-resource/team/mcp", scope="mcp:tools mcp:read"',
          }),
          json: async () => ({}),
          text: async () => 'unauthorized',
        };
      }
      if (url === 'https://mcp.corp.example/.well-known/oauth-protected-resource/team/mcp') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            resource: 'https://mcp.corp.example/team/mcp',
            authorization_servers: ['https://idp.corp.example/tenants/alpha'],
            scopes_supported: ['mcp:read'],
          }),
          text: async () => '',
        };
      }
      // RFC 8414 endpoints return 404, forcing OIDC Discovery 1.0 path-appended fallback.
      if (url === 'https://idp.corp.example/tenants/alpha/.well-known/openid-configuration') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            issuer: 'https://idp.corp.example/tenants/alpha',
            authorization_endpoint: 'https://idp.corp.example/tenants/alpha/authorize',
            token_endpoint: 'https://idp.corp.example/tenants/alpha/token',
            registration_endpoint: 'https://idp.corp.example/tenants/alpha/register',
          }),
          text: async () => '',
        };
      }
      if (url === 'https://idp.corp.example/tenants/alpha/register' && init?.method === 'POST') {
        const regBody = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
        expect(regBody).toMatchObject({
          client_name: 'LobsterAI',
          redirect_uris: ['http://127.0.0.1:4567/oauth/callback'],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          scope: 'mcp:tools mcp:read',
        });
        return {
          ok: true,
          status: 201,
          json: async () => ({
            client_id: 'dcr-client-42',
            client_secret: 'dcr-secret-99',
            token_endpoint_auth_method: 'client_secret_post',
          }),
          text: async () => '',
        };
      }
      if (url === 'https://idp.corp.example/tenants/alpha/token' && init?.method === 'POST') {
        tokenRequests.push({ body: init.body ?? '', headers: init.headers });
        const params = new URLSearchParams(init.body ?? '');
        expect(params.get('client_id')).toBe('dcr-client-42');
        expect(params.get('client_secret')).toBe('dcr-secret-99');
        expect(params.get('resource')).toBe('https://mcp.corp.example/team/mcp');
        expect(params.get('scope')).toBe('mcp:tools mcp:read');

        if (params.get('grant_type') === 'authorization_code') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: 'tok-dcr-1',
              refresh_token: 'ref-dcr-1',
              token_type: 'Bearer',
              expires_in: 120,
              scope: 'mcp:tools mcp:read',
            }),
            text: async () => '',
          };
        }
        if (params.get('grant_type') === 'refresh_token') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: 'tok-dcr-2',
              refresh_token: 'ref-dcr-2',
              token_type: 'Bearer',
              expires_in: 3600,
            }),
            text: async () => '',
          };
        }
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
    });

    const storage = createMemoryStorage();
    const manager = new McpOAuthManager({ storage, fetcher, now: () => clock });

    const meta = await manager.discoverMetadata('https://mcp.corp.example/team/mcp');
    expect(meta.authorizationEndpoint).toBe('https://idp.corp.example/tenants/alpha/authorize');
    expect(meta.tokenEndpoint).toBe('https://idp.corp.example/tenants/alpha/token');
    expect(meta.registrationEndpoint).toBe('https://idp.corp.example/tenants/alpha/register');
    expect(meta.resource).toBe('https://mcp.corp.example/team/mcp');
    expect(meta.defaultScope).toBe('mcp:tools mcp:read');

    const dcr = await manager.registerDynamicClient({
      registrationEndpoint: meta.registrationEndpoint!,
      redirectUri: 'http://127.0.0.1:4567/oauth/callback',
      scope: meta.defaultScope,
    });
    expect(dcr).toEqual({
      clientId: 'dcr-client-42',
      clientSecret: 'dcr-secret-99',
      tokenEndpointAuthMethod: 'client_secret_post',
    });

    const start = manager.beginPkceFlow({
      serverId: 'srv-dcr',
      metadata: meta,
      redirectUri: 'http://127.0.0.1:4567/oauth/callback',
      clientId: dcr.clientId,
      clientSecret: dcr.clientSecret,
      tokenEndpointAuthMethod: dcr.tokenEndpointAuthMethod,
    });
    const authUrl = new URL(start.authorizationUrl);
    expect(authUrl.searchParams.get('client_id')).toBe('dcr-client-42');
    expect(authUrl.searchParams.get('resource')).toBe('https://mcp.corp.example/team/mcp');
    expect(authUrl.searchParams.get('scope')).toBe('mcp:tools mcp:read');

    const token = await manager.completePkceFlow(start.state, 'code-abc');
    expect(token.clientId).toBe('dcr-client-42');
    expect(token.clientSecret).toBe('dcr-secret-99');
    expect(token.resource).toBe('https://mcp.corp.example/team/mcp');

    // Concurrent calls during refresh deduplicate to a single refresh POST.
    clock += 100_000;
    const [h1, h2] = await Promise.all([
      manager.resolveAuthorizationHeaders('srv-dcr'),
      manager.resolveAuthorizationHeaders('srv-dcr'),
    ]);
    expect(h1).toEqual({ Authorization: 'Bearer tok-dcr-2' });
    expect(h2).toEqual({ Authorization: 'Bearer tok-dcr-2' });
    expect(tokenRequests).toHaveLength(2); // 1 code exchange + 1 deduplicated refresh
  });

  test('detects expired unrefreshable tokens and failing refreshes in checkAuthorizationStatus', async () => {
    let clock = 5_000_000;
    const fetcher = vi.fn<McpOAuthFetch>(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant' }),
      text: async () => 'invalid_grant',
    }));

    const storage = createMemoryStorage();
    const manager = new McpOAuthManager({ storage, fetcher, now: () => clock });

    // Non-refreshable token: valid before expiry, invalid after expiry.
    manager.saveToken({
      serverId: 'srv-no-refresh',
      accessToken: 'short-tok',
      tokenType: 'Bearer',
      expiresAtMs: clock + 30_000,
      updatedAt: clock,
    });
    expect(await manager.checkAuthorizationStatus('srv-no-refresh')).toEqual({
      authorized: true,
      refreshed: false,
    });

    clock += 35_000;
    expect(await manager.resolveAuthorizationHeaders('srv-no-refresh')).toBeNull();
    expect(await manager.checkAuthorizationStatus('srv-no-refresh')).toEqual({
      authorized: false,
      refreshed: false,
    });

    // Refreshable token whose refresh fails -> checkAuthorizationStatus returns authorized=false.
    manager.saveToken({
      serverId: 'srv-bad-refresh',
      accessToken: 'old-tok',
      refreshToken: 'revoked-ref',
      tokenType: 'Bearer',
      tokenEndpoint: 'https://auth.example.com/token',
      expiresAtMs: clock - 1_000,
      updatedAt: clock,
    });
    expect(await manager.checkAuthorizationStatus('srv-bad-refresh')).toEqual({
      authorized: false,
      refreshed: false,
    });
  });

  test('transparently decodes pre-boot migrated b64 token and re-encrypts to safe: when cipher supports it', () => {
    const storage = createMemoryStorage();
    storage.set(
      `${MCP_OAUTH_TOKEN_KV_PREFIX}srv-mig`,
      encodeMigratedMcpOAuthToken({
        serverId: 'srv-mig',
        accessToken: 'migrated-secret-tok',
        refreshToken: 'migrated-ref',
        tokenType: 'Bearer',
        updatedAt: 12345,
      }),
    );

    const manager = new McpOAuthManager({
      storage,
      cipher: {
        encrypt: (plain) => `safe:${Buffer.from(plain, 'utf8').toString('base64')}`,
        decrypt: (encoded) => {
          if (encoded.startsWith('safe:')) {
            return Buffer.from(encoded.slice(5), 'base64').toString('utf8');
          }
          return Buffer.from(encoded.slice(4), 'base64').toString('utf8');
        },
      },
    });

    const token = manager.getToken('srv-mig');
    expect(token?.accessToken).toBe('migrated-secret-tok');
    expect(storage.get(`${MCP_OAUTH_TOKEN_KV_PREFIX}srv-mig`)?.startsWith('safe:')).toBe(true);
  });

  test('McpOAuthRefreshScheduler proactively triggers re-sync before expiry and stops on non-refreshable expiry', async () => {
    vi.useFakeTimers();
    let clock = 10_000_000;
    const storage = createMemoryStorage();
    const manager = new McpOAuthManager({ storage, now: () => clock });

    manager.saveToken({
      serverId: 'srv-refreshable',
      accessToken: 'tok-v1',
      refreshToken: 'ref-v1',
      tokenType: 'Bearer',
      tokenEndpoint: 'https://auth.example.com/token',
      expiresAtMs: clock + 65_000, // due in 5s (60s leeway)
      updatedAt: clock,
    });
    manager.saveToken({
      serverId: 'srv-expiring-only',
      accessToken: 'tok-once',
      tokenType: 'Bearer',
      expiresAtMs: clock + 12_000, // due in 12.25s
      updatedAt: clock,
    });

    const onRefreshDue = vi.fn(async (dueServerIds: string[]) => {
      if (dueServerIds.includes('srv-refreshable')) {
        manager.saveToken({
          serverId: 'srv-refreshable',
          accessToken: 'tok-v2',
          refreshToken: 'ref-v2',
          tokenType: 'Bearer',
          tokenEndpoint: 'https://auth.example.com/token',
          expiresAtMs: clock + 3_600_000,
          updatedAt: clock,
        });
      }
      return {
        needsReauthIds: dueServerIds.includes('srv-expiring-only') ? ['srv-expiring-only'] : [],
      };
    });

    const scheduler = new McpOAuthRefreshScheduler({
      oauthManager: manager,
      onRefreshDue,
      now: () => clock,
    });

    scheduler.updateTrackedServers(['srv-refreshable', 'srv-expiring-only']);

    // Advance 5 seconds -> srv-refreshable becomes due (60s before expiry).
    clock += 5_000;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onRefreshDue).toHaveBeenCalledTimes(1);
    expect(onRefreshDue).toHaveBeenLastCalledWith(['srv-refreshable']);

    // Advance another 8 seconds (total 13s) -> srv-expiring-only expires and triggers eviction once.
    clock += 8_000;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(onRefreshDue).toHaveBeenCalledTimes(2);
    expect(onRefreshDue).toHaveBeenLastCalledWith(['srv-expiring-only']);

    // Advance another 10 seconds -> does NOT re-trigger for already-evicted non-refreshable server.
    clock += 10_000;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onRefreshDue).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });
});
