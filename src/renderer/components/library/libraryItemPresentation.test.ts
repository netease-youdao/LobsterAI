import { describe, expect, test } from 'vitest';

import { HtmlShareAccessMode, HtmlShareSourceType, HtmlShareStatus } from '../../../shared/htmlShare/constants';
import { LibraryItemKind } from '../../../shared/library/constants';
import type { SharedFileItem } from '../../../shared/library/types';
import {
  getLibraryDisplayFileName,
  isLibraryWebsiteItem,
} from './libraryItemPresentation';

const makeSharedFile = (overrides: Partial<SharedFileItem> = {}): SharedFileItem => ({
  itemKind: LibraryItemKind.SharedFile,
  itemId: 'shared-file-1',
  title: 'report.pdf',
  category: 'document',
  sortTime: 1,
  createdAt: 1,
  isFavorite: false,
  shareId: 'share-1',
  url: 'https://example.com/share',
  sourceType: HtmlShareSourceType.DocumentFile,
  accessMode: HtmlShareAccessMode.Public,
  status: HtmlShareStatus.Live,
  ...overrides,
});

describe('library item presentation', () => {
  test('reserves the website icon for deployed sites', () => {
    expect(isLibraryWebsiteItem({ itemKind: LibraryItemKind.DeployedSite })).toBe(true);
    expect(isLibraryWebsiteItem({ itemKind: LibraryItemKind.LocalArtifact })).toBe(false);
    expect(isLibraryWebsiteItem({ itemKind: LibraryItemKind.SharedFile })).toBe(false);
  });

  test('restores the original Unicode title for legacy sanitized cloud entries', () => {
    const item = makeSharedFile({
      title: '员工信息表.xlsx',
      entryFile: '_____.xlsx',
    });

    expect(getLibraryDisplayFileName(item)).toBe('员工信息表.xlsx');
  });

  test('keeps the archive entry when it is intentionally different from the title', () => {
    const item = makeSharedFile({
      title: '季度报告',
      entryFile: 'index.html',
    });

    expect(getLibraryDisplayFileName(item)).toBe('index.html');
  });

  test('displays a Unicode archive entry from new clients unchanged', () => {
    const item = makeSharedFile({
      title: '员工信息表.xlsx',
      entryFile: '员工信息表.xlsx',
    });

    expect(getLibraryDisplayFileName(item)).toBe('员工信息表.xlsx');
  });
});
