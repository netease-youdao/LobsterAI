/**
 * Bounds the in-app browser's background pages. OpenClaw's own tab cleanup is
 * off for the in-app profile because it closed tabs users had signed in to, so
 * the host closes only pages the user never saw, and only after they idle.
 */

export const AGENT_BROWSER_MAX_PAGES = 12;
export const AGENT_BROWSER_RECLAIM_MIN_IDLE_MS = 30 * 60_000;

export type AgentBrowserPageUsage = {
  pageId: number;
  lastUsedAt: number;
  /** Shown in the visible panel or signed in with a saved credential. */
  retained: boolean;
};

/** Returns the least recently used reclaimable pages above the page limit. */
export function selectAgentBrowserPagesToReclaim(
  pages: readonly AgentBrowserPageUsage[],
  options: {
    now: number;
    keepPageIds: ReadonlySet<number>;
    maxPages?: number;
    minIdleMs?: number;
  },
): number[] {
  const maxPages = options.maxPages ?? AGENT_BROWSER_MAX_PAGES;
  const minIdleMs = options.minIdleMs ?? AGENT_BROWSER_RECLAIM_MIN_IDLE_MS;
  const excess = pages.length - maxPages;
  if (excess <= 0) return [];
  return pages
    .filter(page => (
      !page.retained
      && !options.keepPageIds.has(page.pageId)
      && options.now - page.lastUsedAt >= minIdleMs
    ))
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt)
    .slice(0, excess)
    .map(page => page.pageId);
}
