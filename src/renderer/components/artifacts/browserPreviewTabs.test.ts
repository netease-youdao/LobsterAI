import { describe, expect, test } from 'vitest';

import {
  activateBrowserPreviewTab,
  closeBrowserPreviewTab,
  createBrowserPreviewTab,
  EMPTY_SESSION_BROWSER_TABS_STATE,
  getActiveBrowserPreviewTab,
  getBrowserPreviewTabLabel,
  insertBrowserPreviewTabAfter,
  openOrReuseBlankBrowserPreviewTab,
  updateBrowserPreviewTab,
} from './browserPreviewTabs';

describe('browserPreviewTabs', () => {
  test('inserts a newly opened tab immediately after the opener tab and activates it', () => {
    const baidu = createBrowserPreviewTab({ id: 'browser:1', url: 'https://www.baidu.com/', address: 'https://www.baidu.com/' });
    const github = createBrowserPreviewTab({ id: 'browser:2', url: 'https://github.com/', address: 'https://github.com/' });
    const search = createBrowserPreviewTab({
      id: 'browser:3',
      url: 'https://www.baidu.com/s?wd=test',
      address: 'https://www.baidu.com/s?wd=test',
      initialReferrer: 'https://www.baidu.com/',
    });

    const initial = { tabs: [baidu, github], activeTabId: baidu.id };
    const next = insertBrowserPreviewTabAfter(initial, { afterTabId: baidu.id, tab: search });

    expect(next.tabs.map(tab => tab.id)).toEqual(['browser:1', 'browser:3', 'browser:2']);
    expect(next.activeTabId).toBe('browser:3');
  });

  test('supports opening a background tab after the opener without stealing focus', () => {
    const baidu = createBrowserPreviewTab({ id: 'browser:1', url: 'https://www.baidu.com/', address: 'https://www.baidu.com/' });
    const bgTab = createBrowserPreviewTab({ id: 'browser:2', url: 'https://www.baidu.com/s?wd=bg', address: 'https://www.baidu.com/s?wd=bg' });

    const next = insertBrowserPreviewTabAfter(
      { tabs: [baidu], activeTabId: baidu.id },
      { afterTabId: baidu.id, tab: bgTab, activate: false },
    );

    expect(next.tabs.map(tab => tab.id)).toEqual(['browser:1', 'browser:2']);
    expect(next.activeTabId).toBe('browser:1');
  });

  test('appends at the end when opener tab id is missing or unknown', () => {
    const tab1 = createBrowserPreviewTab({ id: 'browser:1', url: 'https://example.com/' });
    const tab2 = createBrowserPreviewTab({ id: 'browser:2', url: 'https://example.org/' });

    const next = insertBrowserPreviewTabAfter(
      { tabs: [tab1], activeTabId: tab1.id },
      { afterTabId: 'browser:missing', tab: tab2 },
    );

    expect(next.tabs.map(tab => tab.id)).toEqual(['browser:1', 'browser:2']);
    expect(next.activeTabId).toBe('browser:2');
  });

  test('reuses an existing blank tab when requested and preserves its id', () => {
    const blank = createBrowserPreviewTab({ id: 'browser:blank' });
    const loaded = createBrowserPreviewTab({ id: 'browser:loaded', url: 'https://example.com/', address: 'https://example.com/' });

    const reused = openOrReuseBlankBrowserPreviewTab(
      { tabs: [loaded, blank], activeTabId: loaded.id },
      {
        tab: createBrowserPreviewTab({ id: 'browser:new', url: 'http://localhost:3000', address: 'http://localhost:3000' }),
        reuseBlank: true,
      },
    );

    expect(reused.tabId).toBe('browser:blank');
    expect(reused.state.tabs.map(tab => tab.id)).toEqual(['browser:loaded', 'browser:blank']);
    expect(reused.state.tabs[1].url).toBe('http://localhost:3000');
    expect(reused.state.activeTabId).toBe('browser:blank');
  });

  test('closes active tab and falls back to the adjacent surviving browser tab', () => {
    const t1 = createBrowserPreviewTab({ id: 'browser:1', url: 'https://a.test/' });
    const t2 = createBrowserPreviewTab({ id: 'browser:2', url: 'https://b.test/' });
    const t3 = createBrowserPreviewTab({ id: 'browser:3', url: 'https://c.test/' });

    const closeMiddle = closeBrowserPreviewTab({ tabs: [t1, t2, t3], activeTabId: t2.id }, t2.id);
    expect(closeMiddle.closedTab?.id).toBe('browser:2');
    expect(closeMiddle.state.tabs.map(tab => tab.id)).toEqual(['browser:1', 'browser:3']);
    expect(closeMiddle.nextActiveTabId).toBe('browser:3');

    const closeLast = closeBrowserPreviewTab(closeMiddle.state, t3.id);
    expect(closeLast.state.tabs.map(tab => tab.id)).toEqual(['browser:1']);
    expect(closeLast.nextActiveTabId).toBe('browser:1');

    const closeOnly = closeBrowserPreviewTab(closeLast.state, t1.id);
    expect(closeOnly.state).toEqual(EMPTY_SESSION_BROWSER_TABS_STATE);
    expect(closeOnly.nextActiveTabId).toBeNull();
  });

  test('closing an inactive tab keeps the current active tab untouched', () => {
    const t1 = createBrowserPreviewTab({ id: 'browser:1', url: 'https://a.test/' });
    const t2 = createBrowserPreviewTab({ id: 'browser:2', url: 'https://b.test/' });

    const result = closeBrowserPreviewTab({ tabs: [t1, t2], activeTabId: t2.id }, t1.id);
    expect(result.state.tabs.map(tab => tab.id)).toEqual(['browser:2']);
    expect(result.state.activeTabId).toBe('browser:2');
  });

  test('updates a single tab without mutating siblings and activates cleanly', () => {
    const t1 = createBrowserPreviewTab({ id: 'browser:1', url: 'https://a.test/' });
    const t2 = createBrowserPreviewTab({ id: 'browser:2', url: 'https://b.test/' });
    const initial = { tabs: [t1, t2], activeTabId: t1.id };

    const updated = updateBrowserPreviewTab(initial, t2.id, tab => ({ ...tab, title: 'B Page' }));
    expect(updated.tabs[0]).toBe(t1);
    expect(updated.tabs[1].title).toBe('B Page');

    const activated = activateBrowserPreviewTab(updated, t2.id);
    expect(getActiveBrowserPreviewTab(activated)?.id).toBe('browser:2');
  });

  test('computes tab labels from page title, fallback host, or localized label', () => {
    expect(getBrowserPreviewTabLabel(
      { title: ' 百度搜索 ', url: 'https://www.baidu.com/s?wd=1', htmlPreviewArtifactId: null },
      '浏览器',
    )).toBe('百度搜索');

    expect(getBrowserPreviewTabLabel(
      { title: '', url: 'https://www.baidu.com/s?wd=1', htmlPreviewArtifactId: null },
      '浏览器',
    )).toBe('www.baidu.com');

    expect(getBrowserPreviewTabLabel(
      { title: '', url: 'http://127.0.0.1:54321/preview/index.html', htmlPreviewArtifactId: 'html-1' },
      '浏览器',
    )).toBe('浏览器');

    expect(getBrowserPreviewTabLabel(
      { title: '', url: '', htmlPreviewArtifactId: null },
      '浏览器',
    )).toBe('浏览器');
  });
});
