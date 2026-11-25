import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';

import {
  APP_UPDATE_FILE_INVALID_ERROR,
  type AppUpdateRuntimeState,
  AppUpdateStatus,
} from '../../../shared/appUpdate/constants';
import AppUpdateModal from './AppUpdateModal';

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
      zh: { title: '本次更新', content: ['优化卡片视觉体系', '修复皮肤悬停样式'] },
      en: { title: 'This release', content: ['Refined update card UI', 'Fixed skin hover styles'] },
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

const renderModal = (state: AppUpdateRuntimeState): string => renderToStaticMarkup(
  React.createElement(AppUpdateModal, {
    updateState: state,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
  }),
);

describe('AppUpdateModal', () => {
  test('renders accessible dialog shell, structured release notes, and monochrome buttons when ready', () => {
    const html = renderModal(createState(AppUpdateStatus.Ready));

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('更新已就绪');
    expect(html).toContain('v2026.11.25 · 2026-11-25');
    expect(html).toContain('本次更新');
    expect(html).toContain('优化卡片视觉体系');
    expect(html).toContain('bg-surface-raised/60');
    expect(html).toContain('稍后');
    expect(html).toContain('立即更新');
    expect(html).toContain('bg-foreground');
    expect(html).toContain('aria-label="关闭"');
  });

  test('hides the close button while installing', () => {
    const html = renderModal(createState(AppUpdateStatus.Installing));

    expect(html).toContain('应用即将退出并在后台完成更新');
    expect(html).not.toContain('aria-label="关闭"');
  });

  test('renders formatted error callout and retry button on failure', () => {
    const html = renderModal(createState(AppUpdateStatus.Error, {
      errorMessage: APP_UPDATE_FILE_INVALID_ERROR,
    }));

    expect(html).toContain('下载失败');
    expect(html).toContain('更新包文件校验失败');
    expect(html).toContain('重试');
  });
});
