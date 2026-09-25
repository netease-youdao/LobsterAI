// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';

import ProgressCardMarkdown from './ProgressCardMarkdown';
test('renders measured progress and Markdown while stripping active HTML and external images', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div'); const root = createRoot(host);
  await act(async () => root.render(React.createElement(ProgressCardMarkdown, { content: '**Goal**\n\n<progress value="2" max="4" aria-label="Checked" onclick="alert(1)"></progress>\n\n<script>alert(1)</script>\n\n<img src="https://bad.test/x" onerror="alert(1)">\n\n![Secret](https://bad.test/y)\n\n[bad](javascript:alert)' })));
  expect(host.querySelector('strong')?.textContent).toBe('Goal');
  expect(host.querySelector('progress')?.value).toBe(2);
  expect(host.querySelector('progress')?.getAttribute('onclick')).toBeNull();
  expect(host.querySelector('script, img')).toBeNull();
  expect(host.innerHTML).not.toContain('javascript:');
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
