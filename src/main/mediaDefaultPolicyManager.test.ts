import {
  describe,
  expect,
  test,
  vi,
} from 'vitest';

import {
  MediaDefaultsProtocol,
  mediaPreferenceKey,
  MediaPreferenceMode,
  MediaSelectionMode,
  MediaSelectionSource,
  MediaType,
  migrateMediaPreferences,
} from '../shared/media/defaultPolicy';
import { MediaDefaultPolicyManager } from './mediaDefaultPolicyManager';

const owner = 'personal:71';
const policy = {
  schemaVersion: 1, policyVersion: 'test', eligible: true, ttlSeconds: 60,
  defaults: {
    image: { enabled: true, modelId: 'default-image', modelName: 'Image', params: { size: '2K', n: 1 }, maxOutputsPerTurn: 1 },
    video: { enabled: true, modelId: 'default-video', modelName: 'Video', params: { resolution: '720p', durationSeconds: 5 },
      maxOutputsPerTurn: 1, confirmation: MediaDefaultsProtocol.EverySubmission },
  },
};
const response = () => new Response(JSON.stringify({ code: 0, data: policy }));
const fixture = () => {
  const values = new Map<string, unknown>();
  const context = { scope: { ownerAccountKey: owner, accountGeneration: 1 }, entitled: true, now: 0 };
  const deps = {
    get: vi.fn((key: string) => values.get(key)),
    set: vi.fn((key: string, value: unknown) => { values.set(key, value); }),
    remove: vi.fn((key: string) => { values.delete(key); }),
    scope: () => context.scope, entitled: () => context.entitled, now: () => context.now,
    server: () => 'https://test.invalid', fetch: vi.fn(async () => response()),
  };
  return { values, context, deps, manager: new MediaDefaultPolicyManager(deps) };
};

