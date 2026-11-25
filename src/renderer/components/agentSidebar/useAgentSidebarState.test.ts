import { afterEach, expect, test, vi } from 'vitest';

import {
  type CoworkSessionStatus,
  CoworkSessionStatusValue,
  type CoworkSessionSummary,
} from '../../types/cowork';
import { AgentSidebarIndicator, PinnedTaskSortMode } from './constants';
import type { AgentSidebarAgentSummary } from './types';
import {
  applyOptimisticPinnedTaskOrder,
  collapseAgentSidebarTaskList,
  deriveAgentSidebarIndicator,
  logAgentSidebarDebug,
  reconcilePinnedSidebarSessions,
  removeAgentSidebarAgentTaskPreviews,
  removeAgentSidebarTaskPreviews,
  sortAgentSidebarAgents,
  sortAgentSidebarTasks,
  sortPinnedSidebarTasks,
  toAgentSidebarTaskNode,
} from './useAgentSidebarState';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const makeSession = (
  id: string,
  createdAt: number,
  updatedAt = createdAt,
  status: CoworkSessionStatus = CoworkSessionStatusValue.Completed,
  pinned = false,
  pinOrder: number | null = null,
  scheduledTaskId: string | null = null,
): CoworkSessionSummary => ({
  id,
  title: id,
  scheduledTaskId,
  status,
  pinned,
  pinOrder,
  agentId: 'main',
  createdAt,
  updatedAt,
});

const makeAgent = (
  id: string,
  pinned = false,
  pinOrder: number | null = null,
  sortOrder: number | null = null,
): AgentSidebarAgentSummary => ({
  id,
  name: id,
  icon: '',
  enabled: true,
  pinned,
  pinOrder,
  sortOrder,
});

test('keeps successful task loading independent from renderer debug logging', () => {
  const fromRenderer = vi.fn(() => {
    throw new Error('logger unavailable');
  });
  vi.stubGlobal('window', {
    electron: {
      log: { fromRenderer },
    },
  });
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);

  expect(() => logAgentSidebarDebug('task preview loaded')).not.toThrow();
  expect(fromRenderer).toHaveBeenCalledWith(
    'debug',
    'AgentSidebar',
    'task preview loaded',
  );
});

test('sortAgentSidebarTasks keeps unpinned tasks ordered by last update time', () => {
  const sorted = sortAgentSidebarTasks([
    makeSession('newer-created-older-update', 300, 200),
    makeSession('older-created-newer-update', 100, 500, CoworkSessionStatusValue.Running),
    makeSession('middle', 200, 300),
  ]);

  expect(sorted.map((session) => session.id)).toEqual([
    'older-created-newer-update',
    'middle',
    'newer-created-older-update',
  ]);
});

test('sortAgentSidebarTasks keeps per-agent list ordered chronologically even when items are pinned', () => {
  const sorted = sortAgentSidebarTasks([
    makeSession('newer-unpinned', 100, 400),
    makeSession('second-pinned', 100, 200, CoworkSessionStatusValue.Completed, true, 2),
    makeSession('middle-unpinned', 200, 300),
    makeSession('first-pinned', 200, 100, CoworkSessionStatusValue.Completed, true, 1),
  ]);

  expect(sorted.map((session) => session.id)).toEqual([
    'newer-unpinned',
    'middle-unpinned',
    'second-pinned',
    'first-pinned',
  ]);
});

test('sortPinnedSidebarTasks supports both manual order and last-updated order', () => {
  const input = [
    makeSession('unpinned', 100, 900, CoworkSessionStatusValue.Completed, false, null),
    makeSession('legacy-null-pin', 100, 800, CoworkSessionStatusValue.Completed, true, null),
    makeSession('first-pinned', 100, 500, CoworkSessionStatusValue.Completed, true, 1000),
    makeSession('second-pinned', 100, 150, CoworkSessionStatusValue.Completed, true, 2000),
  ];

  expect(sortPinnedSidebarTasks(input, PinnedTaskSortMode.Manual).map((session) => session.id)).toEqual([
    'second-pinned',
    'first-pinned',
    'legacy-null-pin',
  ]);

  expect(sortPinnedSidebarTasks(input, PinnedTaskSortMode.UpdatedAt).map((session) => session.id)).toEqual([
    'legacy-null-pin',
    'first-pinned',
    'second-pinned',
  ]);
});

