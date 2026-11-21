/**
 * Per-server MCP tool selection (`include` / `exclude`), matched against raw
 * MCP `tools/list` names (exact names and `*` globs).
 *
 * Excluded tools are omitted from model tool schemas and blocked by DSH's
 * synchronous tool execution guard.
 */
export interface McpToolFilter {
  include?: string[];
  exclude?: string[];
}

/**
 * Keep only non-empty trimmed names; drop the filter entirely when both lists
 * end up empty so stored config and DSH sync payloads never carry `{}`.
 */
export function normalizeMcpToolFilter(filter: McpToolFilter | undefined): McpToolFilter | undefined {
  if (!filter || typeof filter !== 'object') return undefined;
  const clean = (list?: unknown): string[] | undefined => {
    if (!Array.isArray(list)) return undefined;
    const seen = new Set<string>();
    const items: string[] = [];
    for (const item of list) {
      if (item == null) continue;
      const trimmed = String(item).trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      items.push(trimmed);
    }
    return items.length > 0 ? items : undefined;
  };
  const include = clean(filter.include);
  const exclude = clean(filter.exclude);
  if (!include && !exclude) return undefined;
  return { ...(include ? { include } : {}), ...(exclude ? { exclude } : {}) };
}
