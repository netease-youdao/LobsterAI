import { expect, test } from 'vitest';

import { CoworkSessionStatusValue } from '../../types/cowork';
import {
  AgentSidebarIndicator,
  type AgentSidebarIndicator as AgentSidebarIndicatorType,
} from './constants';
import {
  buildAgentSidebarActivityView,
  hasUnreadCompletedAgentTasks,
} from './taskFilter';
import type { AgentSidebarAgentNode, AgentSidebarTaskNode } from './types';

const makeTask = (
  id: string,
  updatedAt: number,
  indicator: AgentSidebarIndicatorType = AgentSidebarIndicator.None,
): AgentSidebarTaskNode => ({
  id,
  agentId: 'main',
  title: id,
  isScheduledTask: false,
  status: indicator === AgentSidebarIndicator.Running
    ? CoworkSessionStatusValue.Running
    : CoworkSessionStatusValue.Completed,
  pinned: false,
  updatedAt,
  createdAt: updatedAt,
  indicator,
  isSelected: false,
});

const makeAgent = (
  id: string,
  tasks: AgentSidebarTaskNode[],
): AgentSidebarAgentNode => ({
  id,
  name: id,
  icon: '',
  enabled: true,
  pinned: false,
  isExpanded: false,
  isTaskListExpanded: true,
  canExpandTasks: true,
  canCollapseTasks: true,
  isLoadingTasks: false,
  hasLoadError: false,
  tasks: tasks.map((task) => ({ ...task, agentId: id })),
});

test('activity view globally prioritizes attention states across agents', () => {
  const agents = [
    makeAgent('main', [
      makeTask('running-newest', 500, AgentSidebarIndicator.Running),
      makeTask('unread-main', 300, AgentSidebarIndicator.CompletedUnread),
    ]),
    makeAgent('custom', [
      makeTask('permission', 100, AgentSidebarIndicator.PendingPermission),
      makeTask('unread-custom', 400, AgentSidebarIndicator.CompletedUnread),
    ]),
  ];

  const activity = buildAgentSidebarActivityView(agents);

  expect(hasUnreadCompletedAgentTasks(agents)).toBe(true);
  expect(activity.priority.map((item) => `${item.agent.id}:${item.task.id}`)).toEqual([
    'custom:permission',
    'custom:unread-custom',
    'main:unread-main',
    'main:running-newest',
  ]);
});

test('activity view shows the five latest non-priority tasks across agents', () => {
  const activity = buildAgentSidebarActivityView([
    makeAgent('main', [
      makeTask('main-600', 600),
      makeTask('main-400', 400),
      makeTask('main-200', 200),
    ]),
    makeAgent('custom', [
      makeTask('custom-500', 500),
      makeTask('custom-300', 300),
      makeTask('custom-100', 100),
    ]),
  ]);

  expect(activity.priority).toEqual([]);
  expect(activity.recent.map((item) => `${item.agent.id}:${item.task.id}`)).toEqual([
    'main:main-600',
    'custom:custom-500',
    'main:main-400',
    'custom:custom-300',
    'main:main-200',
  ]);
});

test('activity view keeps each agent represented before filling recent slots', () => {
  const activity = buildAgentSidebarActivityView([
    makeAgent('busy-agent', [
      makeTask('busy-600', 600),
      makeTask('busy-500', 500),
      makeTask('busy-400', 400),
      makeTask('busy-300', 300),
      makeTask('busy-200', 200),
    ]),
    makeAgent('quiet-agent', [makeTask('quiet-100', 100)]),
  ]);

  expect(activity.recent.map((item) => `${item.agent.id}:${item.task.id}`)).toEqual([
    'busy-agent:busy-600',
    'busy-agent:busy-500',
    'busy-agent:busy-400',
    'busy-agent:busy-300',
    'quiet-agent:quiet-100',
  ]);
});

test('activity view limits agent coverage by each agent latest activity', () => {
  const agents = Array.from({ length: 6 }, (_, index) => (
    makeAgent(`agent-${index}`, [makeTask(`task-${index}`, 600 - index * 100)])
  ));

  const activity = buildAgentSidebarActivityView(agents);

  expect(activity.recent.map((item) => item.agent.id)).toEqual([
    'agent-0',
    'agent-1',
    'agent-2',
    'agent-3',
    'agent-4',
  ]);
});

test('activity view excludes priority tasks from recent results', () => {
  const activity = buildAgentSidebarActivityView([
    makeAgent('main', [
      makeTask('unread', 300, AgentSidebarIndicator.CompletedUnread),
      makeTask('recent', 200),
    ]),
  ]);

  expect(activity.priority.map((item) => item.task.id)).toEqual(['unread']);
  expect(activity.recent.map((item) => item.task.id)).toEqual(['recent']);
});

test('activity view returns empty sections when there are no tasks', () => {
  expect(buildAgentSidebarActivityView([makeAgent('main', [])])).toEqual({
    priority: [],
    recent: [],
  });
});

test('activity view supports an empty recent limit without affecting priority', () => {
  const agents = [makeAgent('main', [
    makeTask('priority', 200, AgentSidebarIndicator.CompletedUnread),
    makeTask('recent', 100),
  ])];

  const activity = buildAgentSidebarActivityView(agents, 0);

  expect(activity.priority.map((item) => item.task.id)).toEqual(['priority']);
  expect(activity.recent).toEqual([]);
});

test('activity view uses stable agent and task order for equal timestamps', () => {
  const activity = buildAgentSidebarActivityView([
    makeAgent('agent-one', [makeTask('first', 100), makeTask('second', 100)]),
    makeAgent('agent-two', [makeTask('third', 100)]),
  ]);

  expect(activity.recent.map((item) => item.task.id)).toEqual([
    'first',
    'second',
    'third',
  ]);
  expect(hasUnreadCompletedAgentTasks([
    makeAgent('agent-one', [makeTask('running', 100, AgentSidebarIndicator.Running)]),
  ])).toBe(false);
});
