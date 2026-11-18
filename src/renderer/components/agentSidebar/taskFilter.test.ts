import { describe, expect, test } from 'vitest';

import { CoworkSessionStatusValue, type CoworkSessionSummary } from '../../types/cowork';
import {
  buildSidebarTaskFilterQuery,
  DEFAULT_SIDEBAR_TASK_FILTER,
  getSidebarTaskFilterUpdatedSince,
  isSidebarTaskFilterActive,
  matchesSidebarTaskFilter,
  reconcileSidebarTaskFilterResults,
  type SidebarTaskFilter,
  type SidebarTaskRuntimeState,
  SidebarTaskStatusFilter,
  SidebarTaskTimeFilter,
} from './taskFilter';

// 2026-11-10 15:30 local time.
const NOW = new Date(2026, 10, 10, 15, 30).getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

const emptyRuntime: SidebarTaskRuntimeState = {
  completedUnreadSessionIds: new Set(),
  pendingPermissionSessionIds: new Set(),
};

const makeSession = (
  id: string,
  status: CoworkSessionSummary['status'],
  updatedAt: number,
): CoworkSessionSummary => ({
  id,
  title: id,
  status,
  pinned: false,
  agentId: 'main',
  createdAt: updatedAt,
  updatedAt,
} as CoworkSessionSummary);

const filterOf = (
  status: SidebarTaskFilter['status'],
  time: SidebarTaskFilter['time'] = SidebarTaskTimeFilter.All,
): SidebarTaskFilter => ({ status, time });

describe('isSidebarTaskFilterActive', () => {
  test('is inactive only when both dimensions are "all"', () => {
    expect(isSidebarTaskFilterActive(DEFAULT_SIDEBAR_TASK_FILTER)).toBe(false);
    expect(isSidebarTaskFilterActive(filterOf(SidebarTaskStatusFilter.Running))).toBe(true);
    expect(isSidebarTaskFilterActive(filterOf(SidebarTaskStatusFilter.All, SidebarTaskTimeFilter.Today)))
      .toBe(true);
  });
});

describe('getSidebarTaskFilterUpdatedSince', () => {
  test('counts today as the first day of each range', () => {
    expect(getSidebarTaskFilterUpdatedSince(SidebarTaskTimeFilter.All, NOW)).toBeUndefined();
    expect(getSidebarTaskFilterUpdatedSince(SidebarTaskTimeFilter.Today, NOW))
      .toBe(new Date(2026, 10, 10).getTime());
    expect(getSidebarTaskFilterUpdatedSince(SidebarTaskTimeFilter.Last7Days, NOW))
      .toBe(new Date(2026, 10, 4).getTime());
    expect(getSidebarTaskFilterUpdatedSince(SidebarTaskTimeFilter.Last30Days, NOW))
      .toBe(new Date(2026, 9, 12).getTime());
  });
});

describe('buildSidebarTaskFilterQuery', () => {
  test('maps stored statuses to a status condition', () => {
    expect(buildSidebarTaskFilterQuery(filterOf(SidebarTaskStatusFilter.Running), emptyRuntime, NOW))
      .toEqual({ statuses: [CoworkSessionStatusValue.Running] });
    expect(buildSidebarTaskFilterQuery(
      filterOf(SidebarTaskStatusFilter.Error, SidebarTaskTimeFilter.Today),
      emptyRuntime,
      NOW,
    )).toEqual({
      statuses: [CoworkSessionStatusValue.Error],
      updatedSince: new Date(2026, 10, 10).getTime(),
    });
  });

  test('maps renderer-only states to the sessions that carry them', () => {
    const runtime: SidebarTaskRuntimeState = {
      completedUnreadSessionIds: new Set(['unread-1', 'unread-2']),
      pendingPermissionSessionIds: new Set(['waiting']),
    };
    expect(buildSidebarTaskFilterQuery(filterOf(SidebarTaskStatusFilter.CompletedUnread), runtime, NOW))
      .toEqual({ sessionIds: ['unread-1', 'unread-2'] });
    expect(buildSidebarTaskFilterQuery(filterOf(SidebarTaskStatusFilter.PendingPermission), runtime, NOW))
      .toEqual({ sessionIds: ['waiting'] });
  });

  test('returns null when a renderer-only state has no sessions', () => {
    expect(buildSidebarTaskFilterQuery(filterOf(SidebarTaskStatusFilter.CompletedUnread), emptyRuntime, NOW))
      .toBeNull();
    expect(buildSidebarTaskFilterQuery(filterOf(SidebarTaskStatusFilter.PendingPermission), emptyRuntime, NOW))
      .toBeNull();
  });
});

describe('matchesSidebarTaskFilter', () => {
  test('applies the status and the time range together', () => {
    const filter = filterOf(SidebarTaskStatusFilter.Running, SidebarTaskTimeFilter.Today);
    expect(matchesSidebarTaskFilter(makeSession('a', 'running', NOW - 1000), filter, emptyRuntime, NOW))
      .toBe(true);
    expect(matchesSidebarTaskFilter(makeSession('b', 'completed', NOW - 1000), filter, emptyRuntime, NOW))
      .toBe(false);
    expect(matchesSidebarTaskFilter(makeSession('c', 'running', NOW - DAY_MS), filter, emptyRuntime, NOW))
      .toBe(false);
  });
});

describe('reconcileSidebarTaskFilterResults', () => {
  test('prefers live state, drops sessions that stopped matching, and sorts newest first', () => {
    const filter = filterOf(SidebarTaskStatusFilter.Running);
    const queried = [
      makeSession('finished', 'running', NOW - 3000),
      makeSession('older', 'running', NOW - 5000),
      makeSession('newer', 'running', NOW - 1000),
    ];
    const live = [makeSession('finished', 'completed', NOW - 500)];

    expect(reconcileSidebarTaskFilterResults(queried, live, filter, emptyRuntime, NOW).map(s => s.id))
      .toEqual(['newer', 'older']);
  });
});
