import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import {
  LibraryArtifactType,
  LibraryAvailability,
  LibraryCategory,
  LibraryGridLimits,
  LibraryItemKind,
  LibraryOrigin,
  LibraryViewMode,
} from '../../../shared/library/constants';
import type { LocalArtifactItem } from '../../../shared/library/types';
import { i18nService } from '../../services/i18n';
import { getLibrarySessionAnchorKey } from './libraryScrollAnchor';
import {
  createVirtualRows,
  getLibraryAnchorRowIndices,
  getLibraryGridColumnCount,
  getLibraryItemRowIndices,
  LibrarySessionDisclosureControls,
  type LibrarySessionGroup,
} from './LibraryVirtualizedGroups';

const makeItem = (index: number): LocalArtifactItem => ({
  itemKind: LibraryItemKind.LocalArtifact,
  itemId: `file-${index}`,
  title: `file-${index}.txt`,
  category: LibraryCategory.Other,
  sortTime: 1_000 - index,
  createdAt: 1,
  isFavorite: false,
  latestSession: { sessionId: 'task', title: 'Task', agentId: 'main', createdAt: 1, updatedAt: 1, lastRelatedAt: 1 },
  filePath: `/tmp/file-${index}.txt`,
  artifactType: LibraryArtifactType.Text,
  extension: '.txt',
  availability: LibraryAvailability.Available,
  origin: LibraryOrigin.Conversation,
  relatedSessionCount: 1,
});

const makeGroup = (count: number, expanded = false, visibleCount = LibraryGridLimits.ItemPageSize): LibrarySessionGroup => ({
  key: 'task',
  title: 'Task',
  sortTime: 1,
  session: makeItem(0).latestSession,
  items: Array.from({ length: Math.min(count, expanded ? visibleCount : LibraryGridLimits.PreviewCount) }, (_, index) => makeItem(index)),
  disclosure: {
    expanded,
    matchedFileCount: count,
    loading: false,
    onExpand: () => undefined,
    onLoadMore: () => undefined,
    onCollapse: () => undefined,
  },
});

const renderControls = (group: LibrarySessionGroup, header = false): string => renderToStaticMarkup(
  React.createElement(LibrarySessionDisclosureControls, { group, contentId: 'grid-items', header }),
);

const getButtons = (html: string): string[] => html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];

const getRemainingText = (html: string): string | undefined => html.match(
  /<span\b[^>]*class="[^"]*\blibrary-disclosure-remaining\b[^"]*"[^>]*>([^<]*)<\/span>/,
)?.[1];

const expectNeutralControls = (html: string): void => {
  expect(html).toContain('library-disclosure-scope');
  for (const button of getButtons(html)) {
    expect(button).toContain('library-disclosure-button');
  }
  const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap(match => match[1].split(/\s+/));
  expect(classes.filter(className => /(?:^|[-:])(primary|accent|destructive|surface)(?:[-/]|$)/.test(className))).toEqual([]);
};

