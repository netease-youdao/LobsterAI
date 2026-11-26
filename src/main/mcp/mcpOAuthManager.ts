// Main-process Remote MCP OAuth 2.1 PKCE manager.
//
// `dsh-mcp-client` supports `stdio` and `streamable-http` with explicit static
// headers, without built-in OAuth discovery/PKCE. This module owns OAuth 2.1
// discovery (RFC 9728 / RFC 8414 / OIDC), RFC 7591 Dynamic Client Registration,
// RFC 8707 resource indicators, PKCE login state, encrypted token persistence
// (wrapping Electron `safeStorage` via injected cipher callbacks), automatic
// and proactive token refresh, and dynamic `Authorization: Bearer <token>`
// header resolution for `syncMcpServers`.

import { createHash, randomBytes } from 'crypto';

export const MCP_OAUTH_TOKEN_KV_PREFIX = 'mcp.oauth.token.';
export const MCP_OAUTH_REFRESH_LEEWAY_MS = 60_000;
export const DEFAULT_MCP_OAUTH_CLIENT_ID = 'lobsterai-desktop';

const MAX_REFRESH_TIMER_DELAY_MS = 60 * 60 * 1000;
const DEFAULT_REFRESH_FAILURE_BACKOFF_MS = 60_000;
const EXPIRED_NON_REFRESHABLE_GRACE_MS = 250;

export interface McpOAuthTokenRecord {
  serverId: string;
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAtMs?: number;
  scope?: string;
  tokenEndpoint?: string;
  clientId?: string;
  clientSecret?: string;
  tokenEndpointAuthMethod?: string;
  resource?: string;
  updatedAt: number;
}

export interface McpOAuthMetadata {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
  issuer?: string;
  /** RFC 8707 resource indicator (from PRM `resource` or canonical server URL). */
  resource?: string;
  /** Scope requested via 401 WWW-Authenticate challenge or PRM `scopes_supported`. */
  defaultScope?: string;
}

export interface McpOAuthClientCredentials {
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod?: string;
}