test('applyOptimisticPinnedTaskOrder reorders pinned sessions and keeps omitted entries at the end', () => {
  const current = [
    makeSession('a', 100, 100, CoworkSessionStatusValue.Completed, true, 30),
    makeSession('b', 100, 200, CoworkSessionStatusValue.Completed, true, 20),
    makeSession('c', 100, 300, CoworkSessionStatusValue.Completed, true, 10),
  ];

  const next = applyOptimisticPinnedTaskOrder(current, ['c', 'a']);
  expect(sortPinnedSidebarTasks(next, PinnedTaskSortMode.Manual).map((session) => session.id)).toEqual([
    'c',
    'a',
    'b',
  ]);
});

test('reconcilePinnedSidebarSessions syncs live pinned updates while preserving other agents pins', () => {
  const current = [
    { ...makeSession('other-agent-pin', 100, 200, CoworkSessionStatusValue.Completed, true, 10), agentId: 'writer', cwd: '/tmp/writer' },
    { ...makeSession('main-unpinned-now', 100, 200, CoworkSessionStatusValue.Completed, true, 20), cwd: '/tmp/main' },
    { ...makeSession('main-renamed', 100, 200, CoworkSessionStatusValue.Completed, true, 30), cwd: '/tmp/keep-cwd', imPlatform: 'weixin' as const },
  ];

  const live = [
    makeSession('main-unpinned-now', 100, 250, CoworkSessionStatusValue.Completed, false, null),
    { ...makeSession('main-renamed', 100, 300, CoworkSessionStatusValue.Running, true, 30), title: 'Updated Title' },
    { ...makeSession('main-newly-pinned', 100, 400, CoworkSessionStatusValue.Completed, true, 40), cwd: '/tmp/new' },
  ];

  const next = reconcilePinnedSidebarSessions(current, live);
  expect(next.map((session) => session.id)).toEqual([
    'other-agent-pin',
    'main-renamed',
    'main-newly-pinned',
  ]);
  const renamed = next.find((session) => session.id === 'main-renamed');
  expect(renamed?.title).toBe('Updated Title');
  expect(renamed?.cwd).toBe('/tmp/keep-cwd');
  expect(renamed?.imPlatform).toBe('weixin');
});

test('sortAgentSidebarAgents keeps pinned agents in first-pinned-first order', () => {
  const sorted = sortAgentSidebarAgents([
    makeAgent('regular'),
    makeAgent('second-pinned', true, 2),
    makeAgent('first-pinned', true, 1),
    makeAgent('another-regular'),
  ]);

  expect(sorted.map((agent) => agent.id)).toEqual([
    'first-pinned',
    'second-pinned',
    'regular',
    'another-regular',
  ]);
});

test('sortAgentSidebarAgents orders agents within pin groups by explicit sort order', () => {
  const sorted = sortAgentSidebarAgents([
    makeAgent('regular-second', false, null, 4),
    makeAgent('pinned-second', true, 2, 2),
    makeAgent('regular-first', false, null, 3),
    makeAgent('pinned-first', true, 1, 1),
  ]);

  expect(sorted.map((agent) => agent.id)).toEqual([
    'pinned-first',
    'pinned-second',
    'regular-first',
    'regular-second',
  ]);
});

test('deriveAgentSidebarIndicator prioritizes pending permission state', () => {
  const session = makeSession('pending-session', 100, 200, CoworkSessionStatusValue.Running);

  expect(deriveAgentSidebarIndicator(
    session,
    new Set([session.id]),
    new Set([session.id]),
  )).toBe(AgentSidebarIndicator.PendingPermission);
});

test('deriveAgentSidebarIndicator uses unread completion over a stale running preview', () => {
  const session = makeSession('completed-in-background', 100, 200, CoworkSessionStatusValue.Running);

  expect(deriveAgentSidebarIndicator(
    session,
    new Set([session.id]),
    new Set(),
  )).toBe(AgentSidebarIndicator.CompletedUnread);
});