describe('LibraryVirtualizedGroups', () => {
  test.each([
    [200, 1],
    [504, 2],
    [756, 3],
    [1_120, 4],
  ])('uses %i px for %i grid columns', (width, expected) => {
    expect(getLibraryGridColumnCount(width)).toBe(expected);
  });

  test.each([0, 1, 3])('does not show controls for %i matching files', count => {
    expect(renderControls(makeGroup(count))).toBe('');
    expect(renderControls(makeGroup(count), true)).toBe('');
  });

  test.each([4, 7, 24, 25, 120, 10_000])('renders only three collapsed files and a separate footer for %i matches', count => {
    const group = makeGroup(count);
    const dates = [{ key: 'date', title: 'Today', sessionGroups: [group] }];
    const rows = createVirtualRows(dates, LibraryViewMode.Grid, 3);
    expect(rows).toHaveLength(4);
    expect(getLibraryItemRowIndices(rows).size).toBe(LibraryGridLimits.PreviewCount);
    expect(rows[rows.length - 1]?.key).toBe('controls:task');
    const html = renderControls(group);
    expect(html).toContain(i18nService.t('libraryGridMoreFiles').replace('{count}', String(count - LibraryGridLimits.PreviewCount)));
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="grid-items"');
    expect(html).not.toContain('library-disclosure-remaining');
    expectNeutralControls(html);
  });

  test('responds to column width without revealing hidden files', () => {
    const dates = [{ key: 'date', title: 'Today', sessionGroups: [makeGroup(10_000)] }];
    for (const columns of [1, 2, 3, 4]) {
      const rows = createVirtualRows(dates, LibraryViewMode.Grid, columns);
      expect(getLibraryItemRowIndices(rows).size).toBe(3);
      expect(rows.length).toBe(3 + Math.ceil(3 / columns));
    }
  });

  test('does not add disclosure rows to list or ordinary cloud grids', () => {
    const group = makeGroup(120);
    const dates = [{ key: 'date', title: 'Today', sessionGroups: [group] }];
    expect(createVirtualRows(dates, LibraryViewMode.List, 3)).toHaveLength(5);
    const cloudGroup = { ...group, disclosure: undefined };
    expect(createVirtualRows([{ ...dates[0], sessionGroups: [cloudGroup] }], LibraryViewMode.Grid, 3)).toHaveLength(3);
  });

  test.each([
    [25, 1, 1],
    [55, 24, 31],
    [120, 24, 96],
  ])('separates the remaining count from the next batch button for %i matching files', (count, nextBatch, remaining) => {
    const html = renderControls(makeGroup(count, true));
    const moreButton = getButtons(html)[0];
    const remainingLabel = i18nService.t('libraryGridRemainingFiles').replace('{count}', String(remaining));
    expect(moreButton).toContain(i18nService.t('libraryGridLoadMore').replace('{count}', String(nextBatch)));
    expect(moreButton).not.toContain(remainingLabel);
    expect(getRemainingText(html)).toBe(remainingLabel);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain(i18nService.t('libraryGridCollapse'));
    expect(html).not.toContain('{remaining}');
    expectNeutralControls(html);
  });

  test.each([
    { language: 'zh', more: '继续显示 24 个', remaining: '还有 31 个文件', collapsed: '还有 52 个文件', collapse: '收起' },
    { language: 'en', more: 'Show 24 more', remaining: '31 files remaining', collapsed: '52 more files', collapse: 'Collapse' },
  ] as const)('provides separate localized controls and remaining text in $language', ({ language, more, remaining, collapsed, collapse }) => {
    const originalLanguage = i18nService.getLanguage();
    try {
      i18nService.setLanguage(language, { persist: false });
      const html = renderControls(makeGroup(55, true));
      const moreButton = getButtons(html)[0];
      expect(moreButton).toContain(more);
      expect(moreButton).not.toContain(remaining);
      expect(getRemainingText(html)).toBe(remaining);
      expect(renderControls(makeGroup(55))).toContain(collapsed);
      const header = renderControls(makeGroup(55, true), true);
      expect(header).toContain(`aria-label="${collapse} Task"`);
      expect(header).toContain('aria-expanded="true"');
      expect(header).toContain('aria-controls="grid-items"');
    } finally {
      i18nService.setLanguage(originalLanguage, { persist: false });
    }
  });

  test('keeps collapse in both header and footer after the entire small task is revealed', () => {
    const group = makeGroup(7, true);
    const footer = renderControls(group);
    const header = renderControls(group, true);
    expect(footer).toContain(i18nService.t('libraryGridCollapse'));
    expect(footer).not.toContain('library-disclosure-remaining');
    expect(getButtons(footer)).toHaveLength(1);
    expect(footer).toContain('library-disclosure-button-secondary');
    expect(footer).not.toContain('library-disclosure-button-header');
    expect(header).toContain(i18nService.t('libraryGridCollapse'));
    expect(header).toContain('library-disclosure-button-header');
    expect(getButtons(header)).toHaveLength(1);
    expectNeutralControls(footer);
    expectNeutralControls(header);
  });

  test.each([false, true])('uses a decorative neutral spinner and keeps collapse available while loading (expanded: %s)', expanded => {
    const group = makeGroup(120, expanded);
    group.disclosure!.loading = true;
    const html = renderControls(group);
    const [loadingButton, collapseButton] = getButtons(html);
    expect(html).toContain('aria-busy="true"');
    expect(loadingButton).toContain(i18nService.t('libraryGridLoading'));
    expect(loadingButton).toContain('library-disclosure-spinner');
    expect(loadingButton).toMatch(/<span\b[^>]*aria-hidden="true"[^>]*>/);
    expect(loadingButton).not.toContain('<svg');
    expect(loadingButton).toContain('disabled=""');
    expect(collapseButton).toContain(i18nService.t('libraryGridCollapse'));
    expect(collapseButton).not.toContain('disabled=""');
    expect(renderControls(group, true)).not.toContain('disabled=""');
    expect(html).not.toContain('library-disclosure-remaining');
    expectNeutralControls(html);
  });

  test('blocks stale item paging and retry without blocking collapse', () => {
    const group = makeGroup(120, true);
    group.disclosure!.disabled = true;
    const html = renderControls(group);
    expect((html.match(/<button/g) ?? [])).toHaveLength(2);
    expect((html.match(/disabled=""/g) ?? [])).toHaveLength(1);
    expect(renderControls(group, true)).not.toContain('disabled=""');
    expectNeutralControls(html);
    group.disclosure!.error = 'The task is being refreshed';
    const failedHtml = renderControls(group);
    expect(failedHtml).toContain(i18nService.t('libraryGridRetry'));
    expect((failedHtml.match(/disabled=""/g) ?? [])).toHaveLength(1);
    expect(failedHtml).toContain(i18nService.t('libraryGridCollapse'));
    expect(failedHtml).not.toContain('library-disclosure-remaining');
    expectNeutralControls(failedHtml);
  });

  test('renders a local error and retry without removing visible cards', () => {
    const group = makeGroup(120, true);
    group.disclosure!.error = 'Task loading failed';
    const html = renderControls(group);
    expect(html).toContain('role="alert"');
    expect(html).toContain('library-disclosure-error');
    expect(html).toContain('Task loading failed');
    expect(html).toContain(i18nService.t('libraryGridRetry'));
    expect(html).not.toContain('library-disclosure-remaining');
    expect(html).not.toContain('library-disclosure-spinner');
    expectNeutralControls(html);
    const rows = createVirtualRows([{ key: 'date', title: 'Today', sessionGroups: [group] }], LibraryViewMode.Grid, 3);
    expect(getLibraryItemRowIndices(rows).size).toBe(24);
  });

  test('can locate the surviving session header after files are collapsed or the date changes', () => {
    const group = makeGroup(120, true);
    const dates = [{ key: 'old-date', title: 'Yesterday', sessionGroups: [group] }];
    const expandedRows = createVirtualRows(dates, LibraryViewMode.Grid, 3);
    const hiddenFileKey = `${LibraryItemKind.LocalArtifact}:file-23`;
    expect(getLibraryAnchorRowIndices(expandedRows).has(hiddenFileKey)).toBe(true);
    const collapsed = makeGroup(120);
    const collapsedRows = createVirtualRows([{ key: 'new-date', title: 'Today', sessionGroups: [collapsed] }], LibraryViewMode.Grid, 3);
    const indices = getLibraryAnchorRowIndices(collapsedRows);
    expect(indices.has(hiddenFileKey)).toBe(false);
    expect(indices.get(getLibrarySessionAnchorKey('task'))).toBe(1);
    expect(indices.has(`${LibraryItemKind.LocalArtifact}:file-0`)).toBe(true);
  });
});
