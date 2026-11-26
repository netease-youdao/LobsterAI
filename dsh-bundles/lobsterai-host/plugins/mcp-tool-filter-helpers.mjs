/**
 * Pure helpers for enforcing per-server user `toolFilter` (`include` / `exclude`)
 * on MCP tools registered in DSH.
 *
 * Replicates `@deepseek-ai/dsh-mcp-client`'s exact `publicToolName(serverName, rawName)`
 * naming and hashing rules so exact entries (including dotted, special-character, and
 * >64-char tool names written by `McpToolPicker`) and `*` globs filter accurately.
 *
 * Zero DSH peer imports so Vitest can test this module directly.
 */

import { createHash } from 'node:crypto';

const MAX_PUBLIC_NAME_LENGTH = 64;
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;
const INVALID_GLOB_CHARS = /[^A-Za-z0-9_*-]/g;
const HAS_INVALID_GLOB_CHAR = /[^A-Za-z0-9_*-]/;
const HASH_LENGTH = 12;
const HASHED_SUFFIX_RE = /_[0-9a-f]{12}$/;

/**
 * Exact replica of `@deepseek-ai/dsh-mcp-client`'s `publicToolName(serverName, rawName)`:
 * - Clean `mcp__${serverName}__${rawName}` when `<= 64` chars and only `[A-Za-z0-9_-]`.
 * - Otherwise `${normalized.slice(0, 51)}_${sha256(serverName + '\0' + rawName).slice(0, 12)}`.
 *
 * @param {string} serverName
 * @param {string} rawName
 * @returns {string}
 */
export function publicMcpToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`;
  const normalized = joined.replace(INVALID_NAME_CHARS, '_');
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) {
    return normalized;
  }
  const hash = createHash('sha256')
    .update(`${serverName}\0${rawName}`)
    .digest('hex')
    .slice(0, HASH_LENGTH);
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`;
}

/**
 * Normalize an incoming `toolFilter` (`{ include?, exclude? }`):
 * trims entries, drops blanks and duplicates, freezes the result, and returns
 * `undefined` when both lists are empty.
 *
 * @param {unknown} filter
 * @returns {Readonly<{ include?: readonly string[], exclude?: readonly string[] }> | undefined}
 */
export function normalizeMcpToolFilter(filter) {
  if (!filter || typeof filter !== 'object') return undefined;
  const raw = /** @type {{ include?: unknown, exclude?: unknown }} */ (filter);
  const clean = (list) => {
    if (!Array.isArray(list)) return undefined;
    const seen = new Set();
    const items = [];
    for (const item of list) {
      if (item == null) continue;
      const trimmed = String(item).trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      items.push(trimmed);
    }
    return items.length > 0 ? Object.freeze(items) : undefined;
  };
  const include = clean(raw.include);
  const exclude = clean(raw.exclude);
  if (!include && !exclude) return undefined;
  return Object.freeze({
    ...(include ? { include } : {}),
    ...(exclude ? { exclude } : {}),
  });
}

/**
 * Exact glob semantics shared with LobsterAI's `src/renderer/services/mcpToolFilter.ts`:
 * exact text match when no `*`, otherwise `*` matches any substring (including empty).
 *
 * @param {string} pattern
 * @param {string} value
 * @returns {boolean}
 */
export function matchesMcpToolPattern(pattern, value) {
  if (typeof pattern !== 'string' || typeof value !== 'string') return false;
  const trimmed = pattern.trim();
  if (!trimmed) return false;
  if (!trimmed.includes('*')) return trimmed === value;

  const parts = trimmed.split('*');
  const first = parts[0] ?? '';
  const last = parts[parts.length - 1] ?? '';
  if (first && !value.startsWith(first)) return false;
  let cursor = first.length;
  const endBound = last ? value.length - last.length : value.length;
  if (last && (!value.endsWith(last) || endBound < cursor)) return false;
  for (const part of parts.slice(1, -1)) {
    if (!part) continue;
    const index = value.indexOf(part, cursor);
    if (index === -1 || index + part.length > endBound) return false;
    cursor = index + part.length;
  }
  return true;
}

/**
 * @typedef {{
 *   exactPublicNames: ReadonlySet<string>,
 *   globPatterns: ReadonlyArray<{ raw: string, normalized: string, hasInvalidChars: boolean }>,
 *   isEmpty: boolean,
 * }} CompiledPatternSet
 */

/**
 * @param {string} serverName
 * @param {unknown} patterns
 * @returns {CompiledPatternSet}
 */
function compilePatternSet(serverName, patterns) {
  const exactPublicNames = new Set();
  const globPatterns = [];
  if (!Array.isArray(patterns)) {
    return { exactPublicNames, globPatterns, isEmpty: true };
  }
  for (const rawPattern of patterns) {
    if (typeof rawPattern !== 'string') continue;
    const trimmed = rawPattern.trim();
    if (!trimmed) continue;
    if (!trimmed.includes('*')) {
      exactPublicNames.add(publicMcpToolName(serverName, trimmed));
    } else {
      globPatterns.push({
        raw: trimmed,
        normalized: trimmed.replace(INVALID_GLOB_CHARS, '_'),
        hasInvalidChars: HAS_INVALID_GLOB_CHAR.test(trimmed),
      });
    }
  }
  return {
    exactPublicNames,
    globPatterns,
    isEmpty: exactPublicNames.size === 0 && globPatterns.length === 0,
  };
}

/** @type {WeakMap<object, Map<string, { include: CompiledPatternSet, exclude: CompiledPatternSet }>>} */
const compiledFilterCache = new WeakMap();

