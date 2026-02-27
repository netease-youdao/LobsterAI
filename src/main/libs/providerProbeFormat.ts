export type ProviderApiFormat = 'anthropic' | 'openai' | 'antigravity' | 'native' | string | undefined;

/**
 * Decide which protocol should be used for provider connectivity probes in Settings.
 * Antigravity OAuth resolves to the local compatibility proxy, which accepts /v1/messages.
 */
export function shouldUseAnthropicConnectionProbe(
  provider: string,
  apiFormat: ProviderApiFormat
): boolean {
  const normalizedProvider = provider.trim().toLowerCase();
  if (normalizedProvider === 'antigravity') {
    return true;
  }
  return apiFormat === 'anthropic';
}

