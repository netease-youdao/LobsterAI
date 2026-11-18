import { describe, expect, test } from 'vitest';

import {
  COMPANION_TOOLBAR_VISIBLE_COUNT,
  CompanionToolbarItem as Item,
  companionToolbarItems,
  DEFAULT_COMPANION_TOOLBAR_ORDER,
  normalizeCompanionToolbarOrder,
} from './selectionToolbar';

describe('selection toolbar order', () => {
  test('older preferences get all actions without mutating defaults', () => {
    const order = normalizeCompanionToolbarOrder(undefined);
    expect(order).toEqual(DEFAULT_COMPANION_TOOLBAR_ORDER);
    order.reverse();
    expect(normalizeCompanionToolbarOrder(null)[0]).toBe(Item.Translate);
  });

  test('repairs duplicate, unknown and missing actions while retaining the user order', () => {
    const order = normalizeCompanionToolbarOrder([Item.Ask, 'removed-action', Item.Copy, Item.Ask, null]);
    expect(order.slice(0, 2)).toEqual([Item.Ask, Item.Copy]);
    expect(new Set(order).size).toBe(DEFAULT_COMPANION_TOOLBAR_ORDER.length);
    expect(order).toEqual(expect.arrayContaining([...DEFAULT_COMPANION_TOOLBAR_ORDER]));
  });

  test('any action can move between the toolbar and the overflow menu', () => {
    const order = [...DEFAULT_COMPANION_TOOLBAR_ORDER].reverse();
    const { visible, overflow } = companionToolbarItems(order);
    expect(visible).toHaveLength(COMPANION_TOOLBAR_VISIBLE_COUNT);
    expect(visible[0]).toBe(Item.Ask);
    expect(overflow).toEqual([Item.Copy, Item.Translate]);
    expect([...visible, ...overflow]).toEqual(order);
  });

  test('removes polish from saved orders while preserving the remaining actions', () => {
    const saved = [Item.Polish, Item.Ask, Item.Copy, Item.Translate, Item.ReadAloud, Item.Summarize, Item.Explain];
    const expected = [Item.Ask, Item.Copy, Item.Translate, Item.ReadAloud, Item.Summarize, Item.Explain];
    expect(normalizeCompanionToolbarOrder(saved)).toEqual(expected);
    expect(saved[0]).toBe(Item.Polish);

    const { visible, overflow } = companionToolbarItems(saved);
    expect(visible).toEqual(expected.slice(0, COMPANION_TOOLBAR_VISIBLE_COUNT));
    expect(overflow).toEqual([Item.Summarize, Item.Explain]);
  });
});
