import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';

import { i18nService } from '../../services/i18n';
import AgentTaskRow from './AgentTaskRow';
import { AgentSidebarIndicator } from './constants';
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
  expect(html).toContain('focus-visible:opacity-[0.46]');
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
