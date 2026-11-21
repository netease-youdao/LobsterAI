/**
 * Pure compatibility helpers for `lobster-model-bridge`.
 * Zero DSH peer imports so Vitest can test this module directly.
 */

const OPENAI_COMPLETIONS_API = 'openai-completions';

/**
 * Returns true only when `baseUrl` targets OpenAI's official API host.
 * @param {unknown} baseUrl
 * @returns {boolean}
 */
export function isNativeOpenAIEndpoint(baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0) return false;
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'api.openai.com';
  } catch {
    return false;
  }
}

/**
 * Merge provider-level and model-level pi-ai `compat` flags and apply safe
 * defaults for non-native `openai-completions` endpoints.
 *
 * `@earendil-works/pi-ai` defaults `supportsDeveloperRole` and `supportsStore`
 * to `true` for any OpenAI-completions URL outside its small built-in
 * non-standard list. Reasoning models then send system prompts as
 * `role: "developer"`, which gateways such as Qwen/DashScope and LobsterAI's
 * proxy reject (`developer is not one of ['system', 'assistant', 'user', ...]`).
 *
 * @param {string} modelApi
 * @param {string} modelBaseUrl
 * @param {unknown} providerCompat
 * @param {unknown} modelCompat
 * @returns {Record<string, unknown>}
 */
export function resolveModelCompat(modelApi, modelBaseUrl, providerCompat, modelCompat) {
  const compat = {
    ...(providerCompat && typeof providerCompat === 'object' ? providerCompat : {}),
    ...(modelCompat && typeof modelCompat === 'object' ? modelCompat : {}),
  };

  if (modelApi === OPENAI_COMPLETIONS_API && !isNativeOpenAIEndpoint(modelBaseUrl)) {
    if (compat.supportsDeveloperRole === undefined) {
      compat.supportsDeveloperRole = false;
    }
    if (compat.supportsStore === undefined) {
      compat.supportsStore = false;
    }
  }

  return compat;
}
