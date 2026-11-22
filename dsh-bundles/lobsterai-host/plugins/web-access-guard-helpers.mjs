/**
 * Pure synchronous guard helpers for enforcing LobsterAI's browser/web access
 * policy (`webFetch.enabled`, `blockedHostnames`) and `DshSearchPolicy` inside
 * DSH's monotonic `ctx.tools.guard(...)`.
 *
 * Zero DSH peer imports so Vitest can test this module directly.
 */

export const WEB_FETCH_TOOL_NAME = 'web_fetch';
export const WEB_SEARCH_TOOL_NAME = 'web_search';

export const DSH_SEARCH_POLICY = Object.freeze({
  DeepSeekNativeOnly: 'deepseek_native_only',
  LobsterWebSearchOnly: 'lobster_web_search_only',
  AllowAll: 'allow_all',
});

const DEEPSEEK_SEARCH_ROUTES = new Set([
  'deepseek-official',
  'deepseek-account',
  'deepseek',
  'lobster-deepseek',
]);

const URL_SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):\/\//i;

/**
 * Normalize a single blocked-hostname policy entry (accepting bare hostnames,
 * wildcards like `*.example.com`, or full URLs like `https://www.example.com:8443/path`).
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeHostnamePolicyEntry(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';

  const withoutProtocol = trimmed.replace(URL_SCHEME_PATTERN, '');
  const withoutAuth = withoutProtocol.includes('@')
    ? withoutProtocol.slice(withoutProtocol.lastIndexOf('@') + 1)
    : withoutProtocol;
  const hostWithPort = (withoutAuth.split(/[/?#]/, 1)[0] ?? '').trim().toLowerCase();
  if (!hostWithPort) return '';

  if (hostWithPort.startsWith('[')) {
    const ipv6Match = hostWithPort.match(/^\[([^\]]+)\](?::(\d+))?$/);
    return ipv6Match ? ipv6Match[1].replace(/\.+$/, '') : '';
  }

  // Bare IPv6 address without brackets
  if ((hostWithPort.match(/:/g) ?? []).length > 1) {
    return hostWithPort.replace(/\.+$/, '');
  }

  const hostPortMatch = hostWithPort.match(/^(.+?)(?::(\d+))?$/);
  const hostname = hostPortMatch?.[1]?.replace(/\.+$/, '') ?? '';
  if (!hostname || /\s/.test(hostname)) return '';
  return hostname;
}

/**
 * Deduplicate and normalize a list of blocked hostname rules.
 * @param {unknown} entries
 * @returns {string[]}
 */
export function normalizeHostnamePolicyList(entries) {
  if (!Array.isArray(entries)) return [];
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    const normalized = normalizeHostnamePolicyEntry(entry);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

/**
 * Check whether a target URL violates LobsterAI's blockedHostnames / scheme rules.
 * @param {string} rawUrl
 * @param {readonly string[]} blockedHostnames
 * @returns {{ blocked: boolean, hostname?: string, matchedRule?: string, reason?: string }}
 */
export function isUrlBlockedByHostnames(rawUrl, blockedHostnames) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return {
      blocked: true,
      reason: `Invalid URL "${rawUrl}" rejected by LobsterAI web access policy.`,
    };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      blocked: true,
      reason: `Blocked URL scheme "${parsed.protocol}" — only http/https URLs are allowed by LobsterAI web access policy.`,
    };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  const normalizedRules = normalizeHostnamePolicyList(blockedHostnames);

  for (const rule of normalizedRules) {
    if (rule.startsWith('*.')) {
      const suffix = rule.slice(1);
      if (hostname.endsWith(suffix) && hostname.length > suffix.length) {
        return { blocked: true, hostname, matchedRule: rule };
      }
      continue;
    }
    // `normalizeBrowserHostnameList` auto-prefixes `www.` for 2-label domains
    // (e.g. `example.com` -> `https://www.example.com`), so match both exact
    // hostname and apex when the rule starts with `www.`.
    if (hostname === rule || (rule.startsWith('www.') && hostname === rule.slice(4))) {
      return { blocked: true, hostname, matchedRule: rule };
    }
  }

  return { blocked: false, hostname };
}

/**
 * Monotonic guard evaluator for DSH's `web_fetch` and `web_search` tools.
 * Returns a denial reason string when blocked, or `undefined` when allowed.
 *
 * @param {unknown} toolName
 * @param {unknown} args
 * @param {{ webFetchEnabled?: boolean, blockedHostnames?: readonly string[], searchPolicy?: string }} policy
 * @param {{ llmProvider?: string }} [context]
 * @returns {string | undefined}
 */
export function evaluateWebAccessGuard(toolName, args, policy, context = {}) {
  const normalizedTool = typeof toolName === 'string' ? toolName.trim().toLowerCase() : '';
  if (!normalizedTool) return undefined;

  if (normalizedTool === WEB_FETCH_TOOL_NAME) {
    if (policy?.webFetchEnabled === false) {
      return 'web_fetch is disabled by LobsterAI browser and web access settings.';
    }

    const rawUrl = args && typeof args === 'object' && typeof /** @type {Record<string, unknown>} */ (args).url === 'string'
      ? /** @type {Record<string, string>} */ (args).url.trim()
      : '';
    if (!rawUrl) return undefined;

    const verdict = isUrlBlockedByHostnames(rawUrl, policy?.blockedHostnames ?? []);
    if (verdict.blocked) {
      return verdict.reason
        ?? `Access to "${verdict.hostname}" is blocked by LobsterAI web access policy (blockedHostnames rule: ${verdict.matchedRule}).`;
    }
    return undefined;
  }

  if (normalizedTool === WEB_SEARCH_TOOL_NAME) {
    const searchPolicy = typeof policy?.searchPolicy === 'string' && policy.searchPolicy.trim().length > 0
      ? policy.searchPolicy.trim()
      : DSH_SEARCH_POLICY.DeepSeekNativeOnly;

    if (searchPolicy === DSH_SEARCH_POLICY.LobsterWebSearchOnly) {
      return 'Built-in DSH web_search is disabled by LobsterAI search policy. Use the LobsterAI web-search skill or a configured MCP search server instead.';
    }

    if (searchPolicy === DSH_SEARCH_POLICY.DeepSeekNativeOnly) {
      const llmProvider = typeof context?.llmProvider === 'string'
        ? context.llmProvider.trim().toLowerCase()
        : '';
      if (!llmProvider || !DEEPSEEK_SEARCH_ROUTES.has(llmProvider)) {
        return 'Built-in DSH web_search is restricted to DeepSeek routes by LobsterAI search policy. Use the LobsterAI web-search skill or a configured MCP search server instead.';
      }
    }
    return undefined;
  }

  return undefined;
}