/**
 * @param {string} serverName
 * @param {{ include?: readonly string[], exclude?: readonly string[] }} filter
 */
function getCompiledFilter(serverName, filter) {
  if (Object.isFrozen(filter)) {
    let byServer = compiledFilterCache.get(filter);
    if (!byServer) {
      byServer = new Map();
      compiledFilterCache.set(filter, byServer);
    }
    let compiled = byServer.get(serverName);
    if (!compiled) {
      compiled = {
        include: compilePatternSet(serverName, filter.include),
        exclude: compilePatternSet(serverName, filter.exclude),
      };
      byServer.set(serverName, compiled);
    }
    return compiled;
  }
  return {
    include: compilePatternSet(serverName, filter.include),
    exclude: compilePatternSet(serverName, filter.exclude),
  };
}

/**
 * @param {CompiledPatternSet} compiledSet
 * @param {string} publicName
 * @param {string} suffix
 * @returns {boolean}
 */
function matchesCompiledSet(compiledSet, publicName, suffix) {
  if (compiledSet.isEmpty) return false;
  if (compiledSet.exactPublicNames.has(publicName)) return true;
  if (compiledSet.globPatterns.length === 0) return false;

  const isHashed = HASHED_SUFFIX_RE.test(suffix);
  const strippedSuffix = isHashed ? suffix.slice(0, -(HASH_LENGTH + 1)) : null;

  for (const glob of compiledSet.globPatterns) {
    if (!glob.hasInvalidChars && matchesMcpToolPattern(glob.raw, suffix)) {
      return true;
    }
    if (strippedSuffix !== null && matchesMcpToolPattern(glob.normalized, strippedSuffix)) {
      return true;
    }
  }
  return false;
}

/**
 * Evaluate include-then-exclude for a single DSH public MCP tool name belonging
 * to `serverName`.
 *
 * @param {string} serverName
 * @param {string} publicName
 * @param {{ include?: readonly string[], exclude?: readonly string[] } | undefined} filter
 * @returns {boolean}
 */
export function isPublicMcpToolAllowed(serverName, publicName, filter) {
  if (!filter || typeof filter !== 'object') return true;
  if (typeof serverName !== 'string' || !serverName) return true;
  if (typeof publicName !== 'string') return true;

  const prefix = `mcp__${serverName}__`;
  if (!publicName.startsWith(prefix)) return true;

  const compiled = getCompiledFilter(serverName, filter);
  if (compiled.include.isEmpty && compiled.exclude.isEmpty) return true;

  const suffix = publicName.slice(prefix.length);
  const included = compiled.include.isEmpty || matchesCompiledSet(compiled.include, publicName, suffix);
  if (!included) return false;
  if (!compiled.exclude.isEmpty && matchesCompiledSet(compiled.exclude, publicName, suffix)) {
    return false;
  }
  return true;
}

/**
 * Identify the owning MCP server name for `toolName` using the longest matching
 * `mcp__<serverName>__` prefix across registered and filtered server names.
 *
 * @param {string} toolName
 * @param {ReadonlyMap<string, { include?: readonly string[], exclude?: readonly string[] }> | undefined} mcpToolFilters
 * @param {Iterable<string> | undefined} [registeredServerNames]
 * @returns {string | null}
 */
export function resolveMcpServerOwner(toolName, mcpToolFilters, registeredServerNames) {
  if (typeof toolName !== 'string' || !toolName.startsWith('mcp__')) return null;
  if (!mcpToolFilters || mcpToolFilters.size === 0) return null;

  let bestServer = null;
  const consider = (serverName) => {
    if (typeof serverName !== 'string' || !serverName) return;
    if (toolName.startsWith(`mcp__${serverName}__`)) {
      if (bestServer === null || serverName.length > bestServer.length) {
        bestServer = serverName;
      }
    }
  };

  if (registeredServerNames) {
    for (const serverName of registeredServerNames) {
      consider(serverName);
    }
  }
  for (const serverName of mcpToolFilters.keys()) {
    consider(serverName);
  }
  return bestServer;
}

/**
 * Return `true` iff `toolName` belongs to an MCP server with an active user
 * `toolFilter` and is disallowed by that filter.
 *
 * @param {string} toolName
 * @param {ReadonlyMap<string, { include?: readonly string[], exclude?: readonly string[] }> | undefined} mcpToolFilters
 * @param {Iterable<string> | undefined} [registeredServerNames]
 * @returns {boolean}
 */
export function isUserMcpToolDenied(toolName, mcpToolFilters, registeredServerNames) {
  const owner = resolveMcpServerOwner(toolName, mcpToolFilters, registeredServerNames);
  if (!owner) return false;
  const filter = mcpToolFilters?.get(owner);
  if (!filter) return false;
  return !isPublicMcpToolAllowed(owner, toolName, filter);
}

/**
 * Compute the sorted list of global tool names in `restrictableNames` that must
 * be denied due to user per-server `toolFilter` rules.
 *
 * @param {Iterable<string>} restrictableNames
 * @param {ReadonlyMap<string, { include?: readonly string[], exclude?: readonly string[] }> | undefined} mcpToolFilters
 * @param {Iterable<string> | undefined} [registeredServerNames]
 * @returns {string[]}
 */
export function computeDeniedUserMcpTools(restrictableNames, mcpToolFilters, registeredServerNames) {
  if (!mcpToolFilters || mcpToolFilters.size === 0) return [];
  const denied = [];
  for (const name of restrictableNames) {
    if (isUserMcpToolDenied(name, mcpToolFilters, registeredServerNames)) {
      denied.push(name);
    }
  }
  denied.sort();
  return denied;
}
