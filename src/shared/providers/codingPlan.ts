import { ProviderRegistry } from './constants';

export function resolveCodingPlanBaseUrl(
  providerName: string,
  codingPlanEnabled: boolean,
  apiFormat: 'openai' | 'anthropic',
  currentBaseUrl: string,
): { baseUrl: string; effectiveFormat: 'openai' | 'anthropic' } {
  if (!codingPlanEnabled) {
    return { baseUrl: currentBaseUrl, effectiveFormat: apiFormat };
  }
  const def = ProviderRegistry.get(providerName);
  if (!def?.codingPlanSupported || !def.codingPlanUrls) {
    return { baseUrl: currentBaseUrl, effectiveFormat: apiFormat };
  }
  const effectiveFormat = def.preferredCodingPlanFormat ?? apiFormat;
  const url = def.codingPlanUrls[effectiveFormat];
  return { baseUrl: url, effectiveFormat };
}
