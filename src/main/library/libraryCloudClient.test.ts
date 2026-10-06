import { describe, expect, test, vi } from 'vitest';

import {
  HtmlShareAccessMode,
  HtmlShareSourceType,
  HtmlShareStatus,
} from '../../shared/htmlShare/constants';
import {
  LibraryCategory,
  LibraryCloudAvailabilityFilter,
  LibraryCloudKind,
  LibraryItemKind,
  LibrarySharedStatusFilter,
} from '../../shared/library/constants';
import { SiteKind, SiteStatus } from '../../shared/site/constants';
import { listLibraryCloudItems } from './libraryCloudClient';
import type { LibraryLocalStore } from './libraryLocalStore';

const cloudItem = (itemId: string, sortTime: number) => ({
  itemKind: LibraryItemKind.SharedFile,
  itemId,
  title: `${itemId}.pdf`,
  url: `https://share.example/${itemId}`,
  category: LibraryCategory.Document,
  sourceType: HtmlShareSourceType.DocumentFile,
  accessMode: HtmlShareAccessMode.Public,
  status: HtmlShareStatus.Live,
  sortTime,
});

const response = (
  list: Array<ReturnType<typeof cloudItem> | ReturnType<typeof siteItem>>,
  nextCursor?: string,
  serverNow = 1_000,
  recoveryPending = false,
) => new Response(JSON.stringify({
  code: 0,
  message: 'success',
  data: {
    list,
    hasMore: Boolean(nextCursor),
    nextCursor,
    counts: { sharedFile: 3, deployedSite: 0 },
    sharedStatusCounts: { all: 3, live: 2, disabled: 1 },
    serverNow,
    recoveryPending,
  },
}), { status: 200, headers: { 'content-type': 'application/json' } });

const createStore = (favoriteIds: string[]): LibraryLocalStore => ({
  getFavoriteIds: () => new Set(favoriteIds),
  resolveCloudSession: () => undefined,
}) as unknown as LibraryLocalStore;

function siteItem(itemId: string, sortTime: number, siteStatus = SiteStatus.Online) {
  return {
    itemKind: LibraryItemKind.DeployedSite,
    itemId,
    title: itemId,
    url: `https://${itemId}.example`,
    category: LibraryCategory.Web,
    siteKind: SiteKind.StaticSite,
    siteStatus,
    shareStatus: HtmlShareStatus.Live,
    accessMode: HtmlShareAccessMode.Public,
    sortTime,
  };
}

