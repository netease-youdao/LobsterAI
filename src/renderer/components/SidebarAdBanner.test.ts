import { beforeEach, describe, expect, test, vi } from 'vitest';

const storeMock = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
}));

vi.mock('../services/store', () => ({
  localStore: storeMock,
}));

import {
  type ClientBanner,
  createSidebarBannerDismissState,
  getLegacySidebarBannerStorageKey,
  getSidebarBannerDismissStateKey,
  readSidebarBannerDismissState,
  saveSidebarBannerDismissState,
  shouldShowSidebarBanners,
} from './sidebarAdBannerState';

const banner = (
  id: number,
  updatedAt: string,
): ClientBanner => ({
  id,
  activityDescription: `Banner ${id}`,
  linkUrl: `https://lobsterai.youdao.com/banner/${id}`,
  imageUrl: `https://nos.example.com/banner-${id}.png`,
  updatedAt,
});

describe('sidebar ad banner state', () => {
  beforeEach(() => {
    storeMock.getItem.mockReset();
    storeMock.setItem.mockReset();
  });

  test('hides the group until a banner is added or updated', () => {
    const first = banner(42, '2026-07-02T10:00:00');
    const second = banner(43, '2026-07-03T10:00:00');
    const dismissed = createSidebarBannerDismissState(
      [first, second],
      null,
      1_788_000_000_000,
    );

    expect(shouldShowSidebarBanners([first, second], dismissed)).toBe(false);
    expect(shouldShowSidebarBanners([first], dismissed)).toBe(false);
    expect(shouldShowSidebarBanners([], dismissed)).toBe(false);
    expect(shouldShowSidebarBanners([
      first,
      second,
      banner(44, '2026-07-04T10:00:00'),
    ], dismissed)).toBe(true);
    expect(shouldShowSidebarBanners([
      banner(42, '2026-07-05T10:00:00'),
      second,
    ], dismissed)).toBe(true);
  });

  test('closing again records every currently active banner version', () => {
    const first = banner(42, '2026-07-02T10:00:00');
    const second = banner(43, '2026-07-03T10:00:00');
    const firstClose = createSidebarBannerDismissState([first], null, 100);
    const secondClose = createSidebarBannerDismissState(
      [first, second],
      firstClose,
      200,
    );

    expect(secondClose).toEqual({
      closedAt: 200,
      dismissedBannerVersions: [
        '42:2026-07-02T10:00:00',
        '43:2026-07-03T10:00:00',
      ],
    });
  });

  test('persists the accumulated state under one placement key', async () => {
    const state = createSidebarBannerDismissState([
      banner(42, '2026-07-02T10:00:00'),
    ], null, 1_788_000_000_000);

    await saveSidebarBannerDismissState(state);

    expect(storeMock.setItem).toHaveBeenCalledWith(
      getSidebarBannerDismissStateKey(),
      state,
    );
  });

  test('reads the accumulated close state', async () => {
    const state = {
      closedAt: 1_788_000_000_000,
      dismissedBannerVersions: ['42:2026-07-02T10:00:00'],
    };
    storeMock.getItem.mockResolvedValueOnce(state);

    await expect(readSidebarBannerDismissState([
      banner(42, '2026-07-02T10:00:00'),
    ])).resolves.toEqual(state);
  });

  test('migrates the legacy whole-list close key without reopening', async () => {
    const banners = [
      banner(42, '2026-07-02T10:00:00'),
      banner(43, '2026-07-03T10:00:00'),
    ];
    storeMock.getItem.mockImplementation((key: string) => {
      if (key === getLegacySidebarBannerStorageKey(banners)) {
        return Promise.resolve({ closedAt: 1_788_000_000_000 });
      }
      return Promise.resolve(null);
    });

    const state = await readSidebarBannerDismissState(banners);

    expect(state).toEqual({
      closedAt: 1_788_000_000_000,
      dismissedBannerVersions: [
        '42:2026-07-02T10:00:00',
        '43:2026-07-03T10:00:00',
      ],
    });
    expect(storeMock.setItem).toHaveBeenCalledWith(
      getSidebarBannerDismissStateKey(),
      state,
    );
  });
});
