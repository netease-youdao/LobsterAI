import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';

import AppUpdateInstallConfirmDialog from './AppUpdateInstallConfirmDialog';

describe('AppUpdateInstallConfirmDialog', () => {
  test('warns that installing interrupts running tasks and offers both choices', () => {
    const html = renderToStaticMarkup(
      React.createElement(AppUpdateInstallConfirmDialog, {
        onCancel: vi.fn(),
        onConfirm: vi.fn(),
      }),
    );

    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('有任务正在进行中');
    expect(html).toContain('更新会中断当前正在进行的任务');
    expect(html).toContain('继续更新');
    expect(html).toContain('取消');
    expect(html).toContain('z-[9999]');
  });
});
