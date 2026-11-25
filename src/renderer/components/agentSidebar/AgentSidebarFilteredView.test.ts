import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import { i18nService } from '../../services/i18n';
import { CoworkSessionStatusValue } from '../../types/cowork';
import AgentSidebarFilteredView from './AgentSidebarFilteredView';
import { AgentSidebarIndicator } from './constants';
import {
  type AgentSidebarActivityItem,
  SidebarTaskStatusFilter,
  SidebarTaskTimeFilter,
} from './taskFilter';

const makeActivityItem = (id: string, timestamp: number): AgentSidebarActivityItem => ({
  agent: {
    id: 'main',
    name: 'Main Agent',
    icon: '',
    enabled: true,
    pinned: false,
    isExpanded: true,
    isTaskListExpanded: false,
    canExpandTasks: false,
    canCollapseTasks: false,
    isLoadingTasks: false,
    hasLoadError: false,
    tasks: [],
  },
  task: {
    id,
    agentId: 'main',
    title: `Task ${id}`,
    isScheduledTask: false,
    status: CoworkSessionStatusValue.Completed,
    pinned: false,
    updatedAt: timestamp,
    createdAt: timestamp,
    indicator: AgentSidebarIndicator.CompletedUnread,
    isSelected: false,
  },
});

describe('AgentSidebarFilteredView', () => {
  test('shows active filter summary and matched count once loaded', () => {
    const originalLanguage = i18nService.getLanguage();
    try {
      i18nService.setLanguage('zh', { persist: false });
      const now = Date.now();
      const html = renderToStaticMarkup(
        React.createElement(AgentSidebarFilteredView, {
          filter: {
            status: SidebarTaskStatusFilter.CompletedUnread,
            time: SidebarTaskTimeFilter.All,
          },
          items: [makeActivityItem('1', now), makeActivityItem('2', now - 1000)],
          isLoading: false,
          hasError: false,
          onClear: () => undefined,
          renderTask: (item) => React.createElement('div', { key: item.task.id }, item.task.title),
        }),
      );

      expect(html).toContain('已筛选：');
      expect(html).toContain('>完成未读<');
      expect(html).toContain('(2)');
      expect(html).toContain('Task 1');
      expect(html).toContain('Task 2');
    } finally {
      i18nService.setLanguage(originalLanguage, { persist: false });
    }
  });

  test('hides result count while loading or empty', () => {
    const html = renderToStaticMarkup(
      React.createElement(AgentSidebarFilteredView, {
        filter: {
          status: SidebarTaskStatusFilter.CompletedUnread,
          time: SidebarTaskTimeFilter.Today,
        },
        items: [],
        isLoading: false,
        hasError: false,
        onClear: () => undefined,
        renderTask: () => null,
      }),
    );

    expect(html).not.toContain('(0)');
  });
});
