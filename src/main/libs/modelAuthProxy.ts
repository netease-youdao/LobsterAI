// Unified local model auth proxy facade for DeepSeek Harness (DSH).
// Routes LobsterAI Plan, GitHub Copilot, OpenAI Codex OAuth, and xAI OAuth
// behind standard loopback `/v1/<providerId>/*` endpoints so DSH `pi-ai`
// adapters never persist long-lived tokens on disk.

import { getCopilotLoopbackAuthToken, getCopilotLoopbackBaseUrl } from './copilotLoopbackProxy';
import { readOpenAICodexAuthFile } from './openaiCodexAuth';
import {
  consumeRecentOpenClawTokenProxyQuotaError,
  getOpenClawTokenProxyPort,
  getOpenClawTokenProxyTraceStats,
  type OpenClawTokenProxyConfig,
  startOpenClawTokenProxy,
  stopOpenClawTokenProxy,
} from './openclawTokenProxy';
import { readStoredXaiCredential } from './openclawXaiAuthStore';

export interface OAuthProviderUpstream {
  baseUrl: string;
  headers: Record<string, string>;
}

/**
 * Resolve upstream URL & auth headers for third-party OAuth providers when DSH
 * calls `http://127.0.0.1:<proxyPort>/v1/<providerId>/*`.
 */
export function resolveDefaultOAuthProviderUpstream(
  providerId: string,
): OAuthProviderUpstream | null {
  switch (providerId) {
    case 'github-copilot': {
      const baseUrl = getCopilotLoopbackBaseUrl();
      if (!baseUrl) return null;
      const token = getCopilotLoopbackAuthToken();
      return {
        baseUrl,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      };
    }

    case 'openai-codex': {
      const tokens = readOpenAICodexAuthFile();
      if (!tokens?.accessToken) return null;
      return {
        baseUrl: 'https://chatgpt.com/backend-api/codex',
        headers: {
          authorization: `Bearer ${tokens.accessToken}`,
          ...(tokens.accountId ? { 'chatgpt-account-id': tokens.accountId } : {}),
        },
      };
    }

    case 'xai-oauth': {
      const cred = readStoredXaiCredential();
      if (!cred?.access) return null;
      return {
        baseUrl: 'https://api.x.ai/v1',
        headers: {
          authorization: `Bearer ${cred.access}`,
        },
      };
    }

    default:
      return null;
  }
}

export function startModelAuthProxy(
  config: OpenClawTokenProxyConfig,
): Promise<{ port: number }> {
  return startOpenClawTokenProxy({
    ...config,
    resolveOAuthProviderUpstream:
      config.resolveOAuthProviderUpstream ?? resolveDefaultOAuthProviderUpstream,
  });
}

export const stopModelAuthProxy = stopOpenClawTokenProxy;
export const getModelAuthProxyPort = getOpenClawTokenProxyPort;
export const getModelAuthProxyTraceStats = getOpenClawTokenProxyTraceStats;
export const consumeRecentModelAuthProxyQuotaError = consumeRecentOpenClawTokenProxyQuotaError;