export interface McpOAuthPkceStart {
  state: string;
  codeVerifier: string;
  codeChallenge: string;
  authorizationUrl: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod?: string;
  redirectUri: string;
  resource?: string;
  scope?: string;
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

export interface McpOAuthFetchResponse {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  body?: { cancel?: () => Promise<unknown> } | null;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type McpOAuthFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<McpOAuthFetchResponse>;

export interface WwwAuthenticateBearerChallenge {
  resourceMetadataUrl?: string;
  scope?: string;
  error?: string;
}

export function generatePkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

/**
 * Encode a token record written offline (e.g. pre-boot migration before
 * Electron `safeStorage` is available) in a format readable by both the
 * default cipher and `safeStorage`-backed ciphers.
 */
export function encodeMigratedMcpOAuthToken(record: McpOAuthTokenRecord): string {
  return `b64:${Buffer.from(JSON.stringify(record), 'utf8').toString('base64')}`;
}

export function decodePlainOrBase64McpOAuthToken(encoded: string): string {
  if (encoded.startsWith('b64:')) {
    return Buffer.from(encoded.slice(4), 'base64').toString('utf8');
  }
  if (encoded.startsWith('plain:')) {
    return encoded.slice(6);
  }
  if (encoded.trimStart().startsWith('{')) {
    return encoded;
  }
  return Buffer.from(encoded, 'base64').toString('utf8');
}

function isHttpOrHttpsUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function canonicalResourceUrl(mcpServerUrl: string): string {
  const parsed = new URL(mcpServerUrl);
  parsed.hash = '';
  return parsed.href;
}

/**
 * Parse a `WWW-Authenticate: Bearer ...` header per RFC 9728 §5.1 / RFC 6750.
 */
export function parseWwwAuthenticateBearerChallenge(
  headerValue: string | null | undefined,
): WwwAuthenticateBearerChallenge {
  if (!headerValue) return {};
  const bearerMatch = headerValue.match(/(?:^|,)\s*Bearer\s+(.+)$/i);
  if (!bearerMatch) return {};
  const paramsText = bearerMatch[1];

  const extractParam = (name: string): string | undefined => {
    const pattern = new RegExp(`(?:^|[\\s,])${name}=(?:"((?:\\\\.|[^"\\\\])*)"|([^\\s,]+))`, 'i');
    const match = paramsText.match(pattern);
    if (!match) return undefined;
    const value = match[1] !== undefined
      ? match[1].replace(/\\(.)/g, '$1')
      : match[2];
    return value?.trim() || undefined;
  };

  const rawMetadataUrl = extractParam('resource_metadata');
  const resourceMetadataUrl = rawMetadataUrl && isHttpOrHttpsUrl(rawMetadataUrl)
    ? rawMetadataUrl
    : undefined;
  const scope = extractParam('scope');
  const error = extractParam('error');

  return {
    ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
    ...(scope ? { scope } : {}),
    ...(error ? { error } : {}),
  };
}

/**
 * Build candidate RFC 9728 Protected Resource Metadata URLs in priority order:
 * 1. Explicit `resource_metadata` URL from 401 `WWW-Authenticate` challenge
 * 2. Path-inserted `${origin}/.well-known/oauth-protected-resource${pathname}` (RFC 9728 §3.1)
 * 3. Root `${origin}/.well-known/oauth-protected-resource`
 */
export function buildProtectedResourceMetadataUrls(
  mcpServerUrl: string,
  challengeResourceMetadataUrl?: string,
): string[] {
  const parsed = new URL(mcpServerUrl);
  const candidates: string[] = [];
  const pushUnique = (candidate: string) => {
    if (!candidates.includes(candidate)) candidates.push(candidate);
  };

  if (challengeResourceMetadataUrl && isHttpOrHttpsUrl(challengeResourceMetadataUrl)) {
    pushUnique(challengeResourceMetadataUrl);
  }

  const trimmedPath = parsed.pathname.replace(/\/+$/, '');
  if (trimmedPath && trimmedPath !== '/') {
    pushUnique(`${parsed.origin}/.well-known/oauth-protected-resource${trimmedPath}`);
  }
  pushUnique(`${parsed.origin}/.well-known/oauth-protected-resource`);
  return candidates;
}

/**
 * Build candidate RFC 8414 & OIDC Discovery 1.0 Authorization Server Metadata
 * URLs while preserving any path component on the issuer URL.
 */
export function buildAuthorizationServerDiscoveryUrls(issuerUrl: string): string[] {
  const parsed = new URL(issuerUrl);
  const trimmedPath = parsed.pathname.replace(/\/+$/, '');
  const candidates: string[] = [];
  const pushUnique = (candidate: string) => {
    if (!candidates.includes(candidate)) candidates.push(candidate);
  };

  if (trimmedPath && trimmedPath !== '/') {
    // RFC 8414 §3 path-inserted OAuth metadata
    pushUnique(`${parsed.origin}/.well-known/oauth-authorization-server${trimmedPath}`);
    // RFC 8414 §3 path-inserted OIDC metadata
    pushUnique(`${parsed.origin}/.well-known/openid-configuration${trimmedPath}`);
    // OIDC Discovery 1.0 §4 path-appended metadata
    pushUnique(`${parsed.origin}${trimmedPath}/.well-known/openid-configuration`);
  }

  // Root OAuth & OIDC metadata endpoints (primary for root issuers, fallback otherwise)
  pushUnique(`${parsed.origin}/.well-known/oauth-authorization-server`);
  pushUnique(`${parsed.origin}/.well-known/openid-configuration`);
  return candidates;
}

function getHeaderCaseInsensitive(
  response: McpOAuthFetchResponse,
  name: string,
): string | null {
  if (!response.headers) return null;
  return (
    response.headers.get(name)
    ?? response.headers.get(name.toLowerCase())
    ?? response.headers.get('WWW-Authenticate')
    ?? null
  );
}

function cancelResponseBodyQuietly(response: McpOAuthFetchResponse): void {
  try {
    void response.body?.cancel?.().catch((): void => undefined);
  } catch {
    // ignore body cancellation errors
  }
}

function applyClientAuthentication(
  params: URLSearchParams,
  headers: Record<string, string>,
  credentials: {
    clientId?: string;
    clientSecret?: string;
    tokenEndpointAuthMethod?: string;
  },
): void {
  if (credentials.clientId && credentials.clientSecret) {
    if (credentials.tokenEndpointAuthMethod === 'client_secret_basic') {
      const basic = Buffer.from(
        `${encodeURIComponent(credentials.clientId)}:${encodeURIComponent(credentials.clientSecret)}`,
        'utf8',
      ).toString('base64');
      headers.Authorization = `Basic ${basic}`;
      return;
    }
    params.set('client_id', credentials.clientId);
    params.set('client_secret', credentials.clientSecret);
    return;
  }
  if (credentials.clientId) {
    params.set('client_id', credentials.clientId);
  }
}

export class McpOAuthManager {
  private readonly storage: McpOAuthStoragePort;
  private readonly cipher: McpOAuthCipher;
  private readonly fetcher: McpOAuthFetch;
  private readonly now: () => number;
  private readonly pendingFlows = new Map<string, { serverId: string; pkce: McpOAuthPkceStart }>();
  private readonly inflightRefreshes = new Map<string, Promise<McpOAuthTokenRecord>>();

