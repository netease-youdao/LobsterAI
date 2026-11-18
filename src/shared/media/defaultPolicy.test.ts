import {
  describe,
  expect,
  test,
} from 'vitest';

import {
  MediaDefaultsProtocol,
  MediaPreferenceMode,
  MediaSelectionMode,
  MediaSelectionSource,
  MediaType,
  migrateMediaPreferences,
  parseMediaDefaultPolicy,
  resolveMediaPreferences,
} from './defaultPolicy';

const policyInput = {
  schemaVersion: 1, policyVersion: 'test-policy', ttlSeconds: 900, eligible: true,
  defaults: {
    image: { enabled: true, modelId: 'image-default', modelName: 'Image', params: { size: '2K', n: 1 }, maxOutputsPerTurn: 1 },
    video: { enabled: true, modelId: 'video-default', modelName: 'Video', params: { resolution: '720p', durationSeconds: 5 },
      maxOutputsPerTurn: 1, confirmation: MediaDefaultsProtocol.EverySubmission },
  },
};

describe('media preference migration and merging', () => {
  test('only absent keys inherit; an existing empty object stays off', () => {
    const fresh = migrateMediaPreferences(undefined, undefined);
    const cleared = migrateMediaPreferences(undefined, {});
    expect(fresh.image.mode).toBe(MediaPreferenceMode.Inherit);
    expect(resolveMediaPreferences(fresh, parseMediaDefaultPolicy(policyInput)).mode).toBe(MediaSelectionMode.Auto);
    expect(cleared.image.mode).toBe(MediaPreferenceMode.Off);
    expect(cleared.video.mode).toBe(MediaPreferenceMode.Off);
    expect(resolveMediaPreferences(cleared, parseMediaDefaultPolicy(policyInput)).mode).toBe(MediaSelectionMode.None);
  });

  test.each([MediaType.Image, MediaType.Video])('keeps a legacy %s model without opening the missing type', type => {
    const preferences = migrateMediaPreferences(undefined, { [type]: { modelId: 'my-model', modelName: 'Mine' } });
    const selection = resolveMediaPreferences(preferences, parseMediaDefaultPolicy(policyInput));
    expect(selection.mode).toBe(type);
    expect(selection.modelId).toBe('my-model');
    expect(selection[type === MediaType.Image ? 'imageSource' : 'videoSource']).toBe(MediaSelectionSource.User);
  });

  test('policy replacement affects only inherited types, including after a restart', () => {
    const stored = migrateMediaPreferences(undefined, undefined);
    stored.image = { mode: MediaPreferenceMode.Selected, modelId: 'retired-model', modelName: 'Keep this' };
    stored.revision = 3;
    const reopened = migrateMediaPreferences(JSON.parse(JSON.stringify(stored)), {});
    const first = resolveMediaPreferences(reopened, parseMediaDefaultPolicy(policyInput));
    const updated = structuredClone(policyInput);
    updated.defaults.video.modelId = 'next-default';
    const next = resolveMediaPreferences(reopened, parseMediaDefaultPolicy(updated));
    expect(next.imageModelId).toBe('retired-model');
    expect(next.videoModelId).toBe('next-default');
    expect(first.videoModelId).toBe('video-default');
    expect(next.preferencesRevision).toBe(3);
    expect(resolveMediaPreferences(reopened).imageModelId).toBe('retired-model');
    expect(resolveMediaPreferences(reopened).videoModelId).toBeUndefined();
  });

  test('stored off survives every default refresh and invalid storage never becomes fresh', () => {
    const preferences = migrateMediaPreferences(undefined, {});
    expect(resolveMediaPreferences(preferences, parseMediaDefaultPolicy(policyInput)).imagePreference).toBe(MediaPreferenceMode.Off);
    expect(() => migrateMediaPreferences({ schemaVersion: 99 }, undefined)).toThrow();
    expect(() => migrateMediaPreferences(undefined, 'corrupt')).toThrow();
    expect(() => migrateMediaPreferences(undefined, { image: {} })).toThrow();
  });

  test('snapshots are independent across turns but retain source and parameters', () => {
    const preferences = migrateMediaPreferences(undefined, undefined);
    const policy = parseMediaDefaultPolicy(policyInput);
    const a = resolveMediaPreferences(preferences, policy);
    const b = resolveMediaPreferences(preferences, policy);
    expect(a.imageDefault).not.toBe(b.imageDefault);
    expect(a.imageSource).toBe(MediaSelectionSource.Default);
    expect(a.imageDefault?.params).toEqual({ size: '2K', n: 1 });
  });
});

describe('media default protocol admission', () => {
  test.each([
    { ...policyInput, schemaVersion: 2 },
    { ...policyInput, ttlSeconds: -1 },
    { ...policyInput, defaults: [] },
    { ...policyInput, defaults: { video: { ...policyInput.defaults.video, confirmation: 'never' } } },
    { ...policyInput, defaults: { image: { ...policyInput.defaults.image, params: { n: 4, size: '2K' } } } },
  ])('rejects unsupported or unsafe configuration', input => {
    expect(parseMediaDefaultPolicy(input)).toBeUndefined();
  });

  test('disabled policy does not erase a manual selection', () => {
    const preferences = migrateMediaPreferences(undefined, { image: { modelId: 'mine', modelName: 'Mine' } });
    const policy = parseMediaDefaultPolicy({ ...policyInput, eligible: false });
    expect(resolveMediaPreferences(preferences, policy).modelId).toBe('mine');
  });
});
