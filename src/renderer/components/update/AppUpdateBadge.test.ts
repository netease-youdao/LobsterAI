import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';

import { type AppUpdateRuntimeState, AppUpdateStatus } from '../../../shared/appUpdate/constants';
import AppUpdateBadge from './AppUpdateBadge';

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
      zh: { title: '', content: [] },
      en: { title: '', content: [] },
    },
    url: 'https://updates.example.com/lobsterai-2026.11.25.dmg',
  },
  progress: null,
  readyFilePath: status === AppUpdateStatus.Ready ? '/tmp/update.dmg' : null,
  readyFileHash: null,
  errorMessage: null,
  ...overrides,
});

describe('AppUpdateBadge', () => {
  test('renders a neutral pill with static status dot and version when ready', () => {
    const html = renderToStaticMarkup(
      React.createElement(AppUpdateBadge, {
        updateState: createState(AppUpdateStatus.Ready),
        onClick: vi.fn(),
      }),
    );

    expect(html).toContain('重启更新');
    expect(html).toContain('v2026.11.25');
    expect(html).toContain('bg-surface/90');
    expect(html).toContain('bg-emerald-500');
    expect(html).not.toContain('animate-ping');
  });

  test('omits version text on error while keeping destructive status tone', () => {
    const html = renderToStaticMarkup(
      React.createElement(AppUpdateBadge, {
        updateState: createState(AppUpdateStatus.Error, { errorMessage: 'boom' }),
        onClick: vi.fn(),
      }),
    );

    expect(html).toContain('更新失败');
    expect(html).toContain('bg-destructive');
    expect(html).not.toContain('>v2026.11.25<');
  });
});
