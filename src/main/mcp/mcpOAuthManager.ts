// Main-process Remote MCP OAuth 2.1 PKCE manager.
//
// `dsh-mcp-client` supports `stdio` and `streamable-http` with explicit static
// headers, without built-in OAuth discovery/PKCE. This module owns OAuth
// discovery, PKCE login state, encrypted token persistence (wrapping Electron
// `safeStorage` via injected cipher callbacks), automatic token refresh, and
// dynamic `Authorization: Bearer <token>` header resolution for `syncMcpServers`.

import { createHash, randomBytes } from 'crypto';

export interface McpOAuthTokenRecord {
  serverId: string;
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAtMs?: number;
  scope?: string;
  tokenEndpoint?: string;
  clientId?: string;
  updatedAt: number;
}

export interface McpOAuthMetadata {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
}

export interface McpOAuthPkceStart {
  state: string;
  codeVerifier: string;
  codeChallenge: string;
  authorizationUrl: string;
  tokenEndpoint: string;
  clientId: string;
  redirectUri: string;
}

export interface McpOAuthCipher {
  encrypt(plain: string): string;
  decrypt(encoded: string): string;
}

export interface McpOAuthStoragePort {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export type McpOAuthFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

const REFRESH_LEEWAY_MS = 60_000;
const KV_PREFIX = 'mcp.oauth.token.';

export function generatePkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

export class McpOAuthManager {
  private readonly storage: McpOAuthStoragePort;
  private readonly cipher: McpOAuthCipher;
  private readonly fetcher: McpOAuthFetch;
  private readonly now: () => number;
  private readonly pendingFlows = new Map<string, { serverId: string; pkce: McpOAuthPkceStart }>();

  constructor(options: {
    storage: McpOAuthStoragePort;
    cipher?: McpOAuthCipher;
    fetcher?: McpOAuthFetch;
    now?: () => number;
  }) {
    this.storage = options.storage;
    this.cipher = options.cipher ?? {
      encrypt: (plain) => Buffer.from(plain, 'utf8').toString('base64'),
      decrypt: (encoded) => Buffer.from(encoded, 'base64').toString('utf8'),
    };
    this.fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Discover OAuth 2.1 Authorization Server metadata for a remote MCP server
   * following RFC 9728 (`/.well-known/oauth-protected-resource`) and RFC 8414
   * (`/.well-known/oauth-authorization-server`).
   */
  async discoverMetadata(mcpServerUrl: string): Promise<McpOAuthMetadata> {
    const serverOrigin = new URL(mcpServerUrl).origin;
    let authServerOrigin = serverOrigin;

    try {
      const prm = await this.fetcher(`${serverOrigin}/.well-known/oauth-protected-resource`);
      if (prm.ok) {
        const doc = (await prm.json()) as { authorization_servers?: string[] };
        if (Array.isArray(doc.authorization_servers) && typeof doc.authorization_servers[0] === 'string') {
          authServerOrigin = new URL(doc.authorization_servers[0]).origin;
        }
      }
    } catch {
      // Fallback directly to serverOrigin's authorization-server well-known metadata.
    }

    const asRes = await this.fetcher(`${authServerOrigin}/.well-known/oauth-authorization-server`);
    if (!asRes.ok) {
      throw new Error(`OAuth metadata discovery failed for ${mcpServerUrl} (HTTP ${asRes.status})`);
    }
    const meta = (await asRes.json()) as Record<string, unknown>;
    if (typeof meta.authorization_endpoint !== 'string' || typeof meta.token_endpoint !== 'string') {
      throw new Error(`OAuth metadata for ${mcpServerUrl} missing authorization_endpoint or token_endpoint`);
    }
    return {
      authorizationEndpoint: meta.authorization_endpoint,
      tokenEndpoint: meta.token_endpoint,
      ...(typeof meta.registration_endpoint === 'string'
        ? { registrationEndpoint: meta.registration_endpoint }
        : {}),
      ...(Array.isArray(meta.scopes_supported)
        ? { scopesSupported: meta.scopes_supported.filter((s): s is string => typeof s === 'string') }
        : {}),
    };
  }

  beginPkceFlow(options: {
    serverId: string;
    metadata: McpOAuthMetadata;
    clientId: string;
    redirectUri: string;
    scope?: string;
  }): McpOAuthPkceStart {
    const { codeVerifier, codeChallenge } = generatePkcePair();
    const state = randomBytes(16).toString('base64url');
    const url = new URL(options.metadata.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', options.clientId);
    url.searchParams.set('redirect_uri', options.redirectUri);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    if (options.scope) {
      url.searchParams.set('scope', options.scope);
    }

    const pkce: McpOAuthPkceStart = {
      state,
      codeVerifier,
      codeChallenge,
      authorizationUrl: url.href,
      tokenEndpoint: options.metadata.tokenEndpoint,
      clientId: options.clientId,
      redirectUri: options.redirectUri,
    };
    this.pendingFlows.set(state, { serverId: options.serverId, pkce });
    return pkce;
  }

  async completePkceFlow(state: string, code: string): Promise<McpOAuthTokenRecord> {
    const flow = this.pendingFlows.get(state);
    if (!flow) {
      throw new Error('Unknown or expired MCP OAuth state');
    }
    this.pendingFlows.delete(state);

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: flow.pkce.redirectUri,
      client_id: flow.pkce.clientId,
      code_verifier: flow.pkce.codeVerifier,
    }).toString();

    const res = await this.fetcher(flow.pkce.tokenEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body,
    });
    if (!res.ok) {
      throw new Error(`MCP OAuth token exchange failed (HTTP ${res.status}): ${await res.text()}`);
    }
    const tokenJson = (await res.json()) as Record<string, unknown>;
    if (typeof tokenJson.access_token !== 'string' || !tokenJson.access_token) {
      throw new Error('MCP OAuth token response missing access_token');
    }

