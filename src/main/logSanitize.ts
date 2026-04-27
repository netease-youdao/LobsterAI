/**
 * Helpers for redacting sensitive values from log messages emitted by the main
 * process. These helpers exist because URLs, request headers, IM payloads and
 * auth responses routinely contain bearer tokens, API keys and PII that must
 * not land in `electron-log` files or stdout.
 *
 * Use `sanitizeUrlForLog` whenever a fully-qualified URL is logged at INFO
 * level — query strings can contain access tokens (e.g. `?access_token=...`)
 * or single-use auth codes (e.g. `lobsterai://auth/callback?code=...`). When a
 * deeper trace is needed, log the raw value at DEBUG level only.
 */

const SENSITIVE_HEADER_RE =
  /(authori[sz]ation|cookie|api[-_]?key|secret|token|password|set-cookie|x-anthropic|x-openai|x-goog|x-novita)/i;

const REDACTED = '***';

/**
 * Drops query string and fragment from a URL so we never log access tokens /
 * one-time codes / refresh tokens that some upstream servers smuggle in URLs.
 *
 * We deliberately use string-based stripping rather than `new URL()`-based
 * reconstruction because the WHATWG URL parser reports `origin === 'null'`
 * for custom schemes (e.g. `lobsterai://auth/callback`) and that would mangle
 * our deep-link logs.
 */
export function sanitizeUrlForLog(rawUrl: string): string {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return '<empty-url>';
  const queryIdx = rawUrl.indexOf('?');
  const hashIdx = rawUrl.indexOf('#');
  let cut = rawUrl.length;
  if (queryIdx !== -1) cut = Math.min(cut, queryIdx);
  if (hashIdx !== -1) cut = Math.min(cut, hashIdx);
  const trimmed = rawUrl.slice(0, cut);
  return trimmed.length > 0 ? trimmed : '<invalid-url>';
}

/**
 * Returns a shallow copy of the headers map with sensitive values replaced by
 * a placeholder. Header names matched case-insensitively against a single
 * regex so adding new providers does not require code changes elsewhere.
 */
export function redactHeadersForLog(
  headers: Record<string, string> | null | undefined,
): Record<string, string> {
  if (!headers || typeof headers !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = SENSITIVE_HEADER_RE.test(name) ? REDACTED : String(value);
  }
  return out;
}
