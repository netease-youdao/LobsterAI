import {
  LOBSTERAI_CLIENT_CAPABILITIES,
  LOBSTERAI_CLIENT_CAPABILITIES_HEADER,
  LOBSTERAI_CLIENT_VERSION_HEADER,
} from '../../shared/providers/modelRuntimeProfiles';
import { authQuotaGateStateFromQuota, normalizeAuthQuota } from '../authQuota';
import {
  type ServerModelMetadataInput,
  updateServerModelMetadata,
} from './claudeSettings';

export type ServerModelEntry = ServerModelMetadataInput;

export type StartupCacheWarmupDeps = {
  serverBaseUrl: string;
  fetchWithAuth: (url: string, options?: RequestInit) => Promise<Response>;
  appendKeyfromQuery: (url: string) => string;
  cachedSubscriptionStatus: string;
  clientVersion: string;
  t: (key: string) => string;
};

export type StartupCacheWarmupResult = {
  subscriptionStatus: string;
  mediaGenerationEntitled: boolean;
};

const WARMUP_TIMEOUT = 5000;

export const buildServerModelCapabilityHeaders = (
  clientVersion: string,
): Record<string, string> => ({
  Accept: 'application/json',
  [LOBSTERAI_CLIENT_CAPABILITIES_HEADER]: LOBSTERAI_CLIENT_CAPABILITIES,
  [LOBSTERAI_CLIENT_VERSION_HEADER]: clientVersion,
});

/**
 * Pre-warm quota and model caches so provider resolution and config sync
 * see real server data instead of empty defaults.
 *
 * Without this, cachedSubscriptionStatus starts as 'free' and serverModelMetadataCache
 * is empty. resolveMatchedProvider then falls back to tryLobsteraiServerFallback
 * for every call, and the renderer's subsequent auth responses trigger redundant
 * syncOpenClawConfig calls during the gateway startup window.
 */
export async function runStartupCacheWarmup(deps: StartupCacheWarmupDeps): Promise<StartupCacheWarmupResult> {
  const {
    serverBaseUrl,
    fetchWithAuth,
    appendKeyfromQuery,
    cachedSubscriptionStatus,
    clientVersion,
    t,
  } = deps;

  let subscriptionStatus = cachedSubscriptionStatus;
  let mediaGenerationEntitled = false;

  await Promise.allSettled([
    (async () => {
      try {
        const resp = await fetchWithAuth(`${serverBaseUrl}/api/user/quota`, {
          signal: AbortSignal.timeout(WARMUP_TIMEOUT),
        });
        if (!resp.ok) return;
        const body = (await resp.json()) as { code: number; data: Record<string, unknown> };
        if (body.code !== 0 || !body.data) return;
        const quota = normalizeAuthQuota(body.data, {
          freePlanName: t('authPlanFree'),
          standardPlanName: t('authPlanStandard'),
          fallbackSubscriptionStatus: cachedSubscriptionStatus,
        });
        const gateState = authQuotaGateStateFromQuota(quota);
        subscriptionStatus = gateState.subscriptionStatus;
        mediaGenerationEntitled = gateState.mediaGenerationEntitled;
        console.log(`[Main] startup cache warmup: subscription=${gateState.subscriptionStatus}, mediaEntitled=${gateState.mediaGenerationEntitled}`);
      } catch (err) {
        console.debug('[Main] startup cache warmup: quota fetch failed (non-fatal):', err);
      }
    })(),
    (async () => {
      try {
        const url = appendKeyfromQuery(`${serverBaseUrl}/api/models/available`);
        const resp = await fetchWithAuth(url, {
          headers: buildServerModelCapabilityHeaders(clientVersion),
          signal: AbortSignal.timeout(WARMUP_TIMEOUT),
        });
        if (!resp.ok) return;
        const data = (await resp.json()) as { code: number; data: ServerModelEntry[] };
        if (data.code !== 0 || !data.data) return;
        updateServerModelMetadata(data.data);
        console.log(`[Main] startup cache warmup: loaded ${data.data.length} server models`);
      } catch (err) {
        console.debug('[Main] startup cache warmup: models fetch failed (non-fatal):', err);
      }
    })(),
  ]);

  return { subscriptionStatus, mediaGenerationEntitled };
}