  constructor(options: {
    storage: McpOAuthStoragePort;
    cipher?: McpOAuthCipher;
    fetcher?: McpOAuthFetch;
    now?: () => number;
  }) {
    this.storage = options.storage;
    this.cipher = options.cipher ?? {
      encrypt: (plain) => `b64:${Buffer.from(plain, 'utf8').toString('base64')}`,
      decrypt: decodePlainOrBase64McpOAuthToken,
    };
    this.fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Probe the MCP server URL for an RFC 9728 §5.1 401 `WWW-Authenticate`
   * challenge carrying `resource_metadata` and/or `scope`.
   */
  private async probeWwwAuthenticateChallenge(
    mcpServerUrl: string,
  ): Promise<WwwAuthenticateBearerChallenge> {
    const parseIf401 = (res: McpOAuthFetchResponse): WwwAuthenticateBearerChallenge | null => {
      cancelResponseBodyQuietly(res);
      if (res.status !== 401) return null;
      return parseWwwAuthenticateBearerChallenge(getHeaderCaseInsensitive(res, 'www-authenticate'));
    };

    try {
      const postRes = await this.fetcher(mcpServerUrl, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'LobsterAI', version: '1.0.0' },
          },
        }),
      });
      const postChallenge = parseIf401(postRes);
      if (postChallenge) return postChallenge;

