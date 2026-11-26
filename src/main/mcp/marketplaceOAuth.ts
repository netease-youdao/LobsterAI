import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { getServerApiBaseUrl } from '../libs/endpoints';
import type { McpOAuthClientCredentials, McpOAuthManager } from './mcpOAuthManager';

export const TDX_RESOURCE = 'https://txmcp.tdx.com.cn:3001/txmcp';
export const GITHUB_RESOURCE = 'https://api.githubcopilot.com/mcp/';
const GITHUB_AUTHORIZE = 'https://github.com/login/oauth/authorize';
const TDX_ISSUER = 'https://auth.tdx.com.cn';
const READ_SCOPE = 'mcp.read';

interface MarketplaceSession {
  state: string;
  claimToken: string;
  redirectUri: string;
  clientId: string;
  authorizationEndpoint: string;
}

interface ClaimResult {
  status: string;
  code?: string;
  accessToken?: string;
  expiresIn?: number | null;
}

interface LoginOptions {
  provider: 'github' | 'tdx';
  oauthManager: McpOAuthManager;
  serverId: string;
  getAccessToken: () => string | undefined;
  openExternal: (url: string) => Promise<void>;
  signal: AbortSignal;
}

export async function runMarketplaceLogin(options: LoginOptions): Promise<void> {
  const { provider, oauthManager, serverId, getAccessToken, openExternal } = options;
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(300_000)]);
  const sessionsUrl = getServerApiBaseUrl() + `/api/connectors/${provider}/oauth/sessions`;

  async function post<T>(suffix: string, body: object, requestSignal: AbortSignal): Promise<T> {
    const accessToken = getAccessToken();
    if (!accessToken) throw new Error('CANCELLED');
    const response = await fetch(sessionsUrl + suffix, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: requestSignal,
    });
    if (!response.ok) throw new Error('LobsterAI OAuth session: HTTP ' + response.status);
    const result = await response.json();
    if (result?.code !== 0 || !result.data) throw new Error(result?.message || 'OAuth session unavailable');
    return result.data as T;
  }

  const session = await post<MarketplaceSession>('', {}, signal);
  const claim = { state: session.state, claimToken: session.claimToken };
  try {
    const github = provider === 'github';
    const githubFlow = github ? beginGitHubLogin(session) : undefined;
    const url = githubFlow?.url ?? await beginTdxLogin(options, session, signal);
    signal.throwIfAborted();
    await openExternal(url);
    for (;;) {
      const result = await post<ClaimResult>('/claim', {
        ...claim, codeVerifier: githubFlow?.verifier,
      }, signal);
      if (result.status === 'received') {
        signal.throwIfAborted();
        if (!getAccessToken()) throw new Error('CANCELLED');
        if (github) {
          if (!result.accessToken) throw new Error('GitHub 授权未完成，请重新连接');
          const now = Date.now();
          oauthManager.saveToken({
            serverId,
            resource: GITHUB_RESOURCE,
            accessToken: result.accessToken,
            tokenType: 'Bearer',
            expiresAtMs: result.expiresIn == null ? undefined : now + result.expiresIn * 1000,
            updatedAt: now,
          });
        } else {
          if (!result.code) throw new Error('通达信授权未完成，请重新连接');
          await oauthManager.completePkceFlow(session.state, result.code, signal);
        }
        return;
      }
      if (result.status === 'denied') throw new Error(`${github ? 'GitHub' : '通达信'}授权未完成，请重新连接`);
      if (result.status !== 'pending') throw new Error('TIMEOUT');
      await delay(1500, undefined, { signal });
    }
  } catch (error) {
    if (options.signal.aborted) throw new Error('CANCELLED');
    if (signal.aborted) throw new Error('TIMEOUT');
    throw error;
  } finally {
    if (provider === 'tdx') oauthManager.discardPkceFlow(session.state);
    void post('/cancel', claim, AbortSignal.timeout(3000)).catch(() => {
      // An unreachable relay also expires the session in Redis.
    });
  }
}

function beginGitHubLogin(session: MarketplaceSession): { url: string; verifier: string } {
  if (session.authorizationEndpoint !== GITHUB_AUTHORIZE || !session.clientId) {
    throw new Error('GitHub 连接器授权配置无效');
  }
  const verifier = randomBytes(32).toString('base64url');
  const url = new URL(GITHUB_AUTHORIZE);
  url.search = new URLSearchParams({
    client_id: session.clientId, redirect_uri: session.redirectUri, state: session.state,
    response_type: 'code', scope: 'repo', code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  }).toString();
  return { url: url.href, verifier };
}

async function beginTdxLogin(options: LoginOptions, session: MarketplaceSession, signal: AbortSignal): Promise<string> {
  const metadata = await options.oauthManager.discoverMetadata(TDX_RESOURCE);
  if (metadata.issuer !== TDX_ISSUER) throw new Error('Unexpected Tongdaxin OAuth issuer');
  const authorizationEndpoint = new URL(session.authorizationEndpoint || metadata.authorizationEndpoint);
  if (authorizationEndpoint.origin !== TDX_ISSUER || authorizationEndpoint.username || authorizationEndpoint.password) {
    throw new Error('Invalid Tongdaxin authorization endpoint');
  }
  let client: McpOAuthClientCredentials;
  if (session.clientId) {
    client = { clientId: session.clientId, tokenEndpointAuthMethod: 'none' };
  } else if (metadata.registrationEndpoint) {
    client = await options.oauthManager.registerDynamicClient({
      registrationEndpoint: metadata.registrationEndpoint,
      redirectUri: session.redirectUri,
      scope: READ_SCOPE,
    });
  } else {
    throw new Error('通达信尚未配置 LobsterAI 客户端');
  }
  signal.throwIfAborted();
  const flow = options.oauthManager.beginPkceFlow({
    ...client,
    state: session.state,
    serverId: options.serverId,
    metadata: { ...metadata, authorizationEndpoint: authorizationEndpoint.href },
    resource: TDX_RESOURCE,
    redirectUri: session.redirectUri,
    scope: READ_SCOPE,
  });
  return flow.authorizationUrl;
}
