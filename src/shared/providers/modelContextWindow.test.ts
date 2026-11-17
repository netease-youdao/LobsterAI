import { describe, expect, test } from 'vitest';

import { ModelPresetId } from '../modelPresets/constants';
import { parseContextWindowOptions, selectableContextWindows, userContextWindowSelection } from './modelContextWindow';

describe('selectable context windows', () => {
  test('never infers choices from an ordinary default, including historical 1M', () => {
    expect(selectableContextWindows({ contextWindow: 1_000_000 })).toEqual([]);
    expect(parseContextWindowOptions([399_999, 1_000_001, '1000000', 400_000.5])).toBeUndefined();
    expect(parseContextWindowOptions([1_000_000, 400_000, 400_000])).toEqual([400_000, 1_000_000]);
  });

  test('mode choices require both mode policy and the bound model', () => {
    const model = { contextWindowOptions: [400_000, 1_000_000],
      presetContextWindowOptions: { [ModelPresetId.Balanced]: [400_000] } };
    expect(selectableContextWindows(model)).toEqual([400_000, 1_000_000]);
    expect(selectableContextWindows(model, ModelPresetId.Balanced)).toEqual([400_000]);
    expect(selectableContextWindows(model, ModelPresetId.Ultimate)).toEqual([]);
    expect(userContextWindowSelection(1_000_000, ModelPresetId.Balanced)).toBe('user-context:yd-fast:1000000');
  });
});
