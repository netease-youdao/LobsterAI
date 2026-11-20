import type { AccountMenuMoreState } from '@shared/accountMenuMore/constants';
import { describe, expect, test, vi } from 'vitest';

import { AccountMenuMoreStore, getAccountMenuMoreNodes } from './accountMenuMore';

const menu: AccountMenuMoreState = {
  items: [
    {
      kind: 'link',
      key: 'billing',
      label: '账单与发票',
      labelEn: 'Billing & invoices',
      url: 'https://lobsterai.youdao.com/portal#/subscription',
    },
    {
      kind: 'link',
      key: 'redemption',
      label: '兑换中心',
      labelEn: '',
      url: 'https://lobsterai.youdao.com/portal#/profile/redemption',
    },
  ],
};

describe('getAccountMenuMoreNodes', () => {
  test('returns no entries without a configured menu', () => {
    expect(getAccountMenuMoreNodes(null, false)).toEqual([]);
  });

  test('uses Chinese labels by default', () => {
    expect(getAccountMenuMoreNodes(menu, false).map(node => node.label)).toEqual(['账单与发票', '兑换中心']);
  });

  test('prefers English labels and falls back to Chinese when one is missing', () => {
    expect(getAccountMenuMoreNodes(menu, true).map(node => node.label)).toEqual(['Billing & invoices', '兑换中心']);
  });

  test('localizes groups and prefixes their link keys so analytics can tell them apart', () => {
    const nodes = getAccountMenuMoreNodes({
      items: [{
        kind: 'group',
        key: 'legal',
        label: '法律条款',
        labelEn: 'Legal',
        children: [{ kind: 'link', key: 'privacy', label: '隐私政策', labelEn: 'Privacy policy', url: 'https://a.example' }],
      }],
    }, true);
    expect(nodes).toEqual([{
      kind: 'group',
      key: 'legal',
      label: 'Legal',
      links: [{ kind: 'link', key: 'legal.privacy', label: 'Privacy policy', url: 'https://a.example' }],
    }]);
  });
});

describe('AccountMenuMoreStore', () => {
  test('shares one lookup between concurrent loads and caches the result', async () => {
    const loader = vi.fn(async () => menu);
    const store = new AccountMenuMoreStore(loader);
    const [first, second] = await Promise.all([store.load(), store.load()]);
    expect(first).toBe(menu);
    expect(second).toBe(menu);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(store.getCached()).toBe(menu);
    expect(store.hasLoaded()).toBe(true);
  });

  test('every open refreshes, so links removed by ops disappear', async () => {
    const loader = vi.fn<() => Promise<AccountMenuMoreState | null>>()
      .mockResolvedValueOnce(menu)
      .mockResolvedValueOnce(null);
    const store = new AccountMenuMoreStore(loader);
    await store.load();
    expect(await store.load()).toBeNull();
    expect(store.getCached()).toBeNull();
  });

  test('prefetch only warms the first open', async () => {
    const loader = vi.fn(async () => menu);
    const store = new AccountMenuMoreStore(loader);
    store.prefetch();
    store.prefetch();
    await store.load();
    store.prefetch();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  test('a failing bridge leaves the submenu empty instead of throwing', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const store = new AccountMenuMoreStore(async () => {
      throw new Error('bridge missing');
    });
    expect(store.hasLoaded()).toBe(false);
    expect(await store.load()).toBeNull();
    expect(store.hasLoaded()).toBe(true);
  });
});