describe('MediaDefaultPolicyManager', () => {
  test('migrates legacy data once and consumes the global value only for its first owner', async () => {
    const f = fixture();
    f.values.set(MediaDefaultsProtocol.LegacyKey, { image: { modelId: 'old', modelName: 'Old' } });
    const a = await f.manager.state(owner);
    expect(a.selection.imageModelId).toBe('old');
    expect(a.selection.videoModelId).toBeUndefined();
    expect(f.values.has(MediaDefaultsProtocol.LegacyKey)).toBe(false);
    f.context.scope = { ownerAccountKey: 'personal:72', accountGeneration: 2 };
    expect((await f.manager.state('personal:72')).selection.imageModelId).toBe('default-image');
    expect(f.values.get(mediaPreferenceKey(owner))).toEqual(a.preferences);
  });

  test('a preference click during a policy fetch wins over the delayed result', async () => {
    const f = fixture();
    let deliver!: (value: Response) => void;
    f.deps.fetch.mockImplementation(() => new Promise(resolve => { deliver = resolve; }));
    const load = f.manager.state(owner);
    const clicked = f.manager.update(owner, MediaType.Image, { mode: MediaPreferenceMode.Off });
    deliver(response());
    const [a, b] = await Promise.all([load, clicked]);
    expect(a.selection.imageModelId).toBeUndefined();
    expect(b.selection.imageModelId).toBeUndefined();
    expect(a.preferences.revision).toBe(1);
    expect(f.deps.fetch).toHaveBeenCalledTimes(1);
  });

  test('switching accounts during a request rejects its result and cannot populate the new owner', async () => {
    const f = fixture();
    let deliver!: (value: Response) => void;
    f.deps.fetch.mockImplementation(() => new Promise(resolve => { deliver = resolve; }));
    const load = f.manager.state(owner);
    f.context.scope = { ownerAccountKey: 'personal:72', accountGeneration: 2 };
    deliver(response());
    await expect(load).rejects.toThrow('Media account changed');
    await expect(f.manager.update(owner, MediaType.Image, { mode: MediaPreferenceMode.Off })).rejects.toThrow();
    expect(f.values.has(mediaPreferenceKey('personal:72'))).toBe(false);
  });

  test('an old server and unavailable defaults preserve manual models without fallback', async () => {
    const f = fixture();
    f.deps.fetch.mockResolvedValue(new Response('', { status: 404 }));
    f.values.set(MediaDefaultsProtocol.LegacyKey, { video: { modelId: 'user-video', modelName: 'Video' } });
    const state = await f.manager.state(owner);
    expect(state.selection.videoModelId).toBe('user-video');
    expect(state.selection.imageModelId).toBeUndefined();
  });

  test('expired policy failure cannot reuse automatic defaults', async () => {
    const f = fixture();
    expect((await f.manager.state(owner)).selection.mode).toBe(MediaSelectionMode.Auto);
    f.context.now = 61_000;
    f.deps.fetch.mockResolvedValue(new Response('', { status: 503 }));
    expect((await f.manager.state(owner)).selection.mode).toBe(MediaSelectionMode.None);
  });

  test('storage failures are not treated as never configured', async () => {
    const f = fixture();
    f.deps.get.mockImplementation(() => { throw new Error('storage failure'); });
    await expect(f.manager.state(owner)).rejects.toThrow('storage failure');
    expect((await f.manager.turn({ isPlan: false })).mode).toBe(MediaSelectionMode.None);
    expect(f.deps.fetch).not.toHaveBeenCalled();
    expect(f.deps.set).not.toHaveBeenCalled();
  });

  test('off survives restart; restore defaults does not persist server models as user choices', async () => {
    const f = fixture();
    await f.manager.update(owner, MediaType.Image, { mode: MediaPreferenceMode.Off });
    const restarted = new MediaDefaultPolicyManager(f.deps);
    expect((await restarted.state(owner)).selection.imageModelId).toBeUndefined();
    const restored = await restarted.update(owner, MediaType.Image, { mode: MediaPreferenceMode.Inherit });
    expect(restored.selection.imageSource).toBe(MediaSelectionSource.Default);
    expect(restored.preferences.image).toEqual({ mode: MediaPreferenceMode.Inherit });
    expect(f.values.get(`${MediaDefaultsProtocol.LegacyKey}:${owner}`)).toEqual({});
  });

  test('plan mode and loss of entitlement disable execution without rewriting preferences', async () => {
    const f = fixture();
    const preferences = migrateMediaPreferences(undefined, undefined);
    f.values.set(mediaPreferenceKey(owner), preferences);
    expect((await f.manager.turn({ isPlan: true })).mode).toBe(MediaSelectionMode.None);
    f.context.entitled = false;
    expect((await f.manager.turn({ isPlan: false })).mode).toBe(MediaSelectionMode.None);
    expect(f.deps.fetch).not.toHaveBeenCalled();
    expect(f.values.get(mediaPreferenceKey(owner))).toBe(preferences);
  });

  test('explicit per-turn off wins; a direct BYOK skill suppresses only its automatic media type', async () => {
    const f = fixture();
    expect((await f.manager.turn({ selection: { mode: MediaSelectionMode.None }, isPlan: false })).mode)
      .toBe(MediaSelectionMode.None);
    const result = await f.manager.turn({ isPlan: false, explicitSkillIds: ['seedream'] });
    expect(result.imageModelId).toBeUndefined();
    expect(result.videoModelId).toBe('default-video');
    const next = await f.manager.turn({ isPlan: false });
    expect(next.imageModelId).toBe('default-image');
  });

  test('expert-provided media skills keep defaults while a separately selected skill still wins', async () => {
    const f = fixture();
    const inherited = await f.manager.turn({
      isPlan: false, explicitSkillIds: ['seedream', 'seedance'], inheritedSkillIds: ['seedream', 'seedance'],
    });
    expect(inherited.imageModelId).toBe('default-image');
    expect(inherited.videoModelId).toBe('default-video');
    const mixed = await f.manager.turn({
      isPlan: false, explicitSkillIds: ['seedream', 'seedance'], inheritedSkillIds: ['seedream'],
    });
    expect(mixed.imageModelId).toBe('default-image');
    expect(mixed.videoModelId).toBeUndefined();
    await f.manager.update(owner, MediaType.Image, { mode: MediaPreferenceMode.Off });
    expect((await f.manager.turn({
      isPlan: false, explicitSkillIds: ['seedream'], inheritedSkillIds: ['seedream'],
    })).imageModelId).toBeUndefined();
  });
});
