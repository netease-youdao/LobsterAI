import type { McpToolFilter } from '../types/mcp';

/**
 * Helpers for editing an MCP server's tool filter as plain text.
 *
 * The filter maps to OpenClaw's `mcp.servers.*.toolFilter`: `include` exposes only
 * the listed tool names, `exclude` hides the listed names. Both accept exact names
 * and simple `*` globs. Tools that are filtered out are never sent to the model,
 * which keeps large MCP servers from inflating every prompt with unused schemas.
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
