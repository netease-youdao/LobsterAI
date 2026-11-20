import { describe, expect, test, vi } from 'vitest';

import { type McpOAuthFetch,McpOAuthManager } from './mcpOAuthManager';

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

describe('McpOAuthManager', () => {
  test('discovers OAuth metadata, completes PKCE flow, encrypts token, and auto-refreshes before expiry', async () => {
    let clock = 1_000_000;
    const fetcher = vi.fn<McpOAuthFetch>(async (url, init) => {
      if (url.endsWith('/.well-known/oauth-protected-resource')) {
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

    const start = manager.beginPkceFlow({
      serverId: 'srv-1',
      metadata: meta,
      clientId: 'lobsterai-client',
      redirectUri: 'http://127.0.0.1:4444/callback',
    });
    expect(start.authorizationUrl).toContain('code_challenge_method=S256');

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
});
