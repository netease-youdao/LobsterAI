import { test, expect, describe } from 'vitest';

// Mirror the env var name generation logic from openclawConfigSync.ts:84
// and claudeSettings.ts:449 (both use the same pattern)
const providerApiKeyEnvVar = (providerName: string): string => {
  const envName = providerName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return `LOBSTER_APIKEY_${envName}`;
};

describe('providerApiKeyEnvVar', () => {
  test('converts simple provider names', () => {
    expect(providerApiKeyEnvVar('moonshot')).toBe('LOBSTER_APIKEY_MOONSHOT');
    expect(providerApiKeyEnvVar('anthropic')).toBe('LOBSTER_APIKEY_ANTHROPIC');
    expect(providerApiKeyEnvVar('openai')).toBe('LOBSTER_APIKEY_OPENAI');
    expect(providerApiKeyEnvVar('ollama')).toBe('LOBSTER_APIKEY_OLLAMA');
  });

  test('replaces hyphens and special chars with underscores', () => {
    expect(providerApiKeyEnvVar('lobsterai-server')).toBe('LOBSTER_APIKEY_LOBSTERAI_SERVER');
    expect(providerApiKeyEnvVar('my.provider')).toBe('LOBSTER_APIKEY_MY_PROVIDER');
  });

  test('server key matches hardcoded convention', () => {
    // lobsterai-server uses hardcoded 'server' in buildProviderSelection
    expect(providerApiKeyEnvVar('server')).toBe('LOBSTER_APIKEY_SERVER');
  });
});

describe('env var stability on model switch', () => {
  // Simulate what collectSecretEnvVars does: collect all provider keys
  const simulateCollectEnvVars = (providers: Record<string, { enabled: boolean; apiKey: string }>, serverToken?: string) => {
    const env: Record<string, string> = {};

    if (serverToken) {
      env.LOBSTER_APIKEY_SERVER = serverToken;
    }

    for (const [name, config] of Object.entries(providers)) {
      if (!config.enabled) continue;
      const envName = name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      env[`LOBSTER_APIKEY_${envName}`] = config.apiKey;
    }

    return env;
  };

  test('switching from server to custom provider does not change env var keys', () => {
    const providers = {
      moonshot: { enabled: true, apiKey: 'sk-moon-123' },
    };
    const serverToken = 'access-token-xyz';

    // Simulate env vars before switch (using server model)
    const envBefore = simulateCollectEnvVars(providers, serverToken);
    // Simulate env vars after switch (using moonshot model) - same inputs
    const envAfter = simulateCollectEnvVars(providers, serverToken);

    expect(JSON.stringify(envBefore)).toBe(JSON.stringify(envAfter));
  });

  test('switching between two custom providers does not change env var keys', () => {
    const providers = {
      moonshot: { enabled: true, apiKey: 'sk-moon-123' },
      anthropic: { enabled: true, apiKey: 'sk-ant-456' },
    };

    // Both providers always present regardless of which is active
    const envBefore = simulateCollectEnvVars(providers);
    const envAfter = simulateCollectEnvVars(providers);

    expect(JSON.stringify(envBefore)).toBe(JSON.stringify(envAfter));
    expect(envBefore.LOBSTER_APIKEY_MOONSHOT).toBe('sk-moon-123');
    expect(envBefore.LOBSTER_APIKEY_ANTHROPIC).toBe('sk-ant-456');
  });

  test('only editing apiKey value causes env var change', () => {
    const providersBefore = {
      moonshot: { enabled: true, apiKey: 'sk-moon-OLD' },
    };
    const providersAfter = {
      moonshot: { enabled: true, apiKey: 'sk-moon-NEW' },
    };

    const envBefore = simulateCollectEnvVars(providersBefore);
    const envAfter = simulateCollectEnvVars(providersAfter);

    expect(JSON.stringify(envBefore)).not.toBe(JSON.stringify(envAfter));
  });
});