      if (postRes.status === 405) {
        const getRes = await this.fetcher(mcpServerUrl, {
          method: 'GET',
          headers: { accept: 'text/event-stream, application/json' },
        });
        const getChallenge = parseIf401(getRes);
        if (getChallenge) return getChallenge;
      }
    } catch {
      // Probe failure is non-fatal; proceed directly to well-known PRM discovery.
    }
    return {};
  }

  /**
   * Discover OAuth 2.1 Authorization Server metadata for a remote MCP server
   * following RFC 9728 (`WWW-Authenticate` 401 probe + path-inserted & root
   * `/.well-known/oauth-protected-resource`) and RFC 8414 / OIDC Discovery
   * (preserving Authorization Server issuer paths).
   */
  async discoverMetadata(mcpServerUrl: string): Promise<McpOAuthMetadata> {
    const parsedServer = new URL(mcpServerUrl);
    const challenge = await this.probeWwwAuthenticateChallenge(mcpServerUrl);

    let authServerIssuer: string = parsedServer.origin;
    let prmResource: string | undefined;
    let prmScopesSupported: string[] | undefined;

    const prmUrls = buildProtectedResourceMetadataUrls(mcpServerUrl, challenge.resourceMetadataUrl);
    for (const prmUrl of prmUrls) {
      try {
        const prm = await this.fetcher(prmUrl, {
          method: 'GET',
          headers: { accept: 'application/json' },
        });
        if (!prm.ok) {
          cancelResponseBodyQuietly(prm);
          continue;
        }
        const doc = (await prm.json()) as Record<string, unknown>;
        if (!doc || typeof doc !== 'object') continue;

        if (Array.isArray(doc.authorization_servers)) {
          const firstIssuer = doc.authorization_servers.find(
            (entry): entry is string => typeof entry === 'string' && isHttpOrHttpsUrl(entry),
          );
          if (firstIssuer) {
            authServerIssuer = firstIssuer;
          }
        }
        if (typeof doc.resource === 'string' && doc.resource.trim()) {
          prmResource = doc.resource.trim();
        }
        if (Array.isArray(doc.scopes_supported)) {
          const scopes = doc.scopes_supported
            .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
            .map((s) => s.trim());
          if (scopes.length > 0) {
            prmScopesSupported = scopes;
          }
        }
        break;
      } catch {
        // Try next PRM candidate URL.
      }
    }

    const asUrls = buildAuthorizationServerDiscoveryUrls(authServerIssuer);
    let lastStatus: number | null = null;
    let lastError: string | null = null;

    for (const asUrl of asUrls) {
      try {
        const asRes = await this.fetcher(asUrl, {
          method: 'GET',
          headers: { accept: 'application/json' },
        });
        lastStatus = asRes.status;
        if (!asRes.ok) {
          cancelResponseBodyQuietly(asRes);
          continue;
        }
        const meta = (await asRes.json()) as Record<string, unknown>;
        if (
          !meta
          || typeof meta !== 'object'
          || typeof meta.authorization_endpoint !== 'string'
          || typeof meta.token_endpoint !== 'string'
        ) {
          lastError = `OAuth metadata for ${mcpServerUrl} missing authorization_endpoint or token_endpoint`;
          continue;
        }

        const asScopes = Array.isArray(meta.scopes_supported)
          ? meta.scopes_supported.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
          : undefined;
        const defaultScope = challenge.scope
          ?? (prmScopesSupported && prmScopesSupported.length > 0 ? prmScopesSupported.join(' ') : undefined);

        return {
          authorizationEndpoint: meta.authorization_endpoint,
          tokenEndpoint: meta.token_endpoint,
          ...(typeof meta.registration_endpoint === 'string' && meta.registration_endpoint.trim()
            ? { registrationEndpoint: meta.registration_endpoint.trim() }
            : {}),
          ...(asScopes && asScopes.length > 0 ? { scopesSupported: asScopes } : {}),
          issuer: typeof meta.issuer === 'string' && meta.issuer.trim()
            ? meta.issuer.trim()
            : authServerIssuer,
          resource: prmResource ?? canonicalResourceUrl(mcpServerUrl),
          ...(defaultScope ? { defaultScope } : {}),
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    if (lastError) {
      throw new Error(lastError);
    }
    throw new Error(
      `OAuth metadata discovery failed for ${mcpServerUrl}${lastStatus !== null ? ` (HTTP ${lastStatus})` : ''}`,
    );
  }

  /**
   * Perform RFC 7591 Dynamic Client Registration (DCR).
   */
  async registerDynamicClient(options: {
    registrationEndpoint: string;
    redirectUri: string;
    clientName?: string;
    scope?: string;
  }): Promise<McpOAuthClientCredentials> {
    const payload: Record<string, unknown> = {
      client_name: options.clientName ?? 'LobsterAI',
      redirect_uris: [options.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(options.scope ? { scope: options.scope } : {}),
    };

    const res = await this.fetcher(options.registrationEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(
        `MCP OAuth dynamic client registration failed (HTTP ${res.status}): ${await res.text()}`,
      );
    }

    const json = (await res.json()) as Record<string, unknown>;
    if (typeof json.client_id !== 'string' || !json.client_id.trim()) {
      throw new Error('MCP OAuth dynamic client registration response missing client_id');
    }

    const clientSecret = typeof json.client_secret === 'string' && json.client_secret.length > 0
      ? json.client_secret
      : undefined;
    const tokenEndpointAuthMethod =
      typeof json.token_endpoint_auth_method === 'string' && json.token_endpoint_auth_method.trim()
        ? json.token_endpoint_auth_method.trim()
        : undefined;

    return {
      clientId: json.client_id.trim(),
      ...(clientSecret ? { clientSecret } : {}),
      ...(tokenEndpointAuthMethod ? { tokenEndpointAuthMethod } : {}),
    };
  }

  beginPkceFlow(options: {
    state?: string;
    serverId: string;
    metadata: McpOAuthMetadata;
    clientId: string;
    clientSecret?: string;
    tokenEndpointAuthMethod?: string;
    redirectUri: string;
    scope?: string;
    resource?: string;
  }): McpOAuthPkceStart {
    const { codeVerifier, codeChallenge } = generatePkcePair();
    const state = options.state ?? randomBytes(16).toString('base64url');
    const effectiveScope = options.scope ?? options.metadata.defaultScope;
    const effectiveResource = options.resource ?? options.metadata.resource;

    const url = new URL(options.metadata.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', options.clientId);
    url.searchParams.set('redirect_uri', options.redirectUri);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    if (effectiveScope) {
      url.searchParams.set('scope', effectiveScope);
    }
    if (effectiveResource) {
      url.searchParams.set('resource', effectiveResource);
    }

    const pkce: McpOAuthPkceStart = {
      state,
      codeVerifier,
      codeChallenge,
      authorizationUrl: url.href,
      tokenEndpoint: options.metadata.tokenEndpoint,
      clientId: options.clientId,
      ...(options.clientSecret ? { clientSecret: options.clientSecret } : {}),
      ...(options.tokenEndpointAuthMethod
        ? { tokenEndpointAuthMethod: options.tokenEndpointAuthMethod }
        : {}),
      redirectUri: options.redirectUri,
      ...(effectiveResource ? { resource: effectiveResource } : {}),
      ...(effectiveScope ? { scope: effectiveScope } : {}),
    };
    this.pendingFlows.set(state, { serverId: options.serverId, pkce });
    return pkce;
  }

  discardPkceFlow(state: string): void {
    this.pendingFlows.delete(state);
  }

  async completePkceFlow(state: string, code: string, signal?: AbortSignal): Promise<McpOAuthTokenRecord> {
    const flow = this.pendingFlows.get(state);
    if (!flow) {
      throw new Error('Unknown or expired MCP OAuth state');
    }
    this.pendingFlows.delete(state);

    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: flow.pkce.redirectUri,
      code_verifier: flow.pkce.codeVerifier,
    });
    if (flow.pkce.resource) {
      params.set('resource', flow.pkce.resource);
    }
    if (flow.pkce.scope) {
      params.set('scope', flow.pkce.scope);
    }

    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };
    applyClientAuthentication(params, headers, {
      clientId: flow.pkce.clientId,
      clientSecret: flow.pkce.clientSecret,
      tokenEndpointAuthMethod: flow.pkce.tokenEndpointAuthMethod,
    });

    const res = await this.fetcher(flow.pkce.tokenEndpoint, {
      signal,
      method: 'POST',
      headers,
      body: params.toString(),
    });
    if (!res.ok) {
      throw new Error(`MCP OAuth token exchange failed (HTTP ${res.status}): ${await res.text()}`);
    }
    const tokenJson = (await res.json()) as Record<string, unknown>;
    if (typeof tokenJson.access_token !== 'string' || !tokenJson.access_token) {
      throw new Error('MCP OAuth token response missing access_token');
    }

    const expiresIn = typeof tokenJson.expires_in === 'number' && Number.isFinite(tokenJson.expires_in)
      ? tokenJson.expires_in
      : undefined;
    const resolvedScope = typeof tokenJson.scope === 'string' && tokenJson.scope.trim()
      ? tokenJson.scope.trim()
      : flow.pkce.scope;

    const record: McpOAuthTokenRecord = {
      serverId: flow.serverId,
      accessToken: tokenJson.access_token,
      ...(typeof tokenJson.refresh_token === 'string' && tokenJson.refresh_token
        ? { refreshToken: tokenJson.refresh_token }
        : {}),
      tokenType: typeof tokenJson.token_type === 'string' && tokenJson.token_type
        ? tokenJson.token_type
        : 'Bearer',
      ...(expiresIn !== undefined ? { expiresAtMs: this.now() + expiresIn * 1000 } : {}),
      ...(resolvedScope ? { scope: resolvedScope } : {}),
      tokenEndpoint: flow.pkce.tokenEndpoint,
      clientId: flow.pkce.clientId,
      ...(flow.pkce.clientSecret ? { clientSecret: flow.pkce.clientSecret } : {}),
      ...(flow.pkce.tokenEndpointAuthMethod
        ? { tokenEndpointAuthMethod: flow.pkce.tokenEndpointAuthMethod }
        : {}),
      ...(flow.pkce.resource ? { resource: flow.pkce.resource } : {}),
      updatedAt: this.now(),
    };
    signal?.throwIfAborted();
    this.saveToken(record);
    return record;
  }

  saveToken(record: McpOAuthTokenRecord): void {
    const encrypted = this.cipher.encrypt(JSON.stringify(record));
    this.storage.set(`${MCP_OAUTH_TOKEN_KV_PREFIX}${record.serverId}`, encrypted);
  }

  getToken(serverId: string): McpOAuthTokenRecord | null {
    const key = `${MCP_OAUTH_TOKEN_KV_PREFIX}${serverId}`;
    const raw = this.storage.get(key);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(this.cipher.decrypt(raw)) as McpOAuthTokenRecord;
      if (!parsed || typeof parsed.accessToken !== 'string' || !parsed.accessToken) {
        return null;
      }
      // Transparently upgrade pre-boot migrated plain/base64 records into
      // OS-keychain `safe:` encryption once safeStorage is available.
      if (!raw.startsWith('safe:')) {
        try {
          const upgraded = this.cipher.encrypt(JSON.stringify(parsed));
          if (upgraded.startsWith('safe:')) {
            this.storage.set(key, upgraded);
          }
        } catch {
          // Best-effort encryption upgrade; original record remains valid.
        }
      }
      return parsed;
    } catch {
      return null;
    }
  }

  deleteToken(serverId: string): void {
    this.storage.delete(`${MCP_OAUTH_TOKEN_KV_PREFIX}${serverId}`);
  }

  /**
   * Resolve fresh HTTP Authorization headers for a remote MCP server,
   * refreshing via `refresh_token` automatically when close to expiry.
   */
  async resolveAuthorizationHeaders(serverId: string): Promise<Record<string, string> | null> {
    let token = this.getToken(serverId);
    if (!token) return null;

    if (token.expiresAtMs !== undefined) {
      const nowMs = this.now();
      const isExpired = token.expiresAtMs <= nowMs;
      const isExpiring = token.expiresAtMs - nowMs <= MCP_OAUTH_REFRESH_LEEWAY_MS;
      if (isExpiring && token.refreshToken && token.tokenEndpoint) {
        token = await this.refreshTokenDeduplicated(token);
      } else if (isExpired) {
        return null;
      }
    }

    return {
      Authorization: `${token.tokenType || 'Bearer'} ${token.accessToken}`,
    };
  }

  /**
   * Check whether the server currently holds a usable (or successfully
   * refreshed) OAuth access token.
   */
  async checkAuthorizationStatus(
    serverId: string,
  ): Promise<{ authorized: boolean; refreshed: boolean }> {
    const before = this.getToken(serverId);
    if (!before || !before.accessToken) {
      return { authorized: false, refreshed: false };
    }
    try {
      const headers = await this.resolveAuthorizationHeaders(serverId);
      if (!headers) {
        return { authorized: false, refreshed: false };
      }
      const after = this.getToken(serverId);
      const refreshed = Boolean(after && after.updatedAt !== before.updatedAt);
      return { authorized: true, refreshed };
    } catch {
      return { authorized: false, refreshed: false };
    }
  }

  private async refreshTokenDeduplicated(
    record: McpOAuthTokenRecord,
  ): Promise<McpOAuthTokenRecord> {
    const existing = this.inflightRefreshes.get(record.serverId);
    if (existing) return existing;

    const promise = this.refreshToken(record).finally(() => {
      if (this.inflightRefreshes.get(record.serverId) === promise) {
        this.inflightRefreshes.delete(record.serverId);
      }
    });
    this.inflightRefreshes.set(record.serverId, promise);
    return promise;
  }

  private async refreshToken(record: McpOAuthTokenRecord): Promise<McpOAuthTokenRecord> {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: record.refreshToken!,
    });
    if (record.resource) {
      params.set('resource', record.resource);
    }
    if (record.scope) {
      params.set('scope', record.scope);
    }

    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };
    applyClientAuthentication(params, headers, {
      clientId: record.clientId,
      clientSecret: record.clientSecret,
      tokenEndpointAuthMethod: record.tokenEndpointAuthMethod,
    });

    const res = await this.fetcher(record.tokenEndpoint!, {
      method: 'POST',
      headers,
      body: params.toString(),
    });
    if (!res.ok) {
      throw new Error(`MCP OAuth token refresh failed for "${record.serverId}" (HTTP ${res.status})`);
    }
    const json = (await res.json()) as Record<string, unknown>;
    if (typeof json.access_token !== 'string' || !json.access_token) {
      throw new Error(`MCP OAuth refresh response for "${record.serverId}" missing access_token`);
    }
    const expiresIn = typeof json.expires_in === 'number' && Number.isFinite(json.expires_in)
      ? json.expires_in
      : undefined;
    const updated: McpOAuthTokenRecord = {
      ...record,
      accessToken: json.access_token,
      refreshToken: typeof json.refresh_token === 'string' && json.refresh_token
        ? json.refresh_token
        : record.refreshToken,
      tokenType: typeof json.token_type === 'string' && json.token_type
        ? json.token_type
        : record.tokenType,
      scope: typeof json.scope === 'string' && json.scope.trim()
        ? json.scope.trim()
        : record.scope,
      expiresAtMs: expiresIn !== undefined ? this.now() + expiresIn * 1000 : record.expiresAtMs,
      updatedAt: this.now(),
    };
    this.saveToken(updated);
    return updated;
  }
}