test('deriveAgentSidebarIndicator keeps a running task active without completion unread state', () => {
  const session = makeSession('running-in-background', 100, 200, CoworkSessionStatusValue.Running);

  expect(deriveAgentSidebarIndicator(
    session,
    new Set(),
    new Set(),
  )).toBe(AgentSidebarIndicator.Running);
});

test('toAgentSidebarTaskNode marks sessions linked to scheduled tasks', () => {
  const session = makeSession(
    'scheduled-session',
    100,
    200,
    CoworkSessionStatusValue.Completed,
    false,
    null,
    'job-daily-summary',
  );

  expect(toAgentSidebarTaskNode(session, null, new Set(), new Set()).isScheduledTask).toBe(true);
  expect(
    toAgentSidebarTaskNode(makeSession('regular-session', 100), null, new Set(), new Set())
      .isScheduledTask,
  ).toBe(false);

  const legacyZhSession = {
    ...makeSession('legacy-zh-session', 100),
    title: '[定时] 科技早报',
  };
  const legacyEnSession = {
    ...makeSession('legacy-en-session', 100),
    title: '[Cron] Daily summary',
  };
  expect(toAgentSidebarTaskNode(legacyZhSession, null, new Set(), new Set()).isScheduledTask)
    .toBe(true);
  expect(toAgentSidebarTaskNode(legacyEnSession, null, new Set(), new Set()).isScheduledTask)
    .toBe(true);

  const legacyFork = {
    ...legacyZhSession,
    id: 'legacy-fork',
    parentSessionId: 'legacy-zh-session',
  };
  expect(toAgentSidebarTaskNode(legacyFork, null, new Set(), new Set()).isScheduledTask)
    .toBe(false);
});

test('toAgentSidebarTaskNode carries IM platform, cwd, and forkGitBranch for display', () => {
  const task = toAgentSidebarTaskNode(
    {
      ...makeSession('im-session', 100),
      imPlatform: 'weixin',
      cwd: '/Users/demo/Dev/lobsterai',
      forkGitBranch: 'feat/sidebar-pin',
    },
    null,
    new Set(),
    new Set(),
  );

  expect(task.imPlatform).toBe('weixin');
  expect(task.cwd).toBe('/Users/demo/Dev/lobsterai');
  expect(task.forkGitBranch).toBe('feat/sidebar-pin');
});

test('collapseAgentSidebarTaskList resets one agent history list to preview mode', () => {
  expect(collapseAgentSidebarTaskList(['agent-1', 'agent-2'], 'agent-1')).toEqual(['agent-2']);
});

test('removeAgentSidebarTaskPreviews removes selected tasks across loaded agents', () => {
  const previews = {
    'agent-1': [
      makeSession('keep-1', 100),
      makeSession('remove-1', 200),
    ],
    'agent-2': [
      makeSession('remove-2', 300),
      makeSession('keep-2', 400),
    ],
  };

  const next = removeAgentSidebarTaskPreviews(previews, ['remove-1', 'remove-2']);

  expect(next['agent-1'].map((session) => session.id)).toEqual(['keep-1']);
  expect(next['agent-2'].map((session) => session.id)).toEqual(['keep-2']);
});

test('removeAgentSidebarTaskPreviews preserves state when nothing matches', () => {
  const previews = {
    'agent-1': [makeSession('keep-1', 100)],
  };

  expect(removeAgentSidebarTaskPreviews(previews, ['missing'])).toBe(previews);
});

test('removeAgentSidebarAgentTaskPreviews clears cached tasks for one agent id', () => {
  const previews = {
    'agent-1': [makeSession('remove-1', 100)],
    'agent-2': [makeSession('keep-2', 200)],
  };

  const next = removeAgentSidebarAgentTaskPreviews(previews, 'agent-1');

  expect(next['agent-1']).toBeUndefined();
  expect(next['agent-2'].map((session) => session.id)).toEqual(['keep-2']);
});

test('removeAgentSidebarAgentTaskPreviews preserves state when agent cache is missing', () => {
  const previews = {
    'agent-1': [makeSession('keep-1', 100)],
  };

  expect(removeAgentSidebarAgentTaskPreviews(previews, 'missing-agent')).toBe(previews);
});
