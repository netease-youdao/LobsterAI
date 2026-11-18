import { ApiFormat } from './constants';

const CUSTOM_PROVIDER_KEY_PATTERN = /^custom_[0-9]+$/;

/** User-defined providers are keyed custom_0, custom_1, ... */
export const isCustomProviderKey = (providerName: string): boolean => (
  CUSTOM_PROVIDER_KEY_PATTERN.test(providerName)
);

/**
 * Native Gemini (generateContent) is offered only on custom providers; the
 * built-in Gemini provider keeps its own fixed routing.
 */
export const supportsGeminiApiFormatSelection = isCustomProviderKey;

export const usesCustomGeminiApiFormat = (
  providerName: string,
  apiFormat: unknown,
): boolean => apiFormat === ApiFormat.Gemini && supportsGeminiApiFormatSelection(providerName);

const GEMINI_API_VERSION_SEGMENT = /\/v\d+(?:(?:alpha|beta)\d*)?$/i;
const GEMINI_DEFAULT_API_VERSION = '/v1beta';

/**
 * Normalize a custom Gemini base URL to the versioned root that both the
 * Google GenAI SDK (OpenClaw) and LobsterAI's native clients append
 * `/models/{model}:generateContent` to. Keeps any relay path prefix, drops an
 * OpenAI-compat `/openai` suffix, and adds `/v1beta` when no version is given.
 */
export const normalizeGeminiApiBaseUrl = (rawBaseUrl: string): string => {
  let normalized = rawBaseUrl.trim().replace(/\/+$/, '');
  if (!normalized) return normalized;
  const modelsIndex = normalized.search(/\/models(?:\/|$)/);
  if (modelsIndex >= 0) {
    normalized = normalized.slice(0, modelsIndex);
  }
  if (normalized.endsWith('/openai')) {
    normalized = normalized.slice(0, -'/openai'.length);
  }
  return GEMINI_API_VERSION_SEGMENT.test(normalized)
    ? normalized
    : `${normalized}${GEMINI_DEFAULT_API_VERSION}`;
};
