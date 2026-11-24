import { describe, expect, test } from 'vitest';

import { i18nService } from '../../services/i18n';
import { CoworkSessionStatusValue, type CoworkSessionSummary } from '../../types/cowork';
import {
  buildSidebarTaskFilterQuery,
  computeSidebarTaskStatusCounts,
  DEFAULT_SIDEBAR_TASK_FILTER,
  EMPTY_SIDEBAR_TASK_STATUS_COUNTS,
  getSidebarTaskFilterUpdatedSince,
  hasSidebarTaskAttention,
  isSidebarTaskFilterActive,
  matchesSidebarTaskFilter,
  reconcileSidebarTaskFilterResults,
  SIDEBAR_TASK_STATUS_FILTER_OPTIONS,
  type SidebarTaskFilter,
  type SidebarTaskRuntimeState,
  SidebarTaskStatusFilter,
  SidebarTaskTimeFilter,
} from './taskFilter';
import {
  formatSidebarTaskStatusCount,
  getSidebarTaskFilterSummary,
  getSidebarTaskFilterTooltip,
  getSidebarTaskStatusFilterLabel,
} from './taskFilterLabels';

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

describe('SIDEBAR_TASK_STATUS_FILTER_OPTIONS', () => {
  test('orders completed-unread and pending-permission ahead of running and error', () => {
    expect(SIDEBAR_TASK_STATUS_FILTER_OPTIONS).toEqual([
      SidebarTaskStatusFilter.All,
      SidebarTaskStatusFilter.CompletedUnread,
      SidebarTaskStatusFilter.PendingPermission,
      SidebarTaskStatusFilter.Running,
      SidebarTaskStatusFilter.Error,
    ]);
  });
});

describe('computeSidebarTaskStatusCounts', () => {
  test('counts unread completed, pending permission, and active running tasks across enabled agents', () => {
    const runtime: SidebarTaskRuntimeState = {
      completedUnreadSessionIds: new Set(['unread-1', 'stale-running-unread', 'disabled-agent-unread']),
      pendingPermissionSessionIds: new Set(['waiting-1', '__session_agnostic__']),
    };

    const counts = computeSidebarTaskStatusCounts(
      [
        [
          makeSession('unread-1', CoworkSessionStatusValue.Completed, NOW - 1000),
          // Stale running preview after background completion should count as completedUnread, not running.
          makeSession('stale-running-unread', CoworkSessionStatusValue.Running, NOW - 2000),
          makeSession('waiting-1', CoworkSessionStatusValue.Running, NOW - 3000),
        ],
        [
          // Duplicate session id across lists should not be double counted.
          makeSession('unread-1', CoworkSessionStatusValue.Completed, NOW - 1000),
          makeSession('running-1', CoworkSessionStatusValue.Running, NOW - 4000),
          makeSession('failed-1', CoworkSessionStatusValue.Error, NOW - 5000),
        ],
      ],
      runtime,
    );

    expect(counts).toEqual({
      completedUnread: 2,
      pendingPermission: 1,
      running: 2,
    });
    expect(hasSidebarTaskAttention(counts)).toBe(true);
  });

  test('reports no attention badge when only running tasks exist', () => {
    expect(hasSidebarTaskAttention(EMPTY_SIDEBAR_TASK_STATUS_COUNTS)).toBe(false);
    expect(hasSidebarTaskAttention({ completedUnread: 0, pendingPermission: 0, running: 3 })).toBe(false);
    expect(hasSidebarTaskAttention({ completedUnread: 0, pendingPermission: 1, running: 0 })).toBe(true);
    expect(hasSidebarTaskAttention({ completedUnread: 1, pendingPermission: 0, running: 0 })).toBe(true);
  });
});

describe('taskFilterLabels', () => {
  test('formats badge counts with a 99+ cap', () => {
    expect(formatSidebarTaskStatusCount(1)).toBe('1');
    expect(formatSidebarTaskStatusCount(99)).toBe('99');
    expect(formatSidebarTaskStatusCount(100)).toBe('99+');
  });

  test('renders localized labels, filter summary, and attention tooltips', () => {
    const originalLanguage = i18nService.getLanguage();
    try {
      i18nService.setLanguage('zh', { persist: false });
      expect(getSidebarTaskStatusFilterLabel(SidebarTaskStatusFilter.CompletedUnread)).toBe('完成未读');
      expect(getSidebarTaskFilterSummary(filterOf(SidebarTaskStatusFilter.CompletedUnread, SidebarTaskTimeFilter.Today)))
        .toBe('完成未读 · 今天');
      expect(getSidebarTaskFilterTooltip('筛选任务', DEFAULT_SIDEBAR_TASK_FILTER, EMPTY_SIDEBAR_TASK_STATUS_COUNTS))
        .toBe('筛选任务');
      expect(getSidebarTaskFilterTooltip('筛选任务', DEFAULT_SIDEBAR_TASK_FILTER, {
        completedUnread: 2,
        pendingPermission: 0,
        running: 1,
      })).toBe('筛选任务 · 2 个完成未读');
      expect(getSidebarTaskFilterTooltip('筛选任务', DEFAULT_SIDEBAR_TASK_FILTER, {
        completedUnread: 2,
        pendingPermission: 1,
        running: 0,
      })).toBe('2 个完成未读 · 1 个待确认');
      expect(getSidebarTaskFilterTooltip('筛选任务', filterOf(SidebarTaskStatusFilter.CompletedUnread), {
        completedUnread: 2,
        pendingPermission: 0,
        running: 0,
      })).toBe('已筛选：完成未读');

      i18nService.setLanguage('en', { persist: false });
      expect(getSidebarTaskStatusFilterLabel(SidebarTaskStatusFilter.CompletedUnread)).toBe('Unread results');
      expect(getSidebarTaskFilterTooltip('Filter tasks', DEFAULT_SIDEBAR_TASK_FILTER, {
        completedUnread: 3,
        pendingPermission: 0,
        running: 0,
      })).toBe('Filter tasks · 3 unread');
      expect(getSidebarTaskFilterTooltip('Filter tasks', DEFAULT_SIDEBAR_TASK_FILTER, {
        completedUnread: 0,
        pendingPermission: 1,
        running: 0,
      })).toBe('Filter tasks · 1 pending approval');
      expect(getSidebarTaskFilterTooltip('Filter tasks', DEFAULT_SIDEBAR_TASK_FILTER, {
        completedUnread: 3,
        pendingPermission: 1,
        running: 0,
      })).toBe('3 unread · 1 pending approval');
    } finally {
      i18nService.setLanguage(originalLanguage, { persist: false });
    }
  });
});
