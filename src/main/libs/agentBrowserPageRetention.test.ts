import { describe, expect, test } from 'vitest';

import {
  AGENT_BROWSER_MAX_PAGES,
  AGENT_BROWSER_RECLAIM_MIN_IDLE_MS,
  type AgentBrowserPageUsage,
  selectAgentBrowserPagesToReclaim,
} from './agentBrowserPageRetention';

const NOW = 10 * AGENT_BROWSER_RECLAIM_MIN_IDLE_MS;
const IDLE = NOW - AGENT_BROWSER_RECLAIM_MIN_IDLE_MS;

const page = (pageId: number, overrides: Partial<AgentBrowserPageUsage> = {}): AgentBrowserPageUsage => ({
  pageId,
  lastUsedAt: IDLE,
  retained: false,
  ...overrides,
});

describe('selectAgentBrowserPagesToReclaim', () => {
  test('keeps every page while the page count is within the limit', () => {
    const pages = Array.from({ length: AGENT_BROWSER_MAX_PAGES }, (_, index) => page(index + 1));

    expect(selectAgentBrowserPagesToReclaim(pages, { now: NOW, keepPageIds: new Set() })).toEqual([]);
  });

  test('closes the least recently used idle pages above the limit', () => {
    const pages = [
      page(1, { lastUsedAt: IDLE - 2 }),
      page(2, { lastUsedAt: IDLE - 3 }),
      page(3, { lastUsedAt: IDLE - 1 }),
      page(4),
    ];

    expect(selectAgentBrowserPagesToReclaim(pages, {
      now: NOW,
      keepPageIds: new Set(),
      maxPages: 2,
    })).toEqual([2, 1]);
  });

  test('never closes retained, kept or recently used pages, even above the limit', () => {
    const pages = [
      page(1, { retained: true, lastUsedAt: 0 }),
      page(2, { lastUsedAt: 0 }),
      page(3, { lastUsedAt: IDLE + 1 }),
      page(4),
    ];

    expect(selectAgentBrowserPagesToReclaim(pages, {
      now: NOW,
      keepPageIds: new Set([2]),
      maxPages: 1,
    })).toEqual([4]);
  });
});
