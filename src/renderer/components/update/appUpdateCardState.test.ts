import { beforeEach, describe, expect, test, vi } from 'vitest';

const storeMock = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
}));

vi.mock('../../services/store', () => ({
  localStore: storeMock,
}));

import {
  APP_UPDATE_CARD_COLLAPSE_KEY,
  clearUpdateCardCollapsedVersion,
  readUpdateCardCollapsedVersion,
  saveUpdateCardCollapsedVersion,
  shouldExpandUpdateCard,
} from './appUpdateCardState';

describe('app update card collapse state', () => {
  beforeEach(() => {
    storeMock.getItem.mockReset();
    storeMock.setItem.mockReset();
    storeMock.removeItem.mockReset();
  });

  test('expands by default when nothing was collapsed', () => {
    expect(shouldExpandUpdateCard(null, '2026.7.9')).toBe(true);
  });

  test('stays collapsed only for the version the user collapsed', () => {
    expect(shouldExpandUpdateCard('2026.7.9', '2026.7.9')).toBe(false);
  });

  test('re-expands automatically when a newer version arrives', () => {
    expect(shouldExpandUpdateCard('2026.7.9', '2026.7.10')).toBe(true);
  });

  test('persists the collapsed version through the kv store', async () => {
    await saveUpdateCardCollapsedVersion('2026.7.9');

    expect(storeMock.setItem).toHaveBeenCalledWith(APP_UPDATE_CARD_COLLAPSE_KEY, '2026.7.9');
  });

  test('reads back a stored collapsed version', async () => {
    storeMock.getItem.mockResolvedValue('2026.7.9');

    await expect(readUpdateCardCollapsedVersion()).resolves.toBe('2026.7.9');
  });

  test('treats missing or malformed stored values as not collapsed', async () => {
    storeMock.getItem.mockResolvedValue(null);
    await expect(readUpdateCardCollapsedVersion()).resolves.toBeNull();

    storeMock.getItem.mockResolvedValue({ closedAt: 123 });
    await expect(readUpdateCardCollapsedVersion()).resolves.toBeNull();
  });

  test('clears the collapsed version when the user expands the card', async () => {
    await clearUpdateCardCollapsedVersion();

    expect(storeMock.removeItem).toHaveBeenCalledWith(APP_UPDATE_CARD_COLLAPSE_KEY);
  });
});
