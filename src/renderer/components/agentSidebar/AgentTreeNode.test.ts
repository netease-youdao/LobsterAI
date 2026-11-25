import { AgentId, AgentSource } from '@shared/agent';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';

import { i18nService } from '../../services/i18n';
import AgentAvatarIcon from '../agent/AgentAvatarIcon';
import AgentTaskRow from './AgentTaskRow';
import AgentTreeNode, { AgentAvatar } from './AgentTreeNode';
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

test('nested tasks use the sidebarTask token and readable ink while activity rows use sidebarCompact', () => {
  const agentHtml = renderAgent(makeAgent());
  expect(agentHtml).toContain('text-[length:var(--lobster-text-sidebarCompact)]');

  const nestedTaskHtml = renderTaskRow();
  expect(nestedTaskHtml).toContain('text-[length:var(--lobster-text-sidebarTask)]');
  expect(nestedTaskHtml).toContain('text-foreground/85');
  expect(nestedTaskHtml).not.toContain('text-[length:var(--lobster-text-sidebarCompact)]');

  // Activity rows stand alone with their agent as context, so they keep the agent-level size.
  const activityTaskHtml = renderTaskRow('Writer');
  expect(activityTaskHtml).toContain('text-[length:var(--lobster-text-sidebarCompact)]');
});

test('only the current agent row gets elevated ink weight, even when another agent stays expanded', () => {
  const inactiveCollapsedHtml = renderAgent(makeAgent());
  expect(inactiveCollapsedHtml).toContain('text-foreground/65');
  expect(inactiveCollapsedHtml).toContain('font-normal text-foreground/90');

  const inactiveExpandedHtml = renderAgent(makeAgent({ isExpanded: true, tasks: [makeTask()] }));
  expect(inactiveExpandedHtml).toContain('text-foreground/65');
  expect(inactiveExpandedHtml).toContain('font-normal text-foreground/90');
  expect(inactiveExpandedHtml).not.toContain('font-medium text-foreground');

  const currentHtml = renderAgent(makeAgent(), { isCurrentAgent: true });
  expect(currentHtml).toContain('font-medium text-foreground');
  expect(currentHtml).not.toContain('text-foreground/65');
});

test('AgentAvatar preserves each agent icon type at filtered task-row size with unique gradient IDs', () => {
  const customDataHtml = renderToStaticMarkup(
    React.createElement(AgentAvatar, {
      agent: makeAgent({ id: 'data-query', icon: 'agent-avatar-svg:data' }),
      className: 'h-3.5 w-3.5',
    }),
  );
  const expectedDataHtml = renderToStaticMarkup(
    React.createElement(AgentAvatarIcon, {
      value: 'agent-avatar-svg:data',
      inheritColor: true,
      className: 'h-3.5 w-3.5',
      iconClassName: 'h-3.5 w-3.5',
    }),
  );
  const otherSvgHtml = renderToStaticMarkup(
    React.createElement(AgentAvatar, {
      agent: makeAgent({ id: 'code-agent', icon: 'agent-avatar-svg:code' }),
      className: 'h-3.5 w-3.5',
    }),
  );
  expect(customDataHtml).toBe(expectedDataHtml);
  expect(customDataHtml).not.toBe(otherSvgHtml);
  expect(customDataHtml).toContain('h-3.5 w-3.5');

  const presetFallbackHtml = renderToStaticMarkup(
    React.createElement(AgentAvatar, {
      agent: makeAgent({ id: 'office-expert', source: AgentSource.Preset, icon: '' }),
      className: 'h-3.5 w-3.5',
    }),
  );
  expect(presetFallbackHtml).toContain('expert-default.webp');
  expect(presetFallbackHtml).toContain('h-3.5 w-3.5');

  const presetImageUrl = 'https://ydhardwarecommon.nosdn.127.net/expert.webp';
  const presetImageHtml = renderToStaticMarkup(
    React.createElement(AgentAvatar, {
      agent: makeAgent({ id: 'image-expert', source: AgentSource.Preset, icon: presetImageUrl }),
      className: 'h-3.5 w-3.5',
    }),
  );
  expect(presetImageHtml).toContain(`src="${presetImageUrl}"`);
  expect(presetImageHtml).toContain('h-3.5 w-3.5');

  const multipleDefaultHtml = renderToStaticMarkup(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(AgentAvatar, {
        agent: makeAgent({ id: AgentId.Main, icon: '' }),
        className: 'h-3.5 w-3.5',
      }),
      React.createElement(AgentAvatar, {
        agent: makeAgent({ id: AgentId.Main, icon: '' }),
        className: 'h-3.5 w-3.5',
      }),
    ),
  );
  const gradientIds = Array.from(
    multipleDefaultHtml.matchAll(/<linearGradient id="([^"]+)"/g),
    (match) => match[1],
  );
  expect(gradientIds).toHaveLength(2);
  expect(gradientIds[0]).not.toBe(gradientIds[1]);
});
