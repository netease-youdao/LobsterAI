import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';

import { i18nService } from '../../services/i18n';
import AgentTaskRow from './AgentTaskRow';
import { AgentAvatar } from './AgentTreeNode';
import { AgentSidebarIndicator, AgentTaskRowVariant } from './constants';
import type { AgentSidebarTaskNode } from './types';

const makeTask = (
  isScheduledTask: boolean,
  overrides: Partial<AgentSidebarTaskNode> = {},
): AgentSidebarTaskNode => ({
  id: isScheduledTask ? 'scheduled-session' : 'regular-session',
  agentId: 'main',
  title: isScheduledTask ? '[定时] Daily summary' : 'Regular task',
  isScheduledTask,
  status: 'completed',
  pinned: false,
  pinOrder: null,
  updatedAt: 200,
  createdAt: 100,
  indicator: AgentSidebarIndicator.None,
  isSelected: false,
  ...overrides,
});

const renderTask = (
  isScheduledTask: boolean,
  overrides: Partial<AgentSidebarTaskNode> = {},
) => renderToStaticMarkup(
  React.createElement(AgentTaskRow, {
    task: makeTask(isScheduledTask, overrides),
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
);

test('scheduled task rows show a localized accessible clock marker without marking regular rows', () => {
  const originalLanguage = i18nService.getLanguage();
  try {
    i18nService.setLanguage('zh', { persist: false });
    const zhScheduledHtml = renderTask(true);
    expect(zhScheduledHtml).toContain('aria-label="定时任务"');
    expect(zhScheduledHtml).toContain('title="定时任务"');
    expect(zhScheduledHtml).toContain('role="img"');
    expect(zhScheduledHtml).toMatch(/role="img"[^>]*>\s*<svg/);
    expect(zhScheduledHtml).toContain('Daily summary');
    expect(zhScheduledHtml).not.toContain('[定时]');

    i18nService.setLanguage('en', { persist: false });
    const enScheduledHtml = renderTask(true);
    expect(enScheduledHtml).toContain('aria-label="Scheduled task"');
    expect(enScheduledHtml).toContain('title="Scheduled task"');
    expect(renderTask(false)).not.toContain('aria-label="Scheduled task"');
  } finally {
    i18nService.setLanguage(originalLanguage, { persist: false });
  }
});

test('task rows and hidden action controls remain keyboard reachable', () => {
  const html = renderTask(false);
  expect(html).toContain('role="treeitem"');
  expect(html).toContain('tabindex="0"');
  expect(html).toContain('focus-visible:opacity-100');
});

test('IM task rows show platform icons and hide matching title prefixes', () => {
  const originalLanguage = i18nService.getLanguage();
  try {
    i18nService.setLanguage('zh', { persist: false });
    const html = renderTask(false, {
      title: '[微信] group:o9cq',
      imPlatform: 'weixin',
    });
    expect(html).toContain('src="weixin.png"');
    expect(html).toContain('aria-label="微信"');
    expect(html).toContain('group:o9cq');
    expect(html).not.toContain('[微信]');
  } finally {
    i18nService.setLanguage(originalLanguage, { persist: false });
  }
});

test('selected task rows reuse the sidebar hover fill without an elevated pill ring or shadow', () => {
  const html = renderTask(false, { isSelected: true });
  expect(html).toContain('bg-[var(--lobster-sidebar-item-hover)]');
  expect(html).toContain('font-medium text-foreground');
  expect(html).not.toContain('--lobster-sidebar-item-active-bg');
  expect(html).not.toContain('ring-1');
});

test('selected task rows hide pin and menu actions until hovered or keyboard focused', () => {
  const html = renderTask(false, { isSelected: true });
  expect(html).toContain('pointer-events-none w-0 overflow-hidden opacity-0 group-hover:pointer-events-auto group-hover:w-auto group-hover:overflow-visible group-hover:opacity-100');
  expect(html).toContain('group-has-[:focus-visible]:opacity-100');
  expect(html).toContain('group-has-[:focus-visible]:opacity-0');
  expect(html).not.toContain('group-focus-within:');
});

test('filtered activity rows render the agent avatar inside the context icon slot', () => {
  const agent = { id: 'data-query', icon: 'agent-avatar-svg:data' };
  const expectedAvatarHtml = renderToStaticMarkup(
    React.createElement(AgentAvatar, { agent, className: 'h-3.5 w-3.5' }),
  );
  const html = renderToStaticMarkup(
    React.createElement(AgentTaskRow, {
      task: makeTask(false, { agentId: 'data-query', title: '高收入原因分析' }),
      isBatchMode: false,
      isSelected: false,
      contextLabel: 'Lobster数据查询',
      contextIcon: React.createElement(AgentAvatar, { agent, className: 'h-3.5 w-3.5' }),
      onSelect: vi.fn(),
      onDelete: vi.fn(async () => {}),
      onShare: vi.fn(async () => {}),
      onTogglePin: vi.fn(async () => {}),
      onRename: vi.fn(async () => {}),
      onToggleSelection: vi.fn(),
      onEnterBatchMode: vi.fn(),
    }),
  );
  expect(html).toContain('Lobster数据查询');
  expect(html).toContain(expectedAvatarHtml);
});

test('pin action renders on the right action slot instead of the left indent gutter across variants', () => {
  const unpinnedHtml = renderTask(false, { pinned: false });
  expect(unpinnedHtml).not.toContain('left-[9px]');
  expect(unpinnedHtml).toContain('aria-pressed="false"');
  expect(unpinnedHtml).toContain('fill="none"');

  const pinnedHtml = renderToStaticMarkup(
    React.createElement(AgentTaskRow, {
      task: makeTask(false, { pinned: true, title: 'Pinned top task' }),
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
  );
  expect(pinnedHtml).not.toContain('left-[9px]');
  expect(pinnedHtml).toContain('pl-2.5');
  expect(pinnedHtml).toContain('aria-level="1"');
  expect(pinnedHtml).toContain('aria-pressed="true"');
  expect(pinnedHtml).toContain('fill="currentColor"');
  expect(pinnedHtml).toContain('Pinned top task');
});
