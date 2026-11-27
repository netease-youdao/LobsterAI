import { type DecisionModelConfigView, DecisionModelProvider } from './constants';

const HTTP_PROTOCOLS = new Set(['http:', 'https:']);

export function isValidDecisionEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return HTTP_PROTOCOLS.has(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function canSaveDecisionModelEndpoint(
  candidate: Pick<DecisionModelConfigView, 'enabled' | 'provider' | 'endpoint'>,
  savedEndpoint: string,
): boolean {
  const endpoint = candidate.endpoint.trim();
  const usesEndpoint = candidate.enabled && candidate.provider === DecisionModelProvider.Compatible;
  // Allow disabling or leaving a legacy configuration with an invalid stored URL.
  if (!usesEndpoint && (!endpoint || endpoint === savedEndpoint)) return true;
  return isValidDecisionEndpoint(endpoint);
}
