import { describe, expect, test } from 'vitest';

import {
  MediaPreferenceMode,
  type MediaPreferences,
  resolveMediaPreferences,
} from '../../../shared/media/defaultPolicy';
import { CANVAS20_LEGACY_MODEL_ID, GPT_IMAGE_2_MODEL_ID, mediaModelDisplayName } from '../../../shared/mediaModelAliases';
import {
  hasNonDefaultMediaPreference,
  resolveCustomMediaModelBadge,
} from './mediaOverrideBadge';

const policy = {
  schemaVersion: 1 as const,
  policyVersion: 'v1',
  ttlSeconds: 300,
  eligible: true,
  defaults: {
    image: {
      enabled: true as const,
      modelId: 'seedream-pro',
      modelName: 'Seedream Pro',
      params: { size: '1024x1024', n: 1 },
      maxOutputsPerTurn: 1,
    },
    video: {
      enabled: true as const,
      modelId: 'kling-v2',
      modelName: 'Kling 2.0',
      params: { resolution: '720p', durationSeconds: 5 },
      maxOutputsPerTurn: 1,
      confirmation: 'every_submission',
    },
  },
};

const prefs = (
  image: MediaPreferences['image'],
  video: MediaPreferences['video'],
): MediaPreferences => ({
  schemaVersion: 1,
  revision: 1,
  image,
  video,
});

const catalog = {
  image: [
    { modelId: 'banana-2', displayName: 'Nano Banana 2' },
  ],
  video: [
    { modelId: 'kling-pro', displayName: 'Kling Pro' },
  ],
};

describe('resolveCustomMediaModelBadge', () => {
  test('returns null before preferences load or when using system defaults', () => {
    expect(resolveCustomMediaModelBadge(undefined, catalog)).toBeNull();
    const inheritAll = resolveMediaPreferences(
      prefs({ mode: MediaPreferenceMode.Inherit }, { mode: MediaPreferenceMode.Inherit }),
      policy,
    );
    expect(resolveCustomMediaModelBadge(inheritAll, catalog)).toBeNull();
    expect(hasNonDefaultMediaPreference(inheritAll)).toBe(false);
  });

  test('returns null for explicitly disabled generation while flagging non-default state', () => {
    const offAll = resolveMediaPreferences(
      prefs({ mode: MediaPreferenceMode.Off }, { mode: MediaPreferenceMode.Off }),
      policy,
    );
    expect(resolveCustomMediaModelBadge(offAll, catalog)).toBeNull();
    expect(hasNonDefaultMediaPreference(offAll)).toBe(true);
  });

  test('returns single custom image model using catalog display name', () => {
    const selection = resolveMediaPreferences(
      prefs(
        { mode: MediaPreferenceMode.Selected, modelId: 'banana-2', modelName: 'banana-2' },
        { mode: MediaPreferenceMode.Inherit },
      ),
      policy,
    );
    expect(resolveCustomMediaModelBadge(selection, catalog)).toEqual({
      primaryName: 'Nano Banana 2',
      names: ['Nano Banana 2'],
      types: ['image'],
      count: 1,
    });
    expect(hasNonDefaultMediaPreference(selection)).toBe(true);
  });

  test('falls back to canonical alias display name when catalog has not loaded yet', () => {
    const selection = resolveMediaPreferences(
      prefs(
        { mode: MediaPreferenceMode.Selected, modelId: CANVAS20_LEGACY_MODEL_ID, modelName: 'Canvas' },
        { mode: MediaPreferenceMode.Inherit },
      ),
      policy,
    );
    const badge = resolveCustomMediaModelBadge(selection);
    expect(badge).toEqual({
      primaryName: mediaModelDisplayName(GPT_IMAGE_2_MODEL_ID),
      names: [mediaModelDisplayName(GPT_IMAGE_2_MODEL_ID)],
      types: ['image'],
      count: 1,
    });
  });

  test('returns both selected models in image-then-video order when both are customized', () => {
    const selection = resolveMediaPreferences(
      prefs(
        { mode: MediaPreferenceMode.Selected, modelId: 'banana-2', modelName: 'Nano Banana 2' },
        { mode: MediaPreferenceMode.Selected, modelId: 'kling-pro', modelName: 'Kling Pro' },
      ),
      policy,
    );
    expect(resolveCustomMediaModelBadge(selection, catalog)).toEqual({
      primaryName: 'Nano Banana 2',
      names: ['Nano Banana 2', 'Kling Pro'],
      types: ['image', 'video'],
      count: 2,
    });
  });
});
