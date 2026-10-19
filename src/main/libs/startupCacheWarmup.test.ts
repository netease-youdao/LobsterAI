import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  LOBSTERAI_CLIENT_CAPABILITIES,
  LOBSTERAI_CLIENT_CAPABILITIES_HEADER,
  LOBSTERAI_CLIENT_VERSION_HEADER,
} from '../../shared/providers/modelRuntimeProfiles';

const { updateServerModelMetadata } = vi.hoisted(() => ({
  updateServerModelMetadata: vi.fn(),
}));

vi.mock('./claudeSettings', () => ({
  updateServerModelMetadata,
}));

import {
  buildServerModelCapabilityHeaders,
  runStartupCacheWarmup,
} from './startupCacheWarmup';

beforeEach(() => {
  updateServerModelMetadata.mockReset();
});

describe('startup server model warmup', () => {
  test('sends the fixed client capabilities and client version', () => {
    expect(buildServerModelCapabilityHeaders('2026.7.23')).toEqual({
      Accept: 'application/json',
      [LOBSTERAI_CLIENT_CAPABILITIES_HEADER]: LOBSTERAI_CLIENT_CAPABILITIES,
      [LOBSTERAI_CLIENT_VERSION_HEADER]: '2026.7.23',
    });
  });

  test('passes the complete server model metadata into the main cache', async () => {
    const serverModels = [{
      modelId: 'kimi-k3-YoudaoInner',
      modelName: 'Kimi K3',
      provider: 'moonshot',
      apiFormat: 'openai',
      runtimeProfile: 'moonshot-kimi-k3',
      supportsImage: true,
      supportsVideo: true,
      supportsThinking: true,
      supportsToolCalling: true,
      agenticReady: false,
      contextWindow: 1_048_576,
      maxTokens: 8_192,
    }];
    const fetchWithAuth = vi.fn(async (url: string) => {
      if (url.includes('/api/user/quota')) {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            subscriptionStatus: 'free',
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 0, data: serverModels }), {
        status: 200,
      });
    });

    await runStartupCacheWarmup({
      serverBaseUrl: 'https://lobster.test',
      fetchWithAuth,
      appendKeyfromQuery: url => url,
      cachedSubscriptionStatus: 'free',
      clientVersion: '2026.7.23',
      t: key => key,
    });

    expect(updateServerModelMetadata).toHaveBeenCalledWith(serverModels);
    expect(fetchWithAuth).toHaveBeenCalledWith(
      'https://lobster.test/api/models/available',
      expect.objectContaining({
        headers: {
          Accept: 'application/json',
          [LOBSTERAI_CLIENT_CAPABILITIES_HEADER]: LOBSTERAI_CLIENT_CAPABILITIES,
          [LOBSTERAI_CLIENT_VERSION_HEADER]: '2026.7.23',
        },
      }),
    );
  });
});
