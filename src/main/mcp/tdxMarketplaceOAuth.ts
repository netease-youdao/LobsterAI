import { setTimeout as delay } from 'node:timers/promises';

import { getServerApiBaseUrl } from '../libs/endpoints';
import type { McpOAuthClientCredentials, McpOAuthManager } from './mcpOAuthManager';

export const TDX_RESOURCE = 'https://txmcp.tdx.com.cn:3001/txmcp';
const TDX_ISSUER = 'https://auth.tdx.com.cn';
const READ_SCOPE = 'mcp.read';

interface TdxSession {
  state: string;
  claimToken: string;
  redirectUri: string;
  clientId: string;
  authorizationEndpoint: string;
}

export async function runTdxMarketplaceLogin(options: {
  oauthManager: McpOAuthManager;
  serverId: string;
  getAccessToken: () => string | undefined;
  openExternal: (url: string) => Promise<void>;
  signal: AbortSignal;
}): Promise<void> {
  const { oauthManager, serverId, getAccessToken, openExternal } = options;
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(300_000)]);
  const sessionsUrl = getServerApiBaseUrl() + '/api/connectors/tdx/oauth/sessions';

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

  const session = await post<TdxSession>('', {}, signal);
  const claim = { state: session.state, claimToken: session.claimToken };
  try {
    const metadata = await oauthManager.discoverMetadata(TDX_RESOURCE);
    if (metadata.issuer !== TDX_ISSUER) throw new Error('Unexpected Tongdaxin OAuth issuer');
    const authorizationEndpoint = new URL(session.authorizationEndpoint || metadata.authorizationEndpoint);
    if (authorizationEndpoint.origin !== TDX_ISSUER || authorizationEndpoint.username || authorizationEndpoint.password) {
      throw new Error('Invalid Tongdaxin authorization endpoint');
    }
    let client: McpOAuthClientCredentials;
    if (session.clientId) {
      client = { clientId: session.clientId, tokenEndpointAuthMethod: 'none' };
    } else if (metadata.registrationEndpoint) {
      client = await oauthManager.registerDynamicClient({
        registrationEndpoint: metadata.registrationEndpoint,
        redirectUri: session.redirectUri,
        scope: READ_SCOPE,
      });
    } else {
      throw new Error('通达信尚未配置 LobsterAI 客户端');
    }
    signal.throwIfAborted();
    const flow = oauthManager.beginPkceFlow({
      ...client,
      state: session.state,
      serverId,
      metadata: { ...metadata, authorizationEndpoint: authorizationEndpoint.href },
      resource: TDX_RESOURCE,
      redirectUri: session.redirectUri,
      scope: READ_SCOPE,
    });
    await openExternal(flow.authorizationUrl);
    for (;;) {
      const result = await post<{ status: string; code: string }>('/claim', claim, signal);
      if (result.status === 'received' && result.code) {
        await oauthManager.completePkceFlow(flow.state, result.code, signal);
        return;
      }
      if (result.status === 'denied') throw new Error('通达信授权未完成，请重新连接');
      if (result.status !== 'pending') throw new Error('TIMEOUT');
      await delay(1500, undefined, { signal });
    }
  } catch (error) {
    if (options.signal.aborted) throw new Error('CANCELLED');
    if (signal.aborted) throw new Error('TIMEOUT');
    throw error;
  } finally {
    oauthManager.discardPkceFlow(session.state);
    void post('/cancel', claim, AbortSignal.timeout(3000)).catch(() => {
      // An unreachable relay also expires the session in Redis.
    });
  }
}
