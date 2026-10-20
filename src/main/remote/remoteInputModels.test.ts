import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }));
vi.mock('../libs/claudeSettings', async (importOriginal) => ({
  ...await importOriginal<typeof import('../libs/claudeSettings')>(),
  resolveAllEnabledProviderConfigs: vi.fn(() => []),
  listProviderSourceEntries: vi.fn(() => []),
}));
vi.mock('../libs/openclawConfigSync', () => ({
  buildProviderSelection: ({ providerName, modelId }: { providerName: string; modelId: string }) => ({ primaryModel: `${providerName}/${modelId}` }),
}));

import { OpenClawProviderId } from '../../shared/providers/constants';
import { LobsterAIRequestCapability } from '../../shared/providers/lobsterAIRequestOptions';
import { RemoteInputMode, RemoteInputReason, RemoteModelUnavailableReason, type RemotePreparationClaim } from '../../shared/remote/input';
import type { CoworkStore } from '../coworkStore';
import { clearServerModelMetadata, listProviderSourceEntries, resolveAllEnabledProviderConfigs, updateServerModelMetadata } from '../libs/claudeSettings';
import { InputPreparationService } from './inputPreparationService';
import type { RemoteAgentCatalog } from './remoteAgentCatalog';
import { listRemoteInputModels } from './remoteInputModels';
import { RemoteModelCatalog } from './remoteModelCatalog';

const owner = { userId: 'A', scopeKey: 'personal' };
const server = { token: 'private-token', baseURL: 'https://server.private.example' };
const ordinary = { modelId: 'chat', modelName: 'Chat', supportsImage: true };
const kimi = { modelId: 'kimi-k3', modelName: 'Kimi K3', apiFormat: 'openai', runtimeProfile: 'moonshot-kimi-k3',
  supportsToolCalling: true, agenticReady: true };
const thinking = { supportsThinking: true, thinkingConfig: { options: [{ level: 'high', openclawLevel: 'high' }], defaultLevel: 'high' },
  requestCapabilities: [LobsterAIRequestCapability.OptionsV1] };
function catalogFixture() {
  const values = new Map<string, unknown>();
  const remote = { get: <T>(key: string): T | null => values.get(key) as T ?? null,
    put: (key: string, value: unknown) => values.set(key, structuredClone(value)) };
  return { remote, catalog: new RemoteModelCatalog(remote, () => listRemoteInputModels(server)) };
}
beforeEach(() => {
  clearServerModelMetadata();
  vi.mocked(resolveAllEnabledProviderConfigs).mockReturnValue([]);
  vi.mocked(listProviderSourceEntries).mockReturnValue([]);
});

