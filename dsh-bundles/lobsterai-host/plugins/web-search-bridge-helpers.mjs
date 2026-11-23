/**
 * Pure routing and policy helpers for `@lobsterai/dsh-bundle`'s unified
 * `ctx.web` search provider (`lobster-web-search-bridge`).
 *
 * Routing contract:
 * - Personal DeepSeek official API key routes (`baseURL` on `https://api.deepseek.com`
 *   with a non-empty key, explicitly excluding LobsterAI plan provider `lobsterai-server`
 *   and third-party relays) try DeepSeek native server-side search first and fall back
 *   transparently to LobsterAI's in-app browser search on failure.
 * - All LobsterAI plan models (`lobsterai-server`, including plan DeepSeek) and all
 *   non-DeepSeek / third-party custom models route directly to LobsterAI's in-app
 *   browser search (`WebSearchHost` via `/dsh-bridge/web-search`).
 * - Global `web-search` skill toggles and per-agent `allowedSkillIds` gate both tool
 *   admission (`ready`) and execution (`search`).
 *
 * Zero DSH peer imports so Vitest can test this module directly.
 */

import { WEB_SEARCH_SKILL_ID } from './persona-helpers.mjs';
import { DSH_SEARCH_POLICY, isUrlBlockedByHostnames } from './web-access-guard-helpers.mjs';

export const LOBSTER_WEB_SEARCH_PROVIDER_ID = 'lobster-web-search';
export const LOBSTER_WEB_SEARCH_BRIDGE_PATH = '/dsh-bridge/web-search';
export const DEEPSEEK_OFFICIAL_HOST = 'api.deepseek.com';
export const DEEPSEEK_SEARCH_DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic/v1';
export const DEFAULT_DEEPSEEK_FALLBACK_COOLDOWN_MS = 10 * 60_000;

export const PLAN_PROVIDER_IDS = Object.freeze(new Set(['lobsterai-server']));
export const DEEPSEEK_PERSONAL_PROVIDER_IDS = Object.freeze(new Set([
  'deepseek',
  'lobster-deepseek',
]));

/**
 * Normalize an incoming `searchPolicy` value, defaulting to `allow_all` so
 * unified search works across both personal DeepSeek and in-app browser routes.
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeSearchPolicy(raw) {
  if (typeof raw !== 'string') return DSH_SEARCH_POLICY.AllowAll;
  const trimmed = raw.trim();
  if (
    trimmed === DSH_SEARCH_POLICY.AllowAll
    || trimmed === DSH_SEARCH_POLICY.DeepSeekNativeOnly
    || trimmed === DSH_SEARCH_POLICY.LobsterWebSearchOnly
  ) {
    return trimmed;
  }
  return DSH_SEARCH_POLICY.AllowAll;
}

/**
 * True only for official HTTPS `api.deepseek.com` endpoints (rejecting third-party
 * relays, loopback proxies, and non-HTTPS URLs).
 * @param {unknown} baseURL
 * @returns {boolean}
 */
export function isOfficialDeepSeekBaseUrl(baseURL) {
  if (typeof baseURL !== 'string' || baseURL.trim().length === 0) return false;
  try {
    const parsed = new URL(baseURL.trim());
    return parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === DEEPSEEK_OFFICIAL_HOST;
  } catch {
    return false;
  }
}

/**
 * Determine whether the `web-search` skill toggle and optional per-agent
 * `allowedSkillIds` permit web search in the current session.
 * @param {{ enabledIds?: Set<string> | null, disabledIds?: Set<string> } | undefined} skillsPolicy
 * @param {ReadonlySet<string> | readonly string[] | null | undefined} allowedSkillIds
 * @returns {boolean}
 */
export function isWebSearchEnabledByPolicy(skillsPolicy, allowedSkillIds) {
  if (skillsPolicy?.disabledIds instanceof Set && skillsPolicy.disabledIds.has(WEB_SEARCH_SKILL_ID)) {
    return false;
  }
  if (skillsPolicy?.enabledIds instanceof Set && !skillsPolicy.enabledIds.has(WEB_SEARCH_SKILL_ID)) {
    return false;
  }
  if (allowedSkillIds instanceof Set && !allowedSkillIds.has(WEB_SEARCH_SKILL_ID)) {
    return false;
  }
  if (Array.isArray(allowedSkillIds) && !allowedSkillIds.includes(WEB_SEARCH_SKILL_ID)) {
    return false;
  }
  return true;
}

/**
 * Resolve DeepSeek native Messages search credentials & endpoint when the active
 * route is a personal DeepSeek official API key route. Returns `null` for plan
 * models (`lobsterai-server`), third-party relays, keyless routes, and other vendors.
 *
 * @param {{
 *   llmProvider?: unknown,
 *   providerAuth?: { apiKey?: unknown, baseURL?: unknown } | null,
 *   searchPolicy?: unknown,
 *   deepseekSearchBaseUrl?: unknown,
 * }} params
 * @returns {{ apiKey: string, baseURL: string } | null}
 */
