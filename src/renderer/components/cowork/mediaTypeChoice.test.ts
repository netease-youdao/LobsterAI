import { describe, expect, test } from 'vitest';

import {
  MediaPreferenceMode,
  type MediaPreferences,
  MediaSelectionMode,
  MediaSelectionSource,
  MediaType,
  resolveMediaPreferences,
} from '../../../shared/media/defaultPolicy';
import { CANVAS20_LEGACY_MODEL_ID, GPT_IMAGE_2_MODEL_ID } from '../../../shared/mediaModelAliases';
import { resolveMediaTypeChoice } from './mediaTypeChoice';

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
  },
};

const preferences = (image: MediaPreferences['image'], video: MediaPreferences['video']): MediaPreferences => ({
  schemaVersion: 1, revision: 1, image, video,
});

describe('resolveMediaTypeChoice', () => {
  test('checks no row before preferences load', () => {
    expect(resolveMediaTypeChoice(undefined, MediaType.Image)).toEqual({});
  });

  test('names the system default while it is in use', () => {
    const selection = resolveMediaPreferences(
      preferences({ mode: MediaPreferenceMode.Inherit }, { mode: MediaPreferenceMode.Off }), policy,
    );
    expect(resolveMediaTypeChoice(selection, MediaType.Image)).toEqual({
      preference: MediaPreferenceMode.Inherit, modelId: 'seedream-pro', defaultModelName: 'Seedream Pro',
    });
    expect(resolveMediaTypeChoice(selection, MediaType.Video)).toEqual({
      preference: MediaPreferenceMode.Off, modelId: undefined, defaultModelName: undefined,
    });
  });

  test('keeps the default row checked without a name when the account has no default', () => {
    const selection = resolveMediaPreferences(
      preferences({ mode: MediaPreferenceMode.Inherit }, { mode: MediaPreferenceMode.Inherit }),
      { ...policy, eligible: false },
    );
    expect(resolveMediaTypeChoice(selection, MediaType.Image).preference).toBe(MediaPreferenceMode.Inherit);
    expect(resolveMediaTypeChoice(selection, MediaType.Image).defaultModelName).toBeUndefined();
  });

  test('reports the user pick by its canonical id', () => {
    const selection = resolveMediaPreferences(preferences(
      { mode: MediaPreferenceMode.Selected, modelId: CANVAS20_LEGACY_MODEL_ID, modelName: 'Canvas' },
      { mode: MediaPreferenceMode.Off },
    ), policy);
    expect(resolveMediaTypeChoice(selection, MediaType.Image)).toEqual({
      preference: MediaPreferenceMode.Selected, modelId: GPT_IMAGE_2_MODEL_ID, defaultModelName: undefined,
    });
  });

  test('derives the choice from the source when preference fields are missing', () => {
    expect(resolveMediaTypeChoice(
      { mode: MediaSelectionMode.Image, modelId: 'mine', imageSource: MediaSelectionSource.User }, MediaType.Image,
    ).preference).toBe(MediaPreferenceMode.Selected);
    expect(resolveMediaTypeChoice(
      { mode: MediaSelectionMode.Image, imageModelId: 'seedream-pro', imageSource: MediaSelectionSource.Default },
      MediaType.Image,
    ).preference).toBe(MediaPreferenceMode.Inherit);
    expect(resolveMediaTypeChoice({ mode: MediaSelectionMode.None }, MediaType.Video).preference)
      .toBe(MediaPreferenceMode.Off);
  });
});
