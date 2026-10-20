import { describe, expect, test } from 'vitest';

import { ModelPresetId, modelPresetModelId } from '../modelPresets/constants';
import { formatModelDisplayName, getMessageModelLabel } from './messageModelLabel';

const presetName = (presetId: ModelPresetId): string =>
  presetId === ModelPresetId.Balanced ? '快速' : '旗舰';

describe('getMessageModelLabel', () => {
  test.each([
    [ModelPresetId.Balanced, '快速'],
    [ModelPresetId.Ultimate, '旗舰'],
  ] as const)('uses the recorded resolved model for preset %s', (modelPresetId, name) => {
    expect(getMessageModelLabel({
      modelPresetId,
      model: modelPresetModelId(modelPresetId),
      resolvedModelId: 'youdao/deepseek-flash-YoudaoInner',
    }, presetName)).toBe(`${name}（deepseek-flash）`);
  });

  test('keeps explicit preset plus resolved model ahead of a different model field', () => {
    expect(getMessageModelLabel({
      modelPresetId: ModelPresetId.Balanced,
      model: 'old-provider/old-model',
      resolvedModelId: 'new-provider/actual-model',
    }, presetName)).toBe('快速（actual-model）');
  });

  test('uses the reply model directly when no preset is recorded', () => {
    expect(getMessageModelLabel({
      model: ' youdao/deepseek-flash-YoudaoInner ',
      resolvedModelId: 'other-provider/different-model',
    }, presetName)).toBe('deepseek-flash');
  });

  test('falls back to a resolved model when the reply has no model field', () => {
    expect(getMessageModelLabel({
      resolvedModelId: ' youdao/qwen3.8-max-YoudaoInner ',
    }, presetName)).toBe('qwen3.8-max');
  });

  test('infers the preset from a virtual routing model when a concrete model is known', () => {
    expect(getMessageModelLabel({
      model: `youdao/${modelPresetModelId(ModelPresetId.Ultimate)}`,
      resolvedModelId: 'youdao/deepseek-pro',
    }, presetName)).toBe('旗舰（deepseek-pro）');
  });

  test('keeps a concrete model when the resolved value is still a virtual route', () => {
    expect(getMessageModelLabel({
      modelPresetId: ModelPresetId.Balanced,
      model: 'provider/actual-model',
      resolvedModelId: modelPresetModelId(ModelPresetId.Balanced),
    }, presetName)).toBe('快速（actual-model）');
  });

  test.each([ModelPresetId.Balanced, ModelPresetId.Ultimate])(
    'does not show unresolved virtual routing model %s',
    (modelPresetId) => {
      expect(getMessageModelLabel({
        modelPresetId,
        model: `youdao/${modelPresetModelId(modelPresetId)}`,
        resolvedModelId: modelPresetModelId(modelPresetId),
      }, presetName)).toBeNull();
    },
  );

  test('uses the caller locale for preset names', () => {
    expect(getMessageModelLabel({
      modelPresetId: ModelPresetId.Balanced,
      resolvedModelId: 'provider/actual-model',
    }, () => 'Fast')).toBe('Fast（actual-model）');
  });

  test.each([
    undefined, null, false, 3, 'model', [], {},
    { model: 42, resolvedModelId: {}, modelPresetId: [] },
    { model: ' ', resolvedModelId: '\t' },
  ])('ignores missing or malformed metadata: %j', (metadata) => {
    expect(getMessageModelLabel(metadata, presetName)).toBeNull();
  });

  test('ignores an unrecognized preset without hiding a concrete model', () => {
    expect(getMessageModelLabel({
      modelPresetId: 'unknown-preset',
      model: 'provider/actual-model',
    }, presetName)).toBe('actual-model');
  });
});

describe('formatModelDisplayName', () => {
  test('hides only a terminal internal provider suffix, case-insensitively', () => {
    expect(formatModelDisplayName('deepseek-flash-YoudaoInner')).toBe('deepseek-flash');
    expect(formatModelDisplayName('deepseek-flash-youdaoinner')).toBe('deepseek-flash');
    expect(formatModelDisplayName('deepseek-YoudaoInner-flash')).toBe('deepseek-YoudaoInner-flash');
    expect(formatModelDisplayName('provider/model')).toBe('provider/model');
  });
});
