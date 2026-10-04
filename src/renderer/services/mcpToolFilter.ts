import type { McpToolFilter } from '../types/mcp';

/**
 * Helpers for an MCP server's tool filter.
 *
 * The filter maps to OpenClaw's `mcp.servers.*.toolFilter`: `include` exposes only
 * the listed tool names, `exclude` hides the listed names. Both accept exact names
 * and simple `*` globs, matched against the raw MCP tool name. Tools that are
 * filtered out are never sent to the model, which keeps large MCP servers from
 * inflating every prompt with unused schemas.
 */

// Accept one name per line or comma separated, matching how users paste lists.
export const parseMcpToolNameList = (text: string): string[] => {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of text.split(/[\n,]/)) {
    const name = item.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
};

export const formatMcpToolNameList = (names: string[] | undefined): string =>
  (names ?? []).join('\n');

/**
 * Build the filter from the two text areas. Always returns an object so that an
 * edit which clears both lists also clears the stored filter; the main process
 * collapses an empty filter to "no filter".
 */
export const buildMcpToolFilterFromText = (includeText: string, excludeText: string): McpToolFilter => ({
  include: parseMcpToolNameList(includeText),
  exclude: parseMcpToolNameList(excludeText),
});

/** Drops empty lists; undefined means "no filter, every tool is on". */
export const compactMcpToolFilter = (filter: McpToolFilter | undefined): McpToolFilter | undefined => {
  const include = filter?.include?.filter(Boolean) ?? [];
  const exclude = filter?.exclude?.filter(Boolean) ?? [];
  if (include.length === 0 && exclude.length === 0) return undefined;
  return {
    ...(include.length > 0 ? { include } : {}),
    ...(exclude.length > 0 ? { exclude } : {}),
  };
};

/** Same glob rules as OpenClaw's matcher (src/agents/mcp-tool-filter.ts): exact text plus `*`. */
export const matchesMcpToolPattern = (pattern: string, value: string): boolean => {
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
};

/** Include-then-exclude, as OpenClaw applies it when it loads the server's tools. */
export const isMcpToolAllowed = (filter: McpToolFilter | undefined, toolName: string): boolean => {
  const matches = (pattern: string) => matchesMcpToolPattern(pattern, toolName);
  return (
    (!filter?.include?.length || filter.include.some(matches))
    && !filter?.exclude?.some(matches)
  );
};

/**
 * Whether the filter is a plain list of hidden tool names, the shape the tool
 * picker writes. Anything else (an include list, globs) is an advanced rule.
 */
export const isPlainExcludeFilter = (filter: McpToolFilter | undefined): boolean =>
  !filter?.include?.length && (filter?.exclude ?? []).every(pattern => !pattern.includes('*'));

/**
 * The filter the picker stores: exact names of the tools left unchecked.
 * Hidden names the server did not list this time are kept, so a partial
 * listing (say, one missing a toolset) never switches them back on.
 */
export const buildMcpPickerFilter = (
  filter: McpToolFilter | undefined,
  toolNames: string[],
  enabledNames: ReadonlySet<string>,
): McpToolFilter | undefined => {
  const listed = new Set(toolNames);
  const hidden = toolNames.filter(name => !enabledNames.has(name));
  const unlistedHidden = (filter?.exclude ?? []).filter(
    pattern => !pattern.includes('*') && !listed.has(pattern),
  );
  const exclude = Array.from(new Set([...hidden, ...unlistedHidden]));
  return exclude.length > 0 ? { exclude } : undefined;
};

/** Filter entries that match none of the listed tools: typos or renamed tools. */
export const findUnmatchedMcpToolFilterEntries = (
  filter: McpToolFilter | undefined,
  toolNames: string[],
): string[] => {
  const entries = [...(filter?.include ?? []), ...(filter?.exclude ?? [])];
  return Array.from(new Set(entries)).filter(
    pattern => !toolNames.some(name => matchesMcpToolPattern(pattern, name)),
  );
};

export const removeMcpToolFilterEntries = (
  filter: McpToolFilter | undefined,
  entries: string[],
): McpToolFilter | undefined => {
  const removed = new Set(entries);
  return compactMcpToolFilter({
    include: filter?.include?.filter(pattern => !removed.has(pattern)),
    exclude: filter?.exclude?.filter(pattern => !removed.has(pattern)),
  });
};

export const McpToolFilterSummaryKind = {
  All: 'all',
  Hidden: 'hidden',
  Only: 'only',
  Custom: 'custom',
} as const;
export type McpToolFilterSummaryKind = typeof McpToolFilterSummaryKind[keyof typeof McpToolFilterSummaryKind];

/** What the filter does, for places that have no tool list to evaluate it against. */
export const summarizeMcpToolFilter = (
  filter: McpToolFilter | undefined,
): { kind: McpToolFilterSummaryKind; count: number } => {
  const compact = compactMcpToolFilter(filter);
  if (!compact) return { kind: McpToolFilterSummaryKind.All, count: 0 };
  const hasGlob = [...(compact.include ?? []), ...(compact.exclude ?? [])].some(pattern => pattern.includes('*'));
  if (!hasGlob && !compact.include) {
    return { kind: McpToolFilterSummaryKind.Hidden, count: compact.exclude?.length ?? 0 };
  }
  if (!hasGlob && !compact.exclude) {
    return { kind: McpToolFilterSummaryKind.Only, count: compact.include?.length ?? 0 };
  }
  return { kind: McpToolFilterSummaryKind.Custom, count: 0 };
};