    const expiresIn = typeof tokenJson.expires_in === 'number' ? tokenJson.expires_in : undefined;
    const record: McpOAuthTokenRecord = {
      serverId: flow.serverId,
      accessToken: tokenJson.access_token,
      ...(typeof tokenJson.refresh_token === 'string' ? { refreshToken: tokenJson.refresh_token } : {}),
      tokenType: typeof tokenJson.token_type === 'string' ? tokenJson.token_type : 'Bearer',
      ...(expiresIn !== undefined ? { expiresAtMs: this.now() + expiresIn * 1000 } : {}),
      ...(typeof tokenJson.scope === 'string' ? { scope: tokenJson.scope } : {}),
      tokenEndpoint: flow.pkce.tokenEndpoint,
      clientId: flow.pkce.clientId,
      updatedAt: this.now(),
    };
    this.saveToken(record);
    return record;
  }

  saveToken(record: McpOAuthTokenRecord): void {
    const encrypted = this.cipher.encrypt(JSON.stringify(record));
    this.storage.set(`${KV_PREFIX}${record.serverId}`, encrypted);
  }

  getToken(serverId: string): McpOAuthTokenRecord | null {
    const raw = this.storage.get(`${KV_PREFIX}${serverId}`);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(this.cipher.decrypt(raw)) as McpOAuthTokenRecord;
      return parsed && typeof parsed.accessToken === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }

  deleteToken(serverId: string): void {
    this.storage.delete(`${KV_PREFIX}${serverId}`);
  }

  /**
   * Resolve fresh HTTP Authorization headers for a remote MCP server,
   * refreshing via `refresh_token` automatically when close to expiry.
   */
  async resolveAuthorizationHeaders(serverId: string): Promise<Record<string, string> | null> {
    let token = this.getToken(serverId);
    if (!token) return null;

    const isExpiring = token.expiresAtMs !== undefined && token.expiresAtMs - this.now() <= REFRESH_LEEWAY_MS;
    if (isExpiring) {
      if (!token.refreshToken || !token.tokenEndpoint) {
        return null;
      }
      token = await this.refreshToken(token);
    }

    return {
      Authorization: `${token.tokenType || 'Bearer'} ${token.accessToken}`,
    };
  }

  private async refreshToken(record: McpOAuthTokenRecord): Promise<McpOAuthTokenRecord> {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: record.refreshToken!,
      ...(record.clientId ? { client_id: record.clientId } : {}),
    });

    const res = await this.fetcher(record.tokenEndpoint!, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: params.toString(),
    });
    if (!res.ok) {
      throw new Error(`MCP OAuth token refresh failed for "${record.serverId}" (HTTP ${res.status})`);
    }
    const json = (await res.json()) as Record<string, unknown>;
    if (typeof json.access_token !== 'string' || !json.access_token) {
      throw new Error(`MCP OAuth refresh response for "${record.serverId}" missing access_token`);
    }
    const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : undefined;
    const updated: McpOAuthTokenRecord = {
      ...record,
      accessToken: json.access_token,
      refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : record.refreshToken,
      tokenType: typeof json.token_type === 'string' ? json.token_type : record.tokenType,
      expiresAtMs: expiresIn !== undefined ? this.now() + expiresIn * 1000 : record.expiresAtMs,
      updatedAt: this.now(),
    };
    this.saveToken(updated);
    return updated;
  }
}
