/**
 * Strict fail-closed access policy helpers for public-facing IM drivers
 * (Telegram, Discord). Kept isolated from `BaseChannelDriver` so domestic/enterprise
 * IM channels keep their existing behavior untouched.
 */

export const StrictAccessPolicy = Object.freeze({
  Open: 'open',
  Allowlist: 'allowlist',
  Pairing: 'pairing',
  Disabled: 'disabled',
});

/**
 * @param {unknown} raw
 * @param {RegExp} [prefixPattern]
 * @returns {string}
 */
export function normalizeAllowlistEntry(raw, prefixPattern) {
  let value = String(raw ?? '').trim();
  if (!value) return '';
  if (value === '*') return '*';
  if (prefixPattern) {
    value = value.replace(prefixPattern, '').trim();
  }
  return value;
}

/**
 * Returns true only when `allowlist` is non-empty and contains either `'*'`
 * or an entry matching one of `candidates` after prefix normalization.
 * Empty or blank-only lists always return false (fail-closed).
 *
 * @param {unknown} allowlist
 * @param {Array<unknown>} candidates
 * @param {RegExp} [prefixPattern]
 * @returns {boolean}
 */
export function matchesStrictAllowlist(allowlist, candidates, prefixPattern) {
  if (!Array.isArray(allowlist) || allowlist.length === 0) return false;
  const normalizedCandidates = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => normalizeAllowlistEntry(candidate, prefixPattern))
    .filter((value) => value && value !== '*');
  if (normalizedCandidates.length === 0) return false;

  for (const rawEntry of allowlist) {
    const entry = normalizeAllowlistEntry(rawEntry, prefixPattern);
    if (!entry) continue;
    if (entry === '*') return true;
    if (normalizedCandidates.includes(entry)) return true;
  }
  return false;
}

/**
 * Evaluates direct-message access for Telegram/Discord.
 * Defaults to fail-closed `allowlist` when `dmPolicy` is omitted or invalid.
 *
 * @param {Record<string, unknown> | undefined} config
 * @param {string} senderId
 * @param {RegExp} [prefixPattern]
 * @returns {boolean}
 */
export function isStrictDirectMessageAllowed(config, senderId, prefixPattern) {
  const policy = String(config?.dmPolicy || StrictAccessPolicy.Allowlist).trim().toLowerCase();
  const allowFrom = Array.isArray(config?.allowFrom) ? config.allowFrom : [];

  if (policy === StrictAccessPolicy.Disabled) {
    return false;
  }
  if (policy === StrictAccessPolicy.Open) {
    const hasRules = allowFrom.some((entry) => normalizeAllowlistEntry(entry, prefixPattern) !== '');
    if (!hasRules) return true;
    return matchesStrictAllowlist(allowFrom, [senderId], prefixPattern);
  }
  if (policy === StrictAccessPolicy.Allowlist || policy === StrictAccessPolicy.Pairing) {
    return matchesStrictAllowlist(allowFrom, [senderId], prefixPattern);
  }
  return false;
}

/**
 * Evaluates group/server message access for Telegram/Discord.
 * Defaults to fail-closed `allowlist` when `groupPolicy` is omitted or invalid.
 *
 * @param {Record<string, unknown> | undefined} config
 * @param {{
 *   groupCandidates: Array<unknown>,
 *   senderId: string,
 *   groupConfig?: { allowFrom?: unknown } | null,
 *   groupPrefixPattern?: RegExp,
 *   senderPrefixPattern?: RegExp,
 * }} options
 * @returns {boolean}
 */
export function isStrictGroupMessageAllowed(config, options) {
  const policy = String(config?.groupPolicy || StrictAccessPolicy.Allowlist).trim().toLowerCase();
  if (policy === StrictAccessPolicy.Disabled) {
    return false;
  }

  const groupAllowFrom = Array.isArray(config?.groupAllowFrom) ? config.groupAllowFrom : [];
  if (policy === StrictAccessPolicy.Allowlist) {
    if (!matchesStrictAllowlist(groupAllowFrom, options.groupCandidates, options.groupPrefixPattern)) {
      return false;
    }
  } else if (policy !== StrictAccessPolicy.Open) {
    return false;
  }

  const scopedAllowFrom = Array.isArray(options.groupConfig?.allowFrom)
    ? options.groupConfig.allowFrom
    : [];
  const hasScopedRules = scopedAllowFrom.some(
    (entry) => normalizeAllowlistEntry(entry, options.senderPrefixPattern) !== '',
  );
  if (hasScopedRules && !matchesStrictAllowlist(scopedAllowFrom, [options.senderId], options.senderPrefixPattern)) {
    return false;
  }

  return true;
}