export function resolveDeepSeekNativeSearchTarget(params) {
  const searchPolicy = normalizeSearchPolicy(params?.searchPolicy);
  if (searchPolicy === DSH_SEARCH_POLICY.LobsterWebSearchOnly) {
    return null;
  }
  const provider = typeof params?.llmProvider === 'string'
    ? params.llmProvider.trim().toLowerCase()
    : '';
  if (!provider || PLAN_PROVIDER_IDS.has(provider)) {
    return null;
  }
  const apiKey = typeof params?.providerAuth?.apiKey === 'string'
    ? params.providerAuth.apiKey.trim()
    : '';
  if (!apiKey) {
    return null;
  }

  const overrideBase = typeof params?.deepseekSearchBaseUrl === 'string'
    ? params.deepseekSearchBaseUrl.trim().replace(/\/+$/, '')
    : '';
  if (overrideBase && DEEPSEEK_PERSONAL_PROVIDER_IDS.has(provider)) {
    return { apiKey, baseURL: overrideBase };
  }

  if (isOfficialDeepSeekBaseUrl(params?.providerAuth?.baseURL)) {
    return { apiKey, baseURL: DEEPSEEK_SEARCH_DEFAULT_BASE_URL };
  }

  return null;
}

/**
 * Whether LobsterAI's in-app browser search bridge can serve search requests
 * under the active search policy and host configuration.
 * @param {{
 *   searchPolicy?: unknown,
 *   browserSearchEnabled?: unknown,
 *   bridgeUrl?: unknown,
 * }} params
 * @returns {boolean}
 */
export function isBrowserSearchAvailable(params) {
  const searchPolicy = normalizeSearchPolicy(params?.searchPolicy);
  if (
    searchPolicy === DSH_SEARCH_POLICY.DeepSeekNativeOnly
    || searchPolicy === DSH_SEARCH_POLICY.LobsterWebSearchOnly
  ) {
    return false;
  }
  if (params?.browserSearchEnabled === false) {
    return false;
  }
  return typeof params?.bridgeUrl === 'string' && params.bridgeUrl.trim().length > 0;
}

/**
 * Determine whether `web_search` should be admitted for a model step.
 * @param {{
 *   llmProvider?: unknown,
 *   providerAuth?: { apiKey?: unknown, baseURL?: unknown } | null,
 *   skillsPolicy?: { enabledIds?: Set<string> | null, disabledIds?: Set<string> },
 *   allowedSkillIds?: ReadonlySet<string> | readonly string[] | null,
 *   searchPolicy?: unknown,
 *   browserSearchEnabled?: unknown,
 *   bridgeUrl?: unknown,
 *   deepseekSearchBaseUrl?: unknown,
 * }} params
 * @returns {boolean}
 */
export function isUnifiedWebSearchReady(params) {
  if (!isWebSearchEnabledByPolicy(params?.skillsPolicy, params?.allowedSkillIds)) {
    return false;
  }
  const searchPolicy = normalizeSearchPolicy(params?.searchPolicy);
  if (searchPolicy === DSH_SEARCH_POLICY.LobsterWebSearchOnly) {
    return false;
  }
  if (resolveDeepSeekNativeSearchTarget(params) !== null) {
    return true;
  }
  return isBrowserSearchAvailable(params);
}

/**
 * Filter and normalize search sources returned by either DeepSeek native search
 * or Electron's in-app `WebSearchHost`, stripping blocked hostnames and invalid URLs.
 * @param {unknown} rawSources
 * @param {readonly string[] | undefined} blockedHostnames
 * @returns {Array<{ url: string, title?: string, snippet?: string, summary?: string, publishedAt?: string }>}
 */
export function filterSearchSourcesByPolicy(rawSources, blockedHostnames) {
  if (!Array.isArray(rawSources)) return [];
  const rules = Array.isArray(blockedHostnames) ? blockedHostnames : [];
  const seen = new Set();
  const filtered = [];
  for (const item of rawSources) {
    if (!item || typeof item !== 'object') continue;
    const record = /** @type {Record<string, unknown>} */ (item);
    const url = typeof record.url === 'string' ? record.url.trim() : '';
    if (!url || seen.has(url)) continue;
    if (isUrlBlockedByHostnames(url, rules).blocked) continue;
    seen.add(url);
    const title = typeof record.title === 'string' ? record.title.trim() : '';
    const snippet = typeof record.snippet === 'string' ? record.snippet.trim() : '';
    const summary = typeof record.summary === 'string' ? record.summary.trim() : '';
    const publishedAt = typeof record.publishedAt === 'string' ? record.publishedAt.trim() : '';
    filtered.push({
      url,
      ...(title ? { title } : {}),
      ...(snippet ? { snippet } : {}),
      ...(summary ? { summary } : {}),
      ...(publishedAt ? { publishedAt } : {}),
    });
  }
  return filtered;
}

/**
 * True when an error represents cancellation and must never trigger a fallback.
 * @param {unknown} error
 * @param {AbortSignal | undefined} signal
 * @returns {boolean}
 */
export function isSearchAbortError(error, signal) {
  if (signal?.aborted === true) return true;
  if (!error || typeof error !== 'object') return false;
  const record = /** @type {Record<string, unknown>} */ (error);
  return record.code === 'WEB_ABORTED' || record.name === 'AbortError';
}

/**
 * True when a DeepSeek native search error indicates an unsupported endpoint/model,
 * missing native search block, or auth rejection where cooling down avoids repeated
 * wasted roundtrips before falling back to in-app browser search.
 * @param {unknown} error
 * @returns {boolean}
 */
export function shouldCooldownDeepSeekNativeError(error) {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP (400|401|403|404)\b/i.test(message)
    || /no web_search_tool_result/i.test(message)
    || /model not exist/i.test(message);
}
