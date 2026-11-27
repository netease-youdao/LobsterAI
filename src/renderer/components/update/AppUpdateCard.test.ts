import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';

import {
  APP_UPDATE_ELEVATION_DECLINED_ERROR,
  type AppUpdateRuntimeState,
  AppUpdateStatus,
} from '../../../shared/appUpdate/constants';
import AppUpdateCard from './AppUpdateCard';

const createState = (
  status: AppUpdateRuntimeState['status'],
  overrides: Partial<AppUpdateRuntimeState> = {},
): AppUpdateRuntimeState => ({
  status,
  source: null,
  info: {
    latestVersion: '2026.11.25',
    date: '2026-11-25',
    changeLog: {
      zh: { title: '本次更新', content: ['第一项优化', '第二项优化', '第三项优化'] },
      en: { title: 'This release', content: ['First change', 'Second change', 'Third change'] },
    },
    url: 'https://updates.example.com/lobsterai-2026.11.25.dmg',
  },
  progress: null,
  readyFilePath: status === AppUpdateStatus.Ready || status === AppUpdateStatus.Installing
    ? '/tmp/lobsterai-update.dmg'
    : null,
  readyFileHash: null,
  errorMessage: null,
  ...overrides,
});

const renderCard = (
  state: AppUpdateRuntimeState,
  initialCollapsedVersion: string | null = null,
): string => renderToStaticMarkup(
  React.createElement(AppUpdateCard, {
    updateState: state,
    onUpdate: vi.fn(),
    onShowDetails: vi.fn(),
    initialCollapsedVersion,
  }),
);

describe('AppUpdateCard', () => {
  test('renders a neutral high-contrast ready card with meta changelog trigger and single primary CTA', () => {
    const html = renderCard(createState(AppUpdateStatus.Ready));

    expect(html).toContain('更新已就绪');
    expect(html).toContain('v2026.11.25');
    expect(html).toContain('更新内容');
    expect(html).toContain('重启完成更新');
    expect(html).toContain('第一项优化');
    expect(html).toContain('第二项优化');
    expect(html).not.toContain('第三项优化');
    expect(html).toContain('bg-action');
    expect(html).toContain('data-skin-button-solid="true"');
    expect(html).toContain('data-skin-button-plain="true"');
    expect(html).not.toContain('bg-emerald-600');
    expect(html).not.toContain('animate-ping');
  });

  test('renders a compact sidebar-aligned row when collapsed for the current version', () => {
    const html = renderCard(createState(AppUpdateStatus.Ready), '2026.11.25');

    expect(html).toContain('更新已就绪');
    expect(html).toContain('v2026.11.25');
    expect(html).toContain('h-[34px]');
    expect(html).toContain('rounded-[10px]');
    expect(html).not.toContain('重启完成更新');
    expect(html).not.toContain('animate-ping');
  });

  test('formats stable main-process error markers into localized copy', () => {
    const html = renderCard(createState(AppUpdateStatus.Error, {
      errorMessage: APP_UPDATE_ELEVATION_DECLINED_ERROR,
    }));

    expect(html).toContain('更新失败');
    expect(html).toContain('更新需要系统授权');
    expect(html).not.toContain(APP_UPDATE_ELEVATION_DECLINED_ERROR);
    expect(html).toContain('重试');
  });

  test('disables the primary button and shows spinner while installing', () => {
    const html = renderCard(createState(AppUpdateStatus.Installing));

    expect(html).toContain('正在安装…');
    expect(html).toContain('disabled=""');
    expect(html).toContain('animate-spin');
  });
});
