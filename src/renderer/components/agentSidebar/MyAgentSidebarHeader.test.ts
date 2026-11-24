import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import { i18nService } from '../../services/i18n';
import MyAgentSidebarHeader from './MyAgentSidebarHeader';
import {
  DEFAULT_SIDEBAR_TASK_FILTER,
  type SidebarTaskFilter,
  SidebarTaskStatusFilter,
  SidebarTaskTimeFilter,
} from './taskFilter';

const renderHeader = (options: {
  taskFilter?: SidebarTaskFilter;
  hasUnreadCompletedTasks?: boolean;
} = {}) => renderToStaticMarkup(
  React.createElement(MyAgentSidebarHeader, {
    taskFilter: options.taskFilter ?? DEFAULT_SIDEBAR_TASK_FILTER,
    hasUnreadCompletedTasks: options.hasUnreadCompletedTasks ?? false,
    onTaskFilterChange: () => undefined,
    onCreateAgent: () => undefined,
  }),
);

describe('MyAgentSidebarHeader', () => {
  test.each([
    { language: 'zh' as const, heading: '我的 Agent', filterLabel: '筛选任务', createLabel: '新建 Agent' },
    { language: 'en' as const, heading: 'My Agents', filterLabel: 'Filter tasks', createLabel: 'New Agent' },
  ])('renders filter before folder-plus create agent action in $language', ({ language, heading, filterLabel, createLabel }) => {
    const originalLanguage = i18nService.getLanguage();
    try {
      i18nService.setLanguage(language, { persist: false });
      const html = renderHeader();

      const headingIndex = html.indexOf(`>${heading}<`);
      const filterIndex = html.indexOf(`aria-label="${filterLabel}"`);
      const createIndex = html.indexOf(`aria-label="${createLabel}"`);

      expect(headingIndex).toBeGreaterThanOrEqual(0);
      expect(filterIndex).toBeGreaterThan(headingIndex);
      expect(createIndex).toBeGreaterThan(filterIndex);
      expect(html).toContain('sidebar-filter-icon h-4 w-4');
      // Uses the dedicated folder-plus outline instead of a bare plus glyph.
      expect(html).toContain('M12.5 18H5a2 2 0 0 1-2-2V6');
      expect(html).toContain('M15.5 18h6');
      expect(html).toContain('M18.5 15v6');
    } finally {
      i18nService.setLanguage(originalLanguage, { persist: false });
    }
  });

  test('highlights active filters and shows the unread indicator dot on the header filter button', () => {
    const activeHtml = renderHeader({
      taskFilter: {
        status: SidebarTaskStatusFilter.Running,
        time: SidebarTaskTimeFilter.All,
      },
      hasUnreadCompletedTasks: true,
    });

    expect(activeHtml).toContain('bg-primary/10 text-primary');
    expect(activeHtml).toContain('data-active="true"');
    expect(activeHtml).toContain('h-[6px] w-[6px] rounded-full bg-primary');

    const idleHtml = renderHeader({ hasUnreadCompletedTasks: false });
    expect(idleHtml).not.toContain('bg-primary/10 text-primary');
    expect(idleHtml).not.toContain('data-active="true"');
    expect(idleHtml).not.toContain('rounded-full bg-primary');
  });
});
