import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';

import { i18nService } from '../../services/i18n';
import AgentTaskRow from './AgentTaskRow';
import AgentTreeNode from './AgentTreeNode';
import { AgentSidebarIndicator } from './constants';
import type { AgentSidebarAgentNode, AgentSidebarTaskNode } from './types';

const makeTask = (overrides: Partial<AgentSidebarTaskNode> = {}): AgentSidebarTaskNode => ({
  id: 'session-1',
  agentId: 'writer',
  title: 'Draft the release notes',
  isScheduledTask: false,
  status: 'completed',
  pinned: false,
  pinOrder: null,
  updatedAt: 200,
  createdAt: 100,
  indicator: AgentSidebarIndicator.None,
  isSelected: false,
  ...overrides,
});

const makeAgent = (overrides: Partial<AgentSidebarAgentNode> = {}): AgentSidebarAgentNode => ({
  id: 'writer',
  name: 'Writer',
  icon: 'agent-avatar-svg:document',
  enabled: true,
  pinned: false,
  isExpanded: false,
  isTaskListExpanded: false,
  canExpandTasks: false,
  canCollapseTasks: false,
  isLoadingTasks: false,
  hasLoadError: false,
  tasks: [],
  ...overrides,
});

const renderAgent = (
  agent: AgentSidebarAgentNode,
  options: { isCurrentAgent?: boolean } = {},
) => renderToStaticMarkup(
  React.createElement(AgentTreeNode, {
    agent,
    isCurrentAgent: options.isCurrentAgent,
    isBatchMode: false,
    batchAgentId: null,
    selectedKeys: new Set<string>(),
    onToggleExpanded: vi.fn(),
    onEditAgent: vi.fn(),
    onCreateTask: vi.fn(),
    onDeleteAgent: vi.fn(async () => {}),
    onToggleAgentPin: vi.fn(async () => {}),
    onRetryLoadTasks: vi.fn(),
    onLoadMoreTasks: vi.fn(),
    onCollapseTasks: vi.fn(),
    onSelectTask: vi.fn(),
    onDeleteTask: vi.fn(async () => {}),
    onShareTask: vi.fn(async () => {}),
    onToggleTaskPin: vi.fn(async () => {}),
    onRenameTask: vi.fn(async () => {}),
    onToggleSelection: vi.fn(),
    onEnterBatchMode: vi.fn(),
  }),
);

const renderTaskRow = (contextLabel?: string) => renderToStaticMarkup(
  React.createElement(AgentTaskRow, {
    task: makeTask(),
    isBatchMode: false,
    isSelected: false,
    contextLabel,
    onSelect: vi.fn(),
    onDelete: vi.fn(async () => {}),
    onShare: vi.fn(async () => {}),
    onTogglePin: vi.fn(async () => {}),
    onRename: vi.fn(async () => {}),
    onToggleSelection: vi.fn(),
    onEnterBatchMode: vi.fn(),
  }),
);

test('agent rows expose a separate disclosure toggle that follows the expanded state', () => {
  const originalLanguage = i18nService.getLanguage();
  try {
    i18nService.setLanguage('zh', { persist: false });
    const collapsedHtml = renderAgent(makeAgent());
    expect(collapsedHtml).toMatch(/<button[^>]*aria-label="展开"[^>]*aria-expanded="false"/);
    expect(collapsedHtml).not.toContain('rotate-90');

    const expandedHtml = renderAgent(makeAgent({ isExpanded: true, tasks: [makeTask()] }));
    expect(expandedHtml).toMatch(/<button[^>]*aria-label="收起"[^>]*aria-expanded="true"/);
    expect(expandedHtml).toContain('rotate-90');
    expect(expandedHtml).toContain('Draft the release notes');
  } finally {
    i18nService.setLanguage(originalLanguage, { persist: false });
  }
});

test('tasks nested under an agent step down one text size from the agent row', () => {
  const agentHtml = renderAgent(makeAgent());
  expect(agentHtml).toContain('text-[length:var(--lobster-text-sidebarCompact)]');

  const nestedTaskHtml = renderTaskRow();
  expect(nestedTaskHtml).toContain('text-[length:var(--lobster-text-sidebarTask)]');
  expect(nestedTaskHtml).not.toContain('text-[length:var(--lobster-text-sidebarCompact)]');

  // Activity rows stand alone with their agent as context, so they keep the agent-level size.
  const activityTaskHtml = renderTaskRow('Writer');
  expect(activityTaskHtml).toContain('text-[length:var(--lobster-text-sidebarCompact)]');
});

test('only the current agent row gets elevated ink weight, even when another agent stays expanded', () => {
  const inactiveCollapsedHtml = renderAgent(makeAgent());
  expect(inactiveCollapsedHtml).toContain('text-foreground/55');
  expect(inactiveCollapsedHtml).toContain('font-normal text-foreground/80');

  const inactiveExpandedHtml = renderAgent(makeAgent({ isExpanded: true, tasks: [makeTask()] }));
  expect(inactiveExpandedHtml).toContain('text-foreground/55');
  expect(inactiveExpandedHtml).toContain('font-normal text-foreground/80');
  expect(inactiveExpandedHtml).not.toContain('font-medium text-foreground');

  const currentHtml = renderAgent(makeAgent(), { isCurrentAgent: true });
  expect(currentHtml).toContain('font-medium text-foreground');
  expect(currentHtml).not.toContain('text-foreground/55');
});
