import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteInputReason, type RemoteModelItem, RemoteModelMetadata } from '../../shared/remote/input';
import { type LocalRemoteModel, RemoteModelCatalog } from './remoteModelCatalog';
import type { RemoteStore } from './remoteStore';

const Target = { First: 'space-a-generation-7', Second: 'space-b-generation-4' } as const;
const owner = { userId: 'A', scopeKey: 'personal' };
afterEach(() => vi.restoreAllMocks());
function fixture(getTargetId?: () => string | null) {
  const values = new Map<string, unknown>();
  const store = { get: <T>(key: string): T | null => values.get(key) as T ?? null,
    put: (key: string, value: unknown) => values.set(key, structuredClone(value)) };
  let models: LocalRemoteModel[] = [{ identity: 'provider/model', runtimeRef: 'custom/model', source: 'custom', displayName: 'Chat model',
    providerLabel: 'Custom', available: true, image: true, toolCalling: true, thinking: { options: ['low', 'high'], default: 'low' },
    configuration: { apiKey: 'secret-one', baseURL: 'http://private.local/v1' } }];
  return { values, catalog: new RemoteModelCatalog(store as Pick<RemoteStore, 'get' | 'put'>, () => models, getTargetId),
    change: (patch: Partial<LocalRemoteModel>) => { models = [{ ...models[0], ...patch }]; },
    replace: (next: LocalRemoteModel[]) => { models = next; }, remove: () => { models = []; } };
}
describe('remote model references', () => {
  it('publishes model reordering promptly without changing model references or versions', async () => {
    const { catalog, replace } = fixture();
    const base = catalog.resolve(owner, 'pc', catalog.refresh(owner, 'pc')[0].modelRef).local;
    replace([base, { ...base, identity: 'provider/second', runtimeRef: 'custom/second', displayName: 'Second' }]);
    const initial = catalog.refresh(owner, 'pc');
    const locals = initial.map(item => catalog.resolve(owner, 'pc', item.modelRef, item.version).local);
    const original = [...initial].sort((a, b) => a.modelRef.localeCompare(b.modelRef));
    replace(original.map(item => locals.find(local => local.displayName === item.displayName)!));
    const reordered = [...original].reverse();
    let savedItems = original;
    let version = '1';
    const api = vi.fn(async (_path: string, method?: string, body?: { items: typeof original }) => {
      if (method === 'POST') {
        savedItems = body!.items;
        version = String(Number(version) + 1);
      }
      return { catalogVersion: version, items: savedItems };
    });
    await catalog.publish(owner, 'pc', '1', api, () => true);
    expect(api).toHaveBeenCalledTimes(1);

    // Force the display order to disagree with UUID ordering, without depending on random UUIDs.
    replace(reordered.map(item => locals.find(local => local.displayName === item.displayName)!));
    expect(catalog.refresh(owner, 'pc')).toEqual(reordered);
    await catalog.publish(owner, 'pc', '1', api, () => true);
    expect(savedItems).toEqual(reordered);
    expect(api.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(1);
    for (const item of original) {
      expect(catalog.resolve(owner, 'pc', item.modelRef, item.version).item).toEqual(item);
    }
    await catalog.publish(owner, 'pc', '1', api, () => true);
    expect(api).toHaveBeenCalledTimes(3);
  });

  it('finishes a pending legacy UUID-ordered publication before publishing the desktop order', async () => {
    const { catalog, replace, values } = fixture();
    const base = catalog.resolve(owner, 'pc', catalog.refresh(owner, 'pc')[0].modelRef).local;
    replace([base, { ...base, identity: 'provider/second', runtimeRef: 'custom/second', displayName: 'Second' }]);
    const initial = catalog.refresh(owner, 'pc');
    const locals = initial.map(item => catalog.resolve(owner, 'pc', item.modelRef, item.version).local);
    const legacyItems = [...initial].sort((a, b) => a.modelRef.localeCompare(b.modelRef));
    const desktopItems = [...legacyItems].reverse();
    replace(desktopItems.map(item => locals.find(local => local.displayName === item.displayName)!));
    const pending = { publicationId: 'legacy-publication', expectedCatalogVersion: '0', items: legacyItems };
    const [key, state] = [...values.entries()][0];
    values.set(key, { ...(state as object), pending });
    let savedItems: typeof initial = [];
    let version = '0';
    const api = vi.fn(async (_path: string, method?: string, body?: typeof pending) => {
      if (method === 'POST') {
        savedItems = body!.items;
        version = String(Number(version) + 1);
      }
      return { catalogVersion: version, items: savedItems };
    });

    await expect(catalog.publish(owner, 'pc', '1', api, () => true)).resolves.toBe(false);
    expect(api.mock.calls.find(([, method]) => method === 'POST')?.[2]).toMatchObject(pending);
    expect(savedItems).toEqual(legacyItems);
    await expect(catalog.publish(owner, 'pc', '1', api, () => true)).resolves.toBe(true);
    expect(savedItems).toEqual(desktopItems);
    const publications = api.mock.calls.filter(([, method]) => method === 'POST');
    expect(publications).toHaveLength(2);
    expect(publications[1][2]?.publicationId).not.toBe(pending.publicationId);
    expect(publications[1][2]?.expectedCatalogVersion).toBe('1');
  });
  it('does not create references before a target is known', async () => {
    const { catalog, values } = fixture(() => null);
    expect(() => catalog.refresh(owner, 'pc')).toThrow(RemoteInputReason.Stale);
    const api = vi.fn();
    await expect(catalog.publish(owner, 'pc', '1', api, () => true)).rejects.toThrow(RemoteInputReason.Stale);
    expect(api).not.toHaveBeenCalled();
    expect(values.size).toBe(0);
  });
  it('keeps target-specific references when account and device IDs match', () => {
    let targetId: string | null = Target.First;
    const { catalog } = fixture(() => targetId);
    const first = catalog.refresh(owner, 'pc')[0];
    targetId = Target.Second;
    expect(() => catalog.resolve(owner, 'pc', first.modelRef)).toThrow(RemoteInputReason.ModelUnavailable);
    const second = catalog.refresh(owner, 'pc')[0];
    expect(second.modelRef).not.toBe(first.modelRef);
    targetId = Target.First;
    expect(catalog.resolve(owner, 'pc', first.modelRef).item).toEqual(first);
  });
  it('discards a catalog response received after the target changes', async () => {
    let targetId: string | null = Target.First;
    const { catalog, values } = fixture(() => targetId);
    const items = catalog.refresh(owner, 'pc');
    let finish!: (value: { catalogVersion: string; items: typeof items }) => void;
    const pending = catalog.publish(owner, 'pc', '1', () => new Promise(resolve => { finish = resolve; }), () => true);
    targetId = Target.Second;
    finish({ catalogVersion: '9', items });
    await expect(pending).rejects.toThrow(RemoteInputReason.Account);
    expect([...values.values()]).not.toContainEqual(expect.objectContaining({ catalogVersion: '9' }));
  });
  it('caches only the catalog actually published when an old immutable publication is pending', async () => {
    const { catalog, change } = fixture();
    let items: any[] = []; let version = '0';
    const api = vi.fn(async (_path: string, method?: string, body?: any) => {
      if (method === 'POST') {
        items = body.items; version = String(Number(version) + 1);
      }
      return { catalogVersion: version, items };
    });
    api.mockImplementationOnce(async () => ({ catalogVersion: '0', items: [] }));
    api.mockImplementationOnce(async () => { throw new Error('request not received'); });
    await expect(catalog.publish(owner, 'pc', '1', api, () => true)).rejects.toThrow('request not received');
    change({ displayName: 'Changed while pending' });
    await catalog.publish(owner, 'pc', '2', api, () => true);
    expect(items[0].displayName).toBe('Chat model');
    await catalog.publish(owner, 'pc', '2', api, () => true);
    expect(items[0].displayName).toBe('Changed while pending');
  });
  it('does not accept an old response after publication state is reset', async () => {
    const { catalog } = fixture(() => Target.First); const items = catalog.refresh(owner, 'pc');
    let finish: (value: { catalogVersion: string; items: typeof items }) => void = () => {};
    const api = vi.fn(async () => ({ catalogVersion: '1', items }));
    api.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = catalog.publish(owner, 'pc', '1', api, () => true);
    catalog.resetPublication();
    finish({ catalogVersion: '1', items });
    await expect(pending).rejects.toThrow(RemoteInputReason.Account);
    expect(catalog.refresh(owner, 'pc')).toEqual(items);
    await catalog.publish(owner, 'pc', '1', api, () => true);
    expect(api).toHaveBeenCalledTimes(2);
  });
  it('checks unchanged catalogs remotely only every five minutes but publishes local changes promptly', async () => {
    const { catalog, change } = fixture();
    let now = 1000000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const api = vi.fn(async () => ({ catalogVersion: '1', items: catalog.refresh(owner, 'pc') }));
    await catalog.publish(owner, 'pc', '1', api, () => true);
    for (let i = 0; i < 19; i++) { now += 15000; await catalog.publish(owner, 'pc', '1', api, () => true); }
    expect(api).toHaveBeenCalledTimes(1);
    now += 15000; await catalog.publish(owner, 'pc', '1', api, () => true);
    expect(api).toHaveBeenCalledTimes(2);
    change({ displayName: 'Updated' }); await catalog.publish(owner, 'pc', '1', api, () => true);
    expect(api).toHaveBeenCalledTimes(3);
  });
  it('refreshes on a new connection and backs off failed catalog requests', async () => {
    const { catalog } = fixture();
    let now = 1000000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const api = vi.fn(async () => ({ catalogVersion: '1', items: catalog.refresh(owner, 'pc') }));
    api.mockRejectedValueOnce(new Error('offline'));
    await expect(catalog.publish(owner, 'pc', '1', api, () => true)).rejects.toThrow('offline');
    for (let i = 0; i < 3; i++) { now += 15000; await catalog.publish(owner, 'pc', '1', api, () => true); }
    expect(api).toHaveBeenCalledTimes(1);
    now += 15000; await catalog.publish(owner, 'pc', '1', api, () => true);
    expect(api).toHaveBeenCalledTimes(2);
    await catalog.publish(owner, 'pc', '2', api, () => true);
    expect(api).toHaveBeenCalledTimes(3);
    catalog.resetPublication(); await catalog.publish(owner, 'pc', '2', api, () => true);
    expect(api).toHaveBeenCalledTimes(4);
  });
  it('keeps selectable models usable without asserting tool-calling support', () => {
    const { catalog, change } = fixture();
    change({ toolCalling: false });
    const item = catalog.refresh(owner, 'pc')[0];
    expect(item).toMatchObject({ available: true, unavailableReason: null, inputCapabilities: { toolCalling: false } });
    expect(catalog.resolve(owner, 'pc', item.modelRef, item.version).item).toEqual(item);
  });
  it('limits public labels to server UTF-16 units without splitting emoji', () => {
    const { catalog, change } = fixture();
    change({ displayName: 'x' + '🦞'.repeat(100), providerLabel: '🦞'.repeat(100) });
    const item = catalog.refresh(owner, 'pc')[0];
    expect(item.displayName).toHaveLength(119);
    expect(item.providerLabel).toHaveLength(120);
    expect(item.displayName.endsWith('🦞')).toBe(true);
  });
  it('round-trips server-normalized null thinking defaults without repeating publication', async () => {
    const { catalog, change } = fixture();
    change({ displayName: 'x'.repeat(150), thinking: { options: [] } });
    const items = catalog.refresh(owner, 'pc');
    expect(items[0].displayName).toHaveLength(120);
    expect(items[0].thinking).toEqual({ options: [], default: null });
    let writes = 0;
    await catalog.publish(owner, 'pc', '1', async (_path, method) => {
      if (method === 'POST') writes++;
      return { catalogVersion: '1', items };
    }, () => true);
    expect(writes).toBe(0);
  });
  it('publishes safe opaque references and keeps credentials and addresses local', () => {
    const { catalog } = fixture();
    const items = catalog.refresh(owner, 'pc');
    expect(items[0].modelRef).toMatch(/^[0-9a-f-]{36}$/u);
    expect(JSON.stringify(items)).not.toMatch(/secret-one|private.local|apiKey|baseURL|runtimeRef/u);
    expect(catalog.resolve(owner, 'pc', items[0].modelRef, '1').local.runtimeRef).toBe('custom/model');
  });
  it('isolates account, space and target device without guessing same-name models', () => {
    const { catalog } = fixture(); const item = catalog.refresh(owner, 'pc')[0];
    for (const [actor, device] of [[{ userId: 'B', scopeKey: 'personal' }, 'pc'], [{ ...owner, scopeKey: 'team' }, 'pc'], [owner, 'other']] as const) {
      expect(() => catalog.resolve(actor, device, item.modelRef)).toThrow(RemoteInputReason.ModelUnavailable);
    }
    expect(() => catalog.resolveRuntime(owner, 'pc', 'other/model')).toThrow(RemoteInputReason.ModelUnavailable);
  });
  it('invalidates exact versions on secret rotation and capability changes', () => {
    const { catalog, change } = fixture(); const item = catalog.refresh(owner, 'pc')[0];
    change({ configuration: { apiKey: 'secret-two' } });
    expect(catalog.refresh(owner, 'pc')[0]).toMatchObject({ modelRef: item.modelRef, version: '2' });
    expect(() => catalog.resolve(owner, 'pc', item.modelRef, '1')).toThrow(RemoteInputReason.ModelChanged);
    change({ image: false }); expect(catalog.refresh(owner, 'pc')[0].version).toBe('3');
  });
  it('never reuses deleted references or replaces an unavailable model', () => {
    const { catalog, change, remove } = fixture(); const item = catalog.refresh(owner, 'pc')[0];
    remove(); catalog.refresh(owner, 'pc');
    change({ identity: 'provider/model', runtimeRef: 'custom/model', source: 'custom', displayName: 'New', providerLabel: 'Custom',
      available: true, image: false, toolCalling: true, thinking: { options: [] }, configuration: {} });
    expect(catalog.refresh(owner, 'pc')[0].modelRef).not.toBe(item.modelRef);
    expect(() => catalog.resolve(owner, 'pc', item.modelRef)).toThrow(RemoteInputReason.ModelUnavailable);
    change({ available: false }); expect(catalog.refresh(owner, 'pc')[0].available).toBe(false);
  });
  it('recovers a lost publication response using the same immutable receipt', async () => {
    const { catalog } = fixture(); let published: any = null;
    const api = async (_path: string, method?: string, body?: any) => {
      if (method === 'POST') { published = body; throw new Error('response lost'); }
      return published ? { catalogVersion: '1', lastPublicationId: published.publicationId, items: published.items } : { catalogVersion: '0', items: [] };
    };
    await expect(catalog.publish(owner, 'pc', '1', api, () => true)).rejects.toThrow('response lost');
    await expect(catalog.publish(owner, 'pc', '2', api, () => true)).resolves.toBe(true);
  });
});

it('confirms only the current remotely checked digest and returns false during an unconfirmed retry', async () => {
  const { catalog, change } = fixture(); const api = vi.fn(async () => { throw new Error('offline'); });
  await expect(catalog.publish(owner, 'pc', '1', api, () => true)).rejects.toThrow('offline');
  await expect(catalog.publish(owner, 'pc', '1', api, () => true)).resolves.toBe(false);
  expect(api).toHaveBeenCalledOnce();
  catalog.resetPublication();
  const items = catalog.refresh(owner, 'pc'), confirmed = vi.fn(async () => ({ catalogVersion: '1', items }));
  await expect(catalog.publish(owner, 'pc', '1', confirmed, () => true)).resolves.toBe(true);
  await expect(catalog.publish(owner, 'pc', '1', confirmed, () => true)).resolves.toBe(true);
  expect(confirmed).toHaveBeenCalledOnce();
  change({ configuration: { revision: 2 } });
  await expect(catalog.publish(owner, 'pc', '1', api, () => true)).rejects.toThrow('offline');
  await expect(catalog.publish(owner, 'pc', '1', api, () => true)).resolves.toBe(false);
});
it('does not confirm a new local catalog changed while the old publication was in flight', async () => {
  const { catalog, change } = fixture();
  const api = vi.fn(async (_path: string, method?: string) => {
    if (method === 'POST') { change({ configuration: { revision: 2 } }); return { catalogVersion: '1' }; }
    return { catalogVersion: '0', items: [] };
  });
  await expect(catalog.publish(owner, 'pc', '1', api, () => true)).resolves.toBe(false);
  expect(api).toHaveBeenCalledTimes(2);
});


describe('remote model display IDs', () => {
  function serverFixture() {
    let supported = false;
    let catalogVersion = '0';
    let lastPublicationId: string | undefined;
    let items: RemoteModelItem[] = [];
    const publications: Array<{ publicationId: string; expectedCatalogVersion: string; items: RemoteModelItem[] }> = [];
    const api = vi.fn(async (_path: string, method?: string, body?: typeof publications[number]) => {
      if (method === 'POST') {
        expect(body!.expectedCatalogVersion).toBe(catalogVersion);
        for (const item of body!.items) {
          if (!supported) expect(item).not.toHaveProperty('modelId');
          const previous = items.find(value => value.modelRef === item.modelRef);
          if (previous && JSON.stringify(previous) !== JSON.stringify(item)) {
            expect(BigInt(item.version)).toBeGreaterThan(BigInt(previous.version));
          }
        }
        publications.push(structuredClone(body!));
        items = structuredClone(body!.items);
        catalogVersion = String(BigInt(catalogVersion) + 1n);
        lastPublicationId = body!.publicationId;
      }
      return { catalogVersion, lastPublicationId, items: structuredClone(items),
        ...(supported ? { capabilities: [RemoteModelMetadata.DisplayId] } : {}) };
    });
    return { api, publications, support: (value: boolean) => { supported = value; } };
  }

  it('keeps legacy fingerprints and omits display IDs until the server advertises support', async () => {
    const { catalog, change } = fixture();
    const legacy = catalog.refresh(owner, 'pc')[0];
    change({ modelId: 'deepseek-flash-YoudaoInner' });
    const server = serverFixture();
    await expect(catalog.publish(owner, 'pc', '1', server.api, () => true)).resolves.toBe(true);
    expect(server.publications[0].items[0]).toEqual(legacy);
    expect(catalog.resolve(owner, 'pc', legacy.modelRef, legacy.version).local.modelId).toBe('deepseek-flash-YoudaoInner');
  });

  it.each(['deepseek-flash-YoudaoInner', 'vendor/model-v1:free@channel+plan', 'yd-fast', 'yd-ultra', 'a'.repeat(200)])(
    'publishes the exact safe public ID %s', async modelId => {
      const { catalog, change } = fixture();
      change({ modelId });
      const server = serverFixture(); server.support(true);
      await catalog.publish(owner, 'pc', '1', server.api, () => true);
      expect(server.publications[0].items[0].modelId).toBe(modelId);
      expect(JSON.stringify(server.publications[0].items)).not.toMatch(/secret-one|private.local|apiKey|baseURL|runtimeRef/u);
    });

  it.each(['', ' model ', 'a'.repeat(201), '模型', '/model', 'model?token=secret', 'model#secret',
    'https://private.example/model', 'file://private/model', 'localHOST-model', 'model-192.168.1.1',
    'sk-private-key', 'model-SK-private-key', 'model\n', 'model\u0000', 'model\\path'])
  ('omits unsafe display IDs without preventing model publication: %j', async modelId => {
    const { catalog, change } = fixture(); change({ modelId });
    const server = serverFixture(); server.support(true);
    await expect(catalog.publish(owner, 'pc', '1', server.api, () => true)).resolves.toBe(true);
    const item = server.publications[0].items[0];
    expect(item).not.toHaveProperty('modelId');
    expect(catalog.resolve(owner, 'pc', item.modelRef, item.version).local.modelId).toBe(modelId);
  });

  it('increments item versions on upgrade and downgrade while preserving references and execution identity', async () => {
    const { catalog, change } = fixture(); change({ modelId: 'deepseek-flash' });
    const server = serverFixture();
    for (const [index, supported] of [false, true, false, true].entries()) {
      server.support(supported);
      await expect(catalog.publish(owner, 'pc', String(index + 1), server.api, () => true)).resolves.toBe(true);
      const item = server.publications[index].items[0];
      expect(item.version).toBe(String(index + 1));
      expect(item.modelRef).toBe(server.publications[0].items[0].modelRef);
      if (supported) expect(item.modelId).toBe('deepseek-flash');
      else expect(item).not.toHaveProperty('modelId');
      expect(catalog.resolve(owner, 'pc', item.modelRef, item.version).local.runtimeRef).toBe('custom/model');
    }
    expect(() => catalog.resolve(owner, 'pc', server.publications[0].items[0].modelRef, '1')).toThrow(RemoteInputReason.ModelChanged);
  });

  it('discovers a server capability upgrade during the normal reconciliation interval', async () => {
    const { catalog, change } = fixture(); change({ modelId: 'deepseek-flash' });
    let now = 1000000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const server = serverFixture();
    await catalog.publish(owner, 'pc', '1', server.api, () => true);
    server.support(true); now += 299999;
    await catalog.publish(owner, 'pc', '1', server.api, () => true);
    expect(server.publications).toHaveLength(1);
    now++;
    await catalog.publish(owner, 'pc', '1', server.api, () => true);
    expect(server.publications[1].items[0]).toMatchObject({ modelId: 'deepseek-flash', version: '2' });
  });

  it('increments the same reference when its public display ID changes', async () => {
    const { catalog, change } = fixture(); change({ modelId: 'deepseek-flash' });
    const server = serverFixture(); server.support(true);
    await catalog.publish(owner, 'pc', '1', server.api, () => true);
    const original = server.publications[0].items[0];
    change({ modelId: 'deepseek-flash-YoudaoInner' });
    await catalog.publish(owner, 'pc', '1', server.api, () => true);
    expect(server.publications[1].items[0]).toMatchObject({ modelRef: original.modelRef, version: '3', modelId: 'deepseek-flash-YoudaoInner' });
  });

  it('replays an immutable legacy pending publication before publishing IDs after an upgrade', async () => {
    const { catalog, change } = fixture(); change({ modelId: 'deepseek-flash' });
    const server = serverFixture();
    let pending: any;
    const firstApi = async (path: string, method?: string, body?: any) => {
      if (method === 'POST') { pending = structuredClone(body); throw new Error('not received'); }
      return server.api(path, method, body);
    };
    await expect(catalog.publish(owner, 'pc', '1', firstApi, () => true)).rejects.toThrow('not received');
    server.support(true);
    await expect(catalog.publish(owner, 'pc', '2', server.api, () => true)).resolves.toBe(false);
    expect(server.publications[0]).toEqual({ ...pending, connectionGeneration: '2' });
    expect(server.publications[0].items[0]).not.toHaveProperty('modelId');
    await expect(catalog.publish(owner, 'pc', '2', server.api, () => true)).resolves.toBe(true);
    expect(server.publications[1]).toMatchObject({ expectedCatalogVersion: '1', items: [{ modelId: 'deepseek-flash', version: '2' }] });
    expect(server.publications[1].publicationId).not.toBe(pending.publicationId);
  });

  it.each([false, true])('creates a new compatible receipt after downgrade when pending was accepted=%s', async accepted => {
    const { catalog, change } = fixture(); change({ modelId: 'deepseek-flash' });
    const server = serverFixture(); server.support(true);
    let pending: any;
    const firstApi = async (path: string, method?: string, body?: any) => {
      if (method === 'POST') {
        pending = structuredClone(body);
        if (accepted) await server.api(path, method, body);
        throw new Error('response lost');
      }
      return server.api(path, method, body);
    };
    await expect(catalog.publish(owner, 'pc', '1', firstApi, () => true)).rejects.toThrow('response lost');
    const original = structuredClone(pending);
    server.support(false);
    await expect(catalog.publish(owner, 'pc', '2', server.api, () => true)).resolves.toBe(true);
    const replacement = server.publications.at(-1)!;
    expect(replacement.publicationId).not.toBe(pending.publicationId);
    expect(replacement.expectedCatalogVersion).toBe(accepted ? '1' : '0');
    expect(replacement.items[0]).toMatchObject({ modelRef: pending.items[0].modelRef, version: '3' });
    expect(replacement.items[0]).not.toHaveProperty('modelId');
    expect(pending).toEqual(original);
  });

  it('retries an unaccepted enriched publication without mutating its receipt', async () => {
    const { catalog, change } = fixture(); change({ modelId: 'deepseek-flash' });
    const server = serverFixture(); server.support(true);
    let pending: any;
    const firstApi = async (path: string, method?: string, body?: any) => {
      if (method === 'POST') { pending = structuredClone(body); throw new Error('not received'); }
      return server.api(path, method, body);
    };
    await expect(catalog.publish(owner, 'pc', '1', firstApi, () => true)).rejects.toThrow('not received');
    await expect(catalog.publish(owner, 'pc', '2', server.api, () => true)).resolves.toBe(true);
    expect(server.publications[0]).toEqual({ ...pending, connectionGeneration: '2' });
  });

  it('uses a new legacy publication after an explicit old-node rejection and suppresses advertised support for five minutes', async () => {
    const { catalog, change } = fixture(); change({ modelId: 'deepseek-flash' });
    let now = 1000000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const server = serverFixture(); server.support(true);
    let oldPostNode = true;
    let rejected: any;
    const api = vi.fn(async (path: string, method?: string, body?: any) => {
      if (method === 'POST' && oldPostNode && body.items.some((item: RemoteModelItem) => item.modelId)) {
        rejected = structuredClone(body);
        throw Object.assign(new Error('Unknown request field'), { code: 47019, httpStatus: 400 });
      }
      return server.api(path, method, body);
    });
    await expect(catalog.publish(owner, 'pc', '1', api, () => true)).resolves.toBe(false);
    await expect(catalog.publish(owner, 'pc', '1', api, () => true)).resolves.toBe(true);
    const legacy = server.publications[0];
    expect(legacy.publicationId).not.toBe(rejected.publicationId);
    expect(legacy.expectedCatalogVersion).toBe('0');
    expect(legacy.items[0]).toMatchObject({ modelRef: rejected.items[0].modelRef, version: '3' });
    expect(legacy.items[0]).not.toHaveProperty('modelId');
    now += 299999;
    // A reconnect fetches the advertising node again but must retain the downgrade window.
    await expect(catalog.publish(owner, 'pc', '2', api, () => true)).resolves.toBe(true);
    expect(server.publications).toHaveLength(1);
    oldPostNode = false; now += 300000;
    await expect(catalog.publish(owner, 'pc', '2', api, () => true)).resolves.toBe(true);
    expect(server.publications[1].items[0]).toMatchObject({ modelRef: legacy.items[0].modelRef, modelId: 'deepseek-flash', version: '4' });
  });

  it.each([
    Object.assign(new Error('Invalid model display ID'), { code: 47019, httpStatus: 400 }),
    Object.assign(new Error('Unknown request field'), { code: 401, httpStatus: 401 }),
    Object.assign(new Error('Unknown request field'), { code: 47019, httpStatus: 500 }),
    Object.assign(new Error('catalog changed'), { code: 47041, httpStatus: 409 }),
    new Error('network timeout'),
  ])('retains the immutable pending receipt for every non-negotiation failure: %s', async failure => {
    const { catalog, change, values } = fixture(); change({ modelId: 'deepseek-flash' });
    const server = serverFixture(); server.support(true);
    let sent: any;
    const api = async (path: string, method?: string, body?: any) => {
      if (method === 'POST') { sent = structuredClone(body); throw failure; }
      return server.api(path, method, body);
    };
    await expect(catalog.publish(owner, 'pc', '1', api, () => true)).rejects.toBe(failure);
    const state = [...values.values()][0] as Record<string, unknown>;
    expect(state.pending).toEqual({ publicationId: sent.publicationId, expectedCatalogVersion: sent.expectedCatalogVersion, items: sent.items });
    expect(state.modelDisplayId).toBe(true);
    expect(state).not.toHaveProperty('modelDisplayIdRetryAt');
  });

  it('does not downgrade another target after a delayed rejection from the previous target', async () => {
    let targetId = Target.First as string;
    const { catalog, change, values } = fixture(() => targetId); change({ modelId: 'deepseek-flash' });
    const server = serverFixture(); server.support(true);
    const api = async (path: string, method?: string, body?: any) => {
      if (method === 'POST') {
        targetId = Target.Second;
        throw Object.assign(new Error('Unknown request field'), { code: 47019, httpStatus: 400 });
      }
      return server.api(path, method, body);
    };
    await expect(catalog.publish(owner, 'pc', '1', api, () => true)).rejects.toThrow(RemoteInputReason.Account);
    const state = [...values.values()][0] as Record<string, unknown>;
    expect(state.modelDisplayId).toBe(true);
    expect(state).not.toHaveProperty('modelDisplayIdRetryAt');
    expect(values.size).toBe(1);
  });

  it('still invalidates versions for credential changes when display IDs are omitted', async () => {
    const { catalog, change } = fixture(); change({ modelId: 'https://private.example/model' });
    const server = serverFixture(); server.support(true);
    await catalog.publish(owner, 'pc', '1', server.api, () => true);
    const previous = server.publications[0].items[0];
    change({ configuration: { apiKey: 'rotated-secret', baseURL: 'http://private.local/v1' } });
    await catalog.publish(owner, 'pc', '1', server.api, () => true);
    expect(server.publications[1].items[0]).toMatchObject({ modelRef: previous.modelRef, version: '2' });
    expect(() => catalog.resolve(owner, 'pc', previous.modelRef, previous.version)).toThrow(RemoteInputReason.ModelChanged);
    expect(JSON.stringify(server.publications)).not.toContain('rotated-secret');
  });
});
