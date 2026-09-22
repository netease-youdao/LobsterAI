import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteInputReason } from '../../shared/remote/input';
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
    change: (patch: Partial<LocalRemoteModel>) => { models = [{ ...models[0], ...patch }]; }, remove: () => { models = []; } };
}
describe('remote model references', () => {
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
    await expect(catalog.publish(owner, 'pc', '2', api, () => true)).resolves.toBeUndefined();
  });
});
