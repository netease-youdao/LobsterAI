import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test } from 'vitest';

import WindowsAppTitleBar from './WindowsAppTitleBar';

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

afterEach(() => {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
    return;
  }
  Reflect.deleteProperty(globalThis, 'window');
});

const renderTitleBar = (
  platform: string,
  props: Partial<React.ComponentProps<typeof WindowsAppTitleBar>> = {},
) => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { electron: { platform } },
  });

  return renderToStaticMarkup(React.createElement(WindowsAppTitleBar, {
    onToggleSidebar: () => undefined,
    searchLabel: 'Search tasks',
    ...props,
  }));
};

describe('WindowsAppTitleBar', () => {
  test('keeps the logo at a fixed size and lets collapsed actions use their content width', () => {
    const html = renderTitleBar('win32', {
      isSidebarCollapsed: true,
      onNewChat: () => undefined,
      updateBadge: React.createElement('button', null, 'Restart to update'),
    });

    expect(html).toContain('class="h-4 w-4 max-w-none shrink-0"');
    expect(html).toContain('class="hidden text-sm font-medium text-foreground"');
    expect(html).not.toContain('style="width:220px"');
  });

  test.each([
    { sidebarWidth: 220, titleBarWidth: 196 },
    { sidebarWidth: 244, titleBarWidth: 220 },
    { sidebarWidth: 420, titleBarWidth: 396 },
  ])('keeps the expanded title bar aligned at sidebar width $sidebarWidth', ({ sidebarWidth, titleBarWidth }) => {
    const html = renderTitleBar('win32', { sidebarWidth });

    expect(html).toContain(`style="width:${titleBarWidth}px"`);
    expect(html).toContain('class="min-w-0 truncate text-sm font-medium text-foreground"');
    expect(html).toContain('class="flex min-w-0 items-center gap-2 overflow-hidden"');
  });

  test.each(['darwin', 'linux'])('does not render on %s', (platform) => {
    expect(renderTitleBar(platform)).toBe('');
  });

  test('renders icon-only task search between the sidebar and filter actions', () => {
    const html = renderTitleBar('win32', {
      sidebarToggleLabel: 'Toggle sidebar',
      onSearch: () => undefined,
      searchLabel: 'Search tasks',
      showFilterIcon: true,
      filterLabel: 'Filter tasks',
      onToggleFilter: () => undefined,
    });

    const sidebarActionIndex = html.indexOf('aria-label="Toggle sidebar"');
    const searchActionIndex = html.indexOf('aria-label="Search tasks"');
    const filterActionIndex = html.indexOf('aria-label="Filter tasks"');

    expect(sidebarActionIndex).toBeGreaterThanOrEqual(0);
    expect(searchActionIndex).toBeGreaterThan(sidebarActionIndex);
    expect(filterActionIndex).toBeGreaterThan(searchActionIndex);
    expect(html).toContain('class="h-[18px] w-[18px]"');
    expect(html).toContain('title="Search tasks"');
    expect(html).not.toContain('>Search tasks<');
  });

  test('does not render task search when no search callback is provided', () => {
    const html = renderTitleBar('win32');

    expect(html).not.toContain('aria-label="Search tasks"');
  });

  test('uses uniform Windows caption glyphs with full-size hit targets', () => {
    const html = renderTitleBar('win32');

    expect(html.match(/w-\[46px\]/g)).toHaveLength(3);
    expect(html.match(/h-3 w-3/g)).toHaveLength(3);
    expect(html.match(/hover:bg-black\/\[0\.05\]/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Minimize"');
    expect(html).toContain('aria-label="Maximize"');
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain('bg-background pl-3');
  });

  test('paints the strip above the sidebar only while the sidebar column is shown', () => {
    const withSidebar = renderTitleBar('win32', { sidebarColumnVisible: true, sidebarWidth: 260 });
    expect(withSidebar).toContain('var(--lobster-surface-raised) 260px, transparent 260px');

    const withoutSidebar = renderTitleBar('win32', { sidebarColumnVisible: false, sidebarWidth: 260 });
    expect(withoutSidebar).not.toContain('--lobster-surface-raised');
  });
});