export interface McpOAuthRefreshSchedulerOptions {
  oauthManager: Pick<McpOAuthManager, 'getToken'>;
  onRefreshDue: (dueServerIds: string[]) => Promise<{ needsReauthIds: string[] }>;
  now?: () => number;
  leewayMs?: number;
  failureBackoffMs?: number;
}

/**
 * Proactive timer scheduler that watches enabled OAuth MCP tokens and triggers
 * a lightweight MCP re-sync shortly before expiry so long-running DSH sessions
 * keep valid bearer tokens without mid-session 401 failures.
 */
export class McpOAuthRefreshScheduler {
  private readonly oauthManager: Pick<McpOAuthManager, 'getToken'>;
  private readonly onRefreshDue: (dueServerIds: string[]) => Promise<{ needsReauthIds: string[] }>;
  private readonly now: () => number;
  private readonly leewayMs: number;
  private readonly failureBackoffMs: number;

  private trackedServerIds: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;
  private readonly failureBackoffByServer = new Map<
    string,
    { tokenUpdatedAt: number; retryAtMs: number; permanent: boolean }
  >();

  constructor(options: McpOAuthRefreshSchedulerOptions) {
    this.oauthManager = options.oauthManager;
    this.onRefreshDue = options.onRefreshDue;
    this.now = options.now ?? (() => Date.now());
    this.leewayMs = options.leewayMs ?? MCP_OAUTH_REFRESH_LEEWAY_MS;
    this.failureBackoffMs = options.failureBackoffMs ?? DEFAULT_REFRESH_FAILURE_BACKOFF_MS;
  }

