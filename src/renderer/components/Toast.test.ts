import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import Toast, {
  DEFAULT_ACTION_TOAST_DURATION_MS,
  DEFAULT_TOAST_DURATION_MS,
  resolveToastDurationMs,
  ToastPlacement,
} from './Toast';

describe('Toast', () => {
  test('renders non-blocking feedback without a modal backdrop', () => {
    const html = renderToStaticMarkup(React.createElement(Toast, {
      message: '消息已复制',
      closeLabel: '关闭',
      onClose: () => {},
    }));

    expect(html).toContain('pointer-events-none');
    expect(html).toContain('left-1/2');
    expect(html).toContain('top-1/2');
    expect(html).toContain('-translate-x-1/2');
    expect(html).toContain('-translate-y-1/2');
    expect(html).not.toContain('bottom-5');
    expect(html).toContain('non-draggable');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-label="关闭"');
    expect(html).not.toContain('modal-backdrop');
    expect(html).not.toContain('fixed inset-0');
  });

  test('renders top-placed action toast below the window title bar without bottom positioning', () => {
    const html = renderToStaticMarkup(React.createElement(Toast, {
      placement: ToastPlacement.Top,
      message: '已关闭 104 项闲置能力，每轮预计可省 ~3.5k tokens',
      actionLabel: '撤销',
      onAction: () => {},
      closeLabel: '关闭',
      onClose: () => {},
    }));

    expect(html).toContain('top-12');
    expect(html).toContain('max-w-[min(42rem,calc(100vw-2rem))]');
    expect(html).toContain('non-draggable');
    expect(html).toContain('撤销');
    expect(html).not.toContain('top-1/2');
    expect(html).not.toContain('bottom-');
  });

  test('resolves toast duration using explicit durationMs before default action/plain durations', () => {
    expect(resolveToastDurationMs({ message: 'plain' })).toBe(DEFAULT_TOAST_DURATION_MS);
    expect(resolveToastDurationMs({
      message: 'with action',
      actionLabel: 'Undo',
      onAction: () => {},
    })).toBe(DEFAULT_ACTION_TOAST_DURATION_MS);
    expect(resolveToastDurationMs({
      message: 'custom',
      actionLabel: 'Undo',
      onAction: () => {},
      durationMs: 8000,
    })).toBe(8000);
    expect(resolveToastDurationMs({
      message: 'invalid custom',
      durationMs: 0,
    })).toBe(DEFAULT_TOAST_DURATION_MS);
  });
});
