import { beforeEach, describe, expect, test, vi } from 'vitest';

const storeMock = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
}));

vi.mock('../services/store', () => ({
  localStore: storeMock,
}));

import {
  getSidebarBannerStorageKey,
  readSidebarBannerDismissState,
  saveSidebarBannerDismissState,
  shouldShowSidebarBanner,
} from './sidebarAdBannerState';

describe('sidebar ad banner state', () => {
  beforeEach(() => {
    storeMock.getItem.mockReset();
    storeMock.setItem.mockReset();
  });

  test('stores close state by sidebar slot version, not by user or current slide', () => {
    expect(getSidebarBannerStorageKey([
      {
        id: 42,
        activityDescription: '邀请好友赚积分',
        linkUrl: 'https://lobsterai.youdao.com/invitation',
        imageUrl: 'https://nos.example.com/banner.png',
        updatedAt: '2026-07-02T10:00:00',
      },
      {
        id: 43,
        activityDescription: '新活动',
        linkUrl: 'https://lobsterai.youdao.com/activity',
        imageUrl: 'https://nos.example.com/banner-2.png',
        updatedAt: '2026-07-03T10:00:00',
      },
    ])).toBe('client_sidebar_banner.desktop_sidebar.42:2026-07-02T10:00:00.43:2026-07-03T10:00:00');
  });

  test('changes close key when a banner is added or updated', () => {
    const firstVersion = getSidebarBannerStorageKey([
      {
        id: 42,
        activityDescription: '邀请好友赚积分',
        linkUrl: 'https://lobsterai.youdao.com/invitation',
        imageUrl: 'https://nos.example.com/banner.png',
        updatedAt: '2026-07-02T10:00:00',
      },
    ]);
    const updatedVersion = getSidebarBannerStorageKey([
      {
        id: 42,
        activityDescription: '邀请好友赚积分',
        linkUrl: 'https://lobsterai.youdao.com/invitation',
        imageUrl: 'https://nos.example.com/banner.png',
        updatedAt: '2026-07-03T10:00:00',
      },
    ]);
    const addedVersion = getSidebarBannerStorageKey([
      {
        id: 42,
        activityDescription: '邀请好友赚积分',
        linkUrl: 'https://lobsterai.youdao.com/invitation',
        imageUrl: 'https://nos.example.com/banner.png',
        updatedAt: '2026-07-02T10:00:00',
      },
      {
        id: 43,
        activityDescription: '新活动',
        linkUrl: 'https://lobsterai.youdao.com/activity',
        imageUrl: 'https://nos.example.com/banner-2.png',
        updatedAt: '2026-07-03T10:00:00',
      },
    ]);

    expect(updatedVersion).not.toBe(firstVersion);
    expect(addedVersion).not.toBe(firstVersion);
  });

  test('shows by default and hides permanently after manual close', () => {
    expect(shouldShowSidebarBanner(null)).toBe(true);
    expect(shouldShowSidebarBanner({ closedAt: 1_788_000_000_000 })).toBe(false);
  });

  test('persists manual close state through the sqlite-backed kv store', async () => {
    await saveSidebarBannerDismissState('client_sidebar_banner.42.v1', 1_788_000_000_000);

    expect(storeMock.setItem).toHaveBeenCalledWith(
      'client_sidebar_banner.42.v1',
      { closedAt: 1_788_000_000_000 }
    );
  });

  test('reads manual close state from the sqlite-backed kv store', async () => {
    storeMock.getItem.mockResolvedValue({ closedAt: 1_788_000_000_000 });

    await expect(readSidebarBannerDismissState('client_sidebar_banner.42.v1'))
      .resolves.toEqual({ closedAt: 1_788_000_000_000 });
  });
});