  updateTrackedServers(serverIds: string[], needsReauthIds: string[] = []): void {
    this.stopped = false;
    this.trackedServerIds = Array.from(new Set(serverIds.filter(Boolean)));
    const trackedSet = new Set(this.trackedServerIds);
    const needsReauthSet = new Set(needsReauthIds);
    const nowMs = this.now();

    for (const [id, state] of this.failureBackoffByServer.entries()) {
      if (!trackedSet.has(id)) {
        this.failureBackoffByServer.delete(id);
        continue;
      }
      const token = this.oauthManager.getToken(id);
      if (!token || token.updatedAt !== state.tokenUpdatedAt || !needsReauthSet.has(id)) {
        this.failureBackoffByServer.delete(id);
      }
    }

    for (const id of needsReauthSet) {
      if (!trackedSet.has(id)) continue;
      const token = this.oauthManager.getToken(id);
      if (!token) continue;
      const existing = this.failureBackoffByServer.get(id);
      if (existing && existing.tokenUpdatedAt === token.updatedAt) continue;
      const canRefresh = Boolean(token.refreshToken && token.tokenEndpoint);
      this.failureBackoffByServer.set(id, {
        tokenUpdatedAt: token.updatedAt,
        retryAtMs: nowMs + this.failureBackoffMs,
        permanent: !canRefresh,
      });
    }

    this.reschedule();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private computeDueTimestampMs(serverId: string): number | null {
    const token = this.oauthManager.getToken(serverId);
    if (!token || token.expiresAtMs === undefined) return null;

    const backoff = this.failureBackoffByServer.get(serverId);
    if (backoff && backoff.tokenUpdatedAt === token.updatedAt) {
      if (backoff.permanent) return null;
      return Math.max(backoff.retryAtMs, token.expiresAtMs - this.leewayMs);
    }

    if (token.refreshToken && token.tokenEndpoint) {
      return token.expiresAtMs - this.leewayMs;
    }

    // Non-refreshable token: schedule right after expiry so the stale server
    // is evicted and the UI flips to RequiresAuthorization.
    return token.expiresAtMs + EXPIRED_NON_REFRESHABLE_GRACE_MS;
  }

  reschedule(): void {
    this.clearTimer();
    if (this.stopped || this.running || this.trackedServerIds.length === 0) return;

    const nowMs = this.now();
    let earliestDueAt: number | null = null;
    for (const serverId of this.trackedServerIds) {
      const dueAt = this.computeDueTimestampMs(serverId);
      if (dueAt === null) continue;
      if (earliestDueAt === null || dueAt < earliestDueAt) {
        earliestDueAt = dueAt;
      }
    }

    if (earliestDueAt === null) return;
    const delayMs = Math.max(50, Math.min(earliestDueAt - nowMs, MAX_REFRESH_TIMER_DELAY_MS));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delayMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.running) return;
    const nowMs = this.now();
    const dueServerIds: string[] = [];
    for (const serverId of this.trackedServerIds) {
      const dueAt = this.computeDueTimestampMs(serverId);
      if (dueAt !== null && dueAt <= nowMs) {
        dueServerIds.push(serverId);
      }
    }

    if (dueServerIds.length === 0) {
      this.reschedule();
      return;
    }

    this.running = true;
    try {
      const result = await this.onRefreshDue(dueServerIds);
      const needsReauthSet = new Set(result.needsReauthIds);
      const afterNow = this.now();

      for (const serverId of dueServerIds) {
        const token = this.oauthManager.getToken(serverId);
        if (needsReauthSet.has(serverId) && token) {
          const canRefresh = Boolean(token.refreshToken && token.tokenEndpoint);
          this.failureBackoffByServer.set(serverId, {
            tokenUpdatedAt: token.updatedAt,
            retryAtMs: afterNow + this.failureBackoffMs,
            permanent: !canRefresh,
          });
        } else {
          this.failureBackoffByServer.delete(serverId);
        }
      }
    } catch {
      const afterNow = this.now();
      for (const serverId of dueServerIds) {
        const token = this.oauthManager.getToken(serverId);
        if (token) {
          this.failureBackoffByServer.set(serverId, {
            tokenUpdatedAt: token.updatedAt,
            retryAtMs: afterNow + this.failureBackoffMs,
            permanent: false,
          });
        }
      }
    } finally {
      this.running = false;
      this.reschedule();
    }
  }
}