describe('listLibraryCloudItems', () => {
  test('normalizes a server page and preserves its cursor', async () => {
    const fetchWithAuth = vi.fn(async () => response([cloudItem('share-1', 200)], 'next-1'));

    const result = await listLibraryCloudItems(
      'https://api.example',
      fetchWithAuth,
      createStore([]),
      'cloud:owner',
      { kind: LibraryCloudKind.All },
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        hasMore: true,
        nextCursor: 'next-1',
        serverNow: 1_000,
        list: [{ itemId: 'share-1', isFavorite: false }],
      },
    });
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: true,
      data: { sharedStatusCounts: { all: 3, live: 2, disabled: 1 } },
    });
  });

  test('passes the shared status filter to the server', async () => {
    const fetchWithAuth = vi.fn(async () => response([cloudItem('share-1', 200)]));

    await listLibraryCloudItems(
      'https://api.example',
      fetchWithAuth,
      createStore([]),
      'cloud:owner',
      {
        kind: LibraryCloudKind.SharedFile,
        sharedStatus: LibrarySharedStatusFilter.Disabled,
      },
    );

    expect(fetchWithAuth.mock.calls[0]?.[0]).toContain('sharedStatus=disabled');
  });

  test('maps the site category to the deployed-site API query', async () => {
    const fetchWithAuth = vi.fn(async () => response([siteItem('site-1', 200)]));

    const result = await listLibraryCloudItems(
      'https://api.example',
      fetchWithAuth,
      createStore([]),
      'cloud:owner',
      { category: LibraryCategory.Site },
    );

    expect(fetchWithAuth.mock.calls[0]?.[0]).toContain('kind=deployed_site');
    expect(fetchWithAuth.mock.calls[0]?.[0]).toContain('category=all');
    expect(result).toMatchObject({
      success: true,
      data: { list: [{ itemId: 'site-1', category: LibraryCategory.Site }] },
    });
  });

  test('keeps deployed sites out of file-type category queries', async () => {
    const fetchWithAuth = vi.fn(async () => response([cloudItem('share-1', 200)]));

    await listLibraryCloudItems(
      'https://api.example',
      fetchWithAuth,
      createStore([]),
      'cloud:owner',
      { kind: LibraryCloudKind.All, category: LibraryCategory.Document },
    );

    expect(fetchWithAuth.mock.calls[0]?.[0]).toContain('kind=shared_file');
    expect(fetchWithAuth.mock.calls[0]?.[0]).toContain('category=document');
  });

  test('filters mixed cloud pages by normalized availability', async () => {
    const fetchWithAuth = vi.fn()
      .mockResolvedValueOnce(response([
        cloudItem('share-1', 300),
        siteItem('site-deploying', 200, SiteStatus.Deploying),
      ], 'next-1'))
      .mockResolvedValueOnce(response([siteItem('site-online', 100)]));

    const result = await listLibraryCloudItems(
      'https://api.example',
      fetchWithAuth,
      createStore([]),
      'cloud:owner',
      {
        availability: LibraryCloudAvailabilityFilter.Unavailable,
        pageSize: 2,
      },
    );

    expect(result).toMatchObject({
      success: true,
      data: { list: [{ itemId: 'site-deploying' }], hasMore: false },
    });
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  test('normalizes fixed expiry and filters it using the server clock', async () => {
    const expiring = { ...cloudItem('share-expired', 300), accessExpiresAt: 9_999 };
    const fetchWithAuth = vi.fn(async () => response([expiring], undefined, 10_000));

    const result = await listLibraryCloudItems(
      'https://api.example',
      fetchWithAuth,
      createStore([]),
      'cloud:owner',
      { availability: LibraryCloudAvailabilityFilter.Unavailable },
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        serverNow: 10_000,
        list: [{ itemId: 'share-expired', accessExpiresAt: 9_999 }],
      },
    });
  });

  test('normalizes the effective entitlement projection and filters stale live rows', async () => {
    const projected = {
      ...cloudItem('share-entitlement-expired', 300),
      effectiveAvailable: false,
      effectiveExpiresAt: 9_999,
      effectiveUnavailableReason: 'entitlement_grace_expired',
    };
    const fetchWithAuth = vi.fn(async () => response([projected], undefined, 10_000));

    const result = await listLibraryCloudItems(
      'https://api.example',
      fetchWithAuth,
      createStore([]),
      'cloud:owner',
      { availability: LibraryCloudAvailabilityFilter.Unavailable },
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        list: [{
          itemId: 'share-entitlement-expired',
          effectiveAvailable: false,
          effectiveExpiresAt: 9_999,
          effectiveUnavailableReason: 'entitlement_grace_expired',
        }],
      },
    });
  });

  test('walks bounded server pages to find locally favorited cloud items', async () => {
    const fetchWithAuth = vi.fn()
      .mockResolvedValueOnce(response([cloudItem('share-1', 300)], 'next-1', 1_000, true))
      .mockResolvedValueOnce(response([cloudItem('share-2', 200)], 'next-2'))
      .mockResolvedValueOnce(response([cloudItem('share-3', 100)]));

    const result = await listLibraryCloudItems(
      'https://api.example',
      fetchWithAuth,
      createStore([`${LibraryItemKind.SharedFile}:share-2`]),
      'cloud:owner',
      { favoritesOnly: true, pageSize: 2 },
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        hasMore: false,
        recoveryPending: true,
        list: [{ itemId: 'share-2', isFavorite: true }],
      },
    });
    expect(fetchWithAuth).toHaveBeenCalledTimes(3);
  });
});
