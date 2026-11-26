import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, test, vi } from 'vitest';

import { i18nService } from '../../services/i18n';
import AgentTaskRow from './AgentTaskRow';
import {
  AgentSidebarIndicator,
  AgentTaskRowVariant,
  PinnedTaskSortMode,
} from './constants';
import PinnedTasksSection from './PinnedTasksSection';
import type { AgentSidebarActivityItem } from './taskFilter';
import type { AgentSidebarAgentNode, AgentSidebarTaskNode } from './types';

afterEach(() => {
  i18nService.setLanguage('zh', { persist: false });
});

const makeAgent = (id: string, name: string): AgentSidebarAgentNode => ({
  id,
  name,
  icon: '',
  enabled: true,
  pinned: false,
  isExpanded: false,
  isTaskListExpanded: false,
  canExpandTasks: false,
  canCollapseTasks: false,
  isLoadingTasks: false,
  hasLoadError: false,
  tasks: [],
});

const makeItem = (index: number): AgentSidebarActivityItem => {
  const agent = makeAgent(`agent-${index}`, `Agent ${index}`);
  const task: AgentSidebarTaskNode = {
    id: `pinned-${index}`,
    agentId: agent.id,
    title: `Pinned Task ${index}`,
    isScheduledTask: false,
    status: 'completed',
    pinned: true,
    pinOrder: 100 - index,
    updatedAt: 1000 + index,
    createdAt: 1000,
    indicator: AgentSidebarIndicator.None,
    isSelected: false,
  };
  return { agent, task };
};

const renderSection = (
  items: AgentSidebarActivityItem[],
  options: {
    isCollapsed?: boolean;
    isBatchMode?: boolean;
    sortMode?: PinnedTaskSortMode;
  } = {},
) => renderToStaticMarkup(
  React.createElement(PinnedTasksSection, {
    items,
    isCollapsed: options.isCollapsed ?? false,
    sortMode: options.sortMode ?? PinnedTaskSortMode.Manual,
    isBatchMode: options.isBatchMode ?? false,
    onToggleCollapsed: vi.fn(),
    onSortModeChange: vi.fn(),
    onReorder: vi.fn(async () => {}),
    renderTask: (item) => React.createElement(AgentTaskRow, {
      key: item.task.id,
      task: item.task,
      variant: AgentTaskRowVariant.Pinned,
      isBatchMode: false,
      isSelected: false,
      onSelect: vi.fn(),
      onDelete: vi.fn(async () => {}),
      onShare: vi.fn(async () => {}),
      onTogglePin: vi.fn(async () => {}),
      onRename: vi.fn(async () => {}),
      onToggleSelection: vi.fn(),
      onEnterBatchMode: vi.fn(),
    }),
  }),
);

test('PinnedTasksSection renders nothing when there are no pinned tasks', () => {
  expect(renderSection([])).toBe('');
});

test('PinnedTasksSection reveals the fold chevron on header hover and sort ellipsis on section hover', () => {
  i18nService.setLanguage('zh', { persist: false });
  const items = [makeItem(1), makeItem(2)];

  const manualHtml = renderSection(items, { isCollapsed: false, sortMode: PinnedTaskSortMode.Manual });
  expect(manualHtml).toContain('置顶');
  expect(manualHtml).toContain('aria-expanded="true"');
  expect(manualHtml).toContain('group-hover/pinned-header:opacity-100');
  expect(manualHtml).toContain('group-hover/pinned-section:opacity-100');
  expect(manualHtml).toContain('aria-label="排序方式"');
  expect(manualHtml).toContain('cursor-grab');
  expect(manualHtml).toContain('Pinned Task 1');
  expect(manualHtml).toContain('Pinned Task 2');
  expect(manualHtml).not.toContain('Agent 1');
  expect(manualHtml).not.toContain('展开显示');

  const updatedAtHtml = renderSection(items, { isCollapsed: false, sortMode: PinnedTaskSortMode.UpdatedAt });
  expect(updatedAtHtml).not.toContain('cursor-grab');

  const collapsedHtml = renderSection(items, { isCollapsed: true });
  expect(collapsedHtml).toContain('置顶');
  expect(collapsedHtml).toContain('aria-expanded="false"');
  expect(collapsedHtml).toContain('>2<');
  expect(collapsedHtml).not.toContain('Pinned Task 1');

  const batchModeHtml = renderSection(items, { isBatchMode: true });
  expect(batchModeHtml).not.toContain('aria-label="排序方式"');
  expect(batchModeHtml).not.toContain('cursor-grab');
});

test('PinnedTasksSection sticks its header at the top like MyAgentSidebarHeader', () => {
  const html = renderSection([makeItem(1), makeItem(2)]);

  expect(html).toContain(
    'group/pinned-header sticky top-0 z-30 -mx-2.5 h-9 bg-[var(--lobster-sidebar-bg)] px-2.5',
  );
});

test('PinnedTasksSection caps default preview at 5 items and shows an expand toggle', () => {
  i18nService.setLanguage('zh', { persist: false });
  const items = [1, 2, 3, 4, 5, 6].map(makeItem);
  const html = renderSection(items);

  expect(html).toContain('Pinned Task 1');
  expect(html).toContain('Pinned Task 5');
  expect(html).not.toContain('Pinned Task 6');
  expect(html).toContain('展开显示');
});
