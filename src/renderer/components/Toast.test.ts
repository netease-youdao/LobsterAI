import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import Toast from './Toast';

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
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-label="关闭"');
    expect(html).not.toContain('modal-backdrop');
    expect(html).not.toContain('fixed inset-0');
  });
});
