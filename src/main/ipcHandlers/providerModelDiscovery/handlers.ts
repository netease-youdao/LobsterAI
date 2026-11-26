import { ipcMain, session } from 'electron';

import {
  ModelDiscoveryErrorCode,
  ProviderDiscoveryProtocol,
  ProviderModelDiscoveryIpcChannel,
  type ProviderModelDiscoveryRequest,
  type ProviderModelDiscoveryResult,
} from '../../../shared/providers';
import {
  discoverProviderModels,
  type DiscoveryFetch,
} from '../../libs/providerModelDiscovery';

export interface ProviderModelDiscoveryHandlerDeps {
  fetch?: DiscoveryFetch;
}

const VALID_PROTOCOLS = new Set<string>(Object.values(ProviderDiscoveryProtocol));

function parseDiscoveryRequest(raw: unknown): ProviderModelDiscoveryRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const baseUrl = typeof record.baseUrl === 'string' ? record.baseUrl.trim() : '';
  const apiProtocol = typeof record.apiProtocol === 'string' ? record.apiProtocol.trim() : '';
  if (!baseUrl || !VALID_PROTOCOLS.has(apiProtocol)) {
    return null;
  }
  const provider = typeof record.provider === 'string' && record.provider.trim().length > 0
    ? record.provider.trim()
    : undefined;
  const apiKey = typeof record.apiKey === 'string' ? record.apiKey : undefined;
  let headers: Record<string, string> | undefined;
  if (record.headers && typeof record.headers === 'object' && !Array.isArray(record.headers)) {
    const entries = Object.entries(record.headers as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string');
    if (entries.length > 0) {
      headers = Object.fromEntries(entries);
    }
  }

  return {
    ...(provider ? { provider } : {}),
    baseUrl,
    apiProtocol: apiProtocol as ProviderDiscoveryProtocol,
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(headers ? { headers } : {}),
  };
}

function sanitizeBaseUrlForLog(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '<invalid-url>';
  }
}

export function registerProviderModelDiscoveryHandlers(
  deps: ProviderModelDiscoveryHandlerDeps = {},
): void {
  // Always default to Electron's session fetch so the "Use System Proxy" toggle
  // (system/PAC/SOCKS vs strict direct) is honored identically to api:fetch.
  const discoveryFetch: DiscoveryFetch = deps.fetch
    ?? ((url, init) => session.defaultSession.fetch(url, init));

  ipcMain.handle(
    ProviderModelDiscoveryIpcChannel.Discover,
    async (_event, rawRequest: unknown): Promise<ProviderModelDiscoveryResult> => {
      const request = parseDiscoveryRequest(rawRequest);
      if (!request) {
        return {
          ok: false,
          code: ModelDiscoveryErrorCode.InvalidBaseUrl,
          message: 'Invalid model discovery request parameters',
        };
      }

      const safeUrl = sanitizeBaseUrlForLog(request.baseUrl);
      const result = await discoverProviderModels(request, { fetch: discoveryFetch });
      if (result.ok === true) {
        console.log(
          `[ProviderModelDiscovery] fetched ${result.models.length} model(s) from ${safeUrl} (${request.apiProtocol})`,
        );
      } else if ('code' in result) {
        const detailSuffix = result.detail ? ` — ${result.detail}` : '';
        console.warn(
          `[ProviderModelDiscovery] failed for ${safeUrl} (${request.apiProtocol}): [${result.code}] ${result.message}${detailSuffix}`,
        );
      }
      return result;
    },
  );
}