describe('remote input model availability', () => {
  it('publishes custom provider display names and renames without changing the runtime identity', async () => {
    const providerName = 'custom_0';
    vi.mocked(resolveAllEnabledProviderConfigs).mockReturnValue([{
      providerName, apiKey: 'private-key', baseURL: 'https://provider.private.example', apiType: 'openai', codingPlanEnabled: false,
      models: [{ id: 'chat', name: 'DeepSeek Flash' }],
    }]);
    const { catalog } = catalogFixture();
    const legacyItems = catalog.refresh(owner, 'pc');
    expect(legacyItems[0].providerLabel).toBe(providerName);
    let savedItems = legacyItems;
    let version = '1';
    const api = vi.fn(async (_path: string, method?: string, body?: { items: typeof legacyItems }) => {
      if (method === 'POST') {
        savedItems = body!.items;
        version = String(Number(version) + 1);
      }
      return { catalogVersion: version, items: savedItems };
    });
    await catalog.publish(owner, 'pc', '1', api, () => true);

    for (const [index, displayName] of [' 50刀 ', '工作代理'].entries()) {
      vi.mocked(listProviderSourceEntries).mockReturnValue([{ providerName, codingPlanEnabled: false, displayName }]);
      await catalog.publish(owner, 'pc', '1', api, () => true);
      const item = savedItems[0];
      expect(item).toMatchObject({ modelRef: legacyItems[0].modelRef, version: String(index + 2),
        providerLabel: displayName.trim(), displayName: 'DeepSeek Flash' });
      expect(catalog.resolve(owner, 'pc', item.modelRef, item.version).local).toMatchObject({
        identity: JSON.stringify([providerName, 'chat']), runtimeRef: `${providerName}/chat`,
      });
      expect(JSON.stringify(savedItems)).not.toMatch(/private-key|private\.example|apiKey|baseURL|runtimeRef/u);
    }
    expect(api.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(2);
  });

  it.each([undefined, '', '   '])('keeps the legacy provider label when the display name is %j', (displayName) => {
    vi.mocked(resolveAllEnabledProviderConfigs).mockReturnValue([{
      providerName: 'custom_0', apiKey: 'private-key', baseURL: 'https://provider.private.example', apiType: 'openai', codingPlanEnabled: false,
      models: [{ id: 'chat', name: 'Chat' }],
    }]);
    vi.mocked(listProviderSourceEntries).mockReturnValue([{ providerName: 'custom_0', codingPlanEnabled: false, displayName }]);
    const { catalog } = catalogFixture();
    expect(catalog.refresh(owner, 'pc')[0].providerLabel).toBe('custom_0');
  });

  it('applies public label sanitization to custom provider names', () => {
    vi.mocked(resolveAllEnabledProviderConfigs).mockReturnValue([{
      providerName: 'custom_0', apiKey: 'private-key', baseURL: 'https://provider.private.example', apiType: 'openai', codingPlanEnabled: false,
      models: [{ id: 'chat', name: 'Chat' }],
    }]);
    vi.mocked(listProviderSourceEntries).mockReturnValue([{
      providerName: 'custom_0', codingPlanEnabled: false, displayName: 'https://private.example/secret',
    }]);
    const { catalog } = catalogFixture();
    const items = catalog.refresh(owner, 'pc');
    expect(items[0].providerLabel).toBe('custom');
    expect(JSON.stringify(items)).not.toContain('private.example');
  });

  it('preserves server catalog order and configured custom model order within each source', () => {
    const serverModels = [
      { modelId: 'balanced', modelName: 'Fast' },
      { modelId: 'ultimate', modelName: 'Flagship' },
      { modelId: 'z-chat', modelName: 'Z chat' },
      { modelId: 'a-chat', modelName: 'A chat' },
    ];
    updateServerModelMetadata(serverModels);
    vi.mocked(resolveAllEnabledProviderConfigs).mockReturnValue(['custom-z', 'custom-a'].map(providerName => ({
      providerName, apiKey: 'private-key', baseURL: 'https://provider.private.example', apiType: 'openai', codingPlanEnabled: false,
      models: [{ id: 'z', name: `${providerName} Z` }, { id: 'a', name: `${providerName} A` }],
    })));
    const models = listRemoteInputModels(server);
    expect(models.filter(model => model.source === 'subscription').map(model => model.displayName))
      .toEqual(serverModels.map(model => model.modelName));
    expect(models.filter(model => model.source === 'custom').map(model => model.displayName))
      .toEqual(['custom-z Z', 'custom-z A', 'custom-a Z', 'custom-a A']);

    // An order-only refresh updates the cache even though runtime metadata is unchanged.
    expect(updateServerModelMetadata([...serverModels].reverse())).toBe(false);
    expect(listRemoteInputModels(server).filter(model => model.source === 'subscription').map(model => model.displayName))
      .toEqual([...serverModels].reverse().map(model => model.modelName));
  });
  it.each([undefined, false, true])('matches the ordinary desktop gate when tool calling is %s', (supportsToolCalling) => {
    updateServerModelMetadata([{ ...ordinary, supportsToolCalling }]);
    const { catalog } = catalogFixture();
    const item = catalog.refresh(owner, 'pc')[0];
    expect(item).toMatchObject({ source: 'subscription', available: true, unavailableReason: null,
      inputCapabilities: { toolCalling: supportsToolCalling === true, image: true } });
    expect(catalog.resolve(owner, 'pc', item.modelRef, item.version).local.runtimeRef).toBe(`${OpenClawProviderId.LobsteraiServer}/chat`);
  });

  it('uses explicit permission denials and permits legacy responses without access metadata', () => {
    updateServerModelMetadata([{ ...ordinary, accessible: false }]);
    expect(listRemoteInputModels(server)[0]).toMatchObject({ available: false, unavailableReason: RemoteModelUnavailableReason.PermissionDenied });
    updateServerModelMetadata([ordinary]);
    expect(listRemoteInputModels(server)[0].available).toBe(true);
    expect(listRemoteInputModels({ ...server, token: null })[0]).toMatchObject({ available: false, unavailableReason: RemoteModelUnavailableReason.PermissionDenied });
  });

  it.each([
    { runtimeProfile: undefined }, { supportsToolCalling: false }, { agenticReady: false }, { apiFormat: 'anthropic' },
  ])('retains strict Kimi runtime gates: %j', (patch) => {
    updateServerModelMetadata([{ ...kimi, ...patch }]);
    expect(listRemoteInputModels(server)[0]).toMatchObject({ available: false, unavailableReason: RemoteModelUnavailableReason.Unsupported });
    updateServerModelMetadata([kimi]);
    expect(listRemoteInputModels(server)[0].available).toBe(true);
  });

  it('exposes thinking options only when both selection and the request protocol are supported', () => {
    updateServerModelMetadata([{ ...ordinary, ...thinking }]);
    expect(listRemoteInputModels(server)[0].thinking).toEqual({ options: ['high'], default: 'high' });
    for (const patch of [{ requestCapabilities: undefined }, { accessible: false }, { supportsThinking: false }]) {
      updateServerModelMetadata([{ ...ordinary, ...thinking, ...patch }]);
      expect(listRemoteInputModels(server)[0].thinking).toEqual({ options: [] });
    }
    updateServerModelMetadata([{ ...kimi, ...thinking, agenticReady: false }]);
    expect(listRemoteInputModels(server)[0].thinking).toEqual({ options: [] });
    updateServerModelMetadata([{ ...ordinary, ...thinking }]);
    expect(listRemoteInputModels({ ...server, token: null })[0].thinking).toEqual({ options: [] });
  });

  it('invalidates old versions on permission revocation and restoration without changing identity', () => {
    updateServerModelMetadata([{ ...ordinary, accessible: true }]);
    const { catalog } = catalogFixture();
    const first = catalog.refresh(owner, 'pc')[0];
    updateServerModelMetadata([{ ...ordinary, accessible: false }]);
    expect(catalog.refresh(owner, 'pc')[0]).toMatchObject({ modelRef: first.modelRef, version: '2', available: false,
      unavailableReason: RemoteModelUnavailableReason.PermissionDenied });
    expect(() => catalog.resolve(owner, 'pc', first.modelRef, first.version)).toThrow(RemoteInputReason.ModelUnavailable);
    updateServerModelMetadata([{ ...ordinary, accessible: true }]);
    expect(catalog.refresh(owner, 'pc')[0]).toMatchObject({ modelRef: first.modelRef, version: '3', available: true });
    expect(() => catalog.resolve(owner, 'pc', first.modelRef, first.version)).toThrow(RemoteInputReason.ModelChanged);
  });

  it('keeps same-name subscription and custom providers distinct and never publishes credentials', () => {
    updateServerModelMetadata([ordinary]);
    vi.mocked(resolveAllEnabledProviderConfigs).mockReturnValue(['custom-a', 'custom-b'].map(providerName => ({
      providerName, apiKey: 'private-key', baseURL: 'https://provider.private.example', apiType: 'openai', codingPlanEnabled: false,
      models: [{ id: 'chat', name: 'Chat' }],
    })));
    const { catalog } = catalogFixture();
    const items = catalog.refresh(owner, 'pc');
    expect(items).toHaveLength(3);
    expect(new Set(items.map(item => item.modelRef)).size).toBe(3);
    expect(items.filter(item => item.source === 'custom')).toHaveLength(2);
    expect(items.filter(item => item.source === 'subscription')).toHaveLength(1);
    expect(new Set(items.map(item => catalog.resolve(owner, 'pc', item.modelRef, item.version).local.runtimeRef)).size).toBe(3);
    expect(JSON.stringify(items)).not.toMatch(/private-key|private-token|private\.example|apiKey|baseURL|runtimeRef/u);
  });

  it('rejects a previously prepared input after permission revocation and after restoration', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'remote-permission-'));
    try {
      updateServerModelMetadata([{ ...ordinary, accessible: true }]);
      const { remote, catalog } = catalogFixture();
      const model = catalog.refresh(owner, 'pc')[0];
      const store = { remote, assertAgentAccess: vi.fn(), getAgent: () => ({ enabled: true }),
        agentOwnership: { get: () => ({ version: '1' }), canPublish: () => true } } as unknown as CoworkStore;
      const agents = { refresh: async () => [{ agentId: 'main', version: '1', workspaceAvailable: true, defaultWorkspaceId: 'workspace' }],
        resolve: () => cwd } as unknown as RemoteAgentCatalog;
      const service = new InputPreparationService({ store, models: catalog, cacheRoot: path.join(cwd, 'cache'), getOwner: () => owner,
        getDefaultModel: () => `${OpenClawProviderId.LobsteraiServer}/chat`, getAgentCatalog: () => agents });
      const claim: RemotePreparationClaim = { preparationId: 'prep', claimId: 'claim', claimToken: 'claim-token', claimUntil: new Date(Date.now() + 60_000).toISOString(), statusVersion: '1',
        request: { preparationId: 'prep', inputSchemaVersion: 2, purpose: 'create_session', draftId: 'draft',
          input: { text: 'hello', agent: { agentId: 'main', expectedVersion: '1' },
            model: { mode: RemoteInputMode.Selected, modelRef: model.modelRef, expectedVersion: model.version } } } };
      const prepared = await service.prepare(owner, 'pc', claim, vi.fn(), () => true);
      expect(() => service.validate(prepared, owner, 'pc', false)).not.toThrow();
      updateServerModelMetadata([{ ...ordinary, accessible: false }]);
      expect(() => service.validate(prepared, owner, 'pc', false)).toThrow(RemoteInputReason.ModelUnavailable);
      updateServerModelMetadata([{ ...ordinary, accessible: true }]);
      expect(() => service.validate(prepared, owner, 'pc', false)).toThrow(RemoteInputReason.ModelChanged);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
