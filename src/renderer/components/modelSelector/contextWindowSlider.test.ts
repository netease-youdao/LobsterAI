import { describe, expect, test } from 'vitest';

import { buildContextWindowSliderStops, contextWindowSliderIndex } from './contextWindowSlider';

describe('context window slider intent', () => {
  test('keeps a matching default distinct from a deliberate fixed choice at the same thumb position', () => {
    const stops = buildContextWindowSliderStops([400_000, 1_000_000], 400_000);
    expect(stops).toEqual([{ tokens: 400_000, selection: 400_000 }, { tokens: 1_000_000, selection: 1_000_000 }]);
    expect(contextWindowSliderIndex(stops, null, 400_000)).toBe(0);
    expect(contextWindowSliderIndex(stops, 400_000, 400_000)).toBe(0);
    // Merely displaying that position does not manufacture an override.
    expect(stops[0].selection).toBe(400_000);
  });

  test('represents a changed server default without granting an unsupported fixed budget', () => {
    const stops = buildContextWindowSliderStops([400_000, 1_000_000], 500_000);
    expect(stops).toEqual([
      { tokens: 400_000, selection: 400_000 },
      { tokens: 500_000, selection: null },
      { tokens: 1_000_000, selection: 1_000_000 },
    ]);
    expect(contextWindowSliderIndex(stops, null, 500_000)).toBe(1);
    expect(contextWindowSliderIndex(stops, 400_000, 500_000)).toBe(0);
  });

  test('snaps only to declared choices and the current default', () => {
    expect(buildContextWindowSliderStops([1_000_000, 400_000, 400_000, 399_999, 1_000_001], 400_000))
      .toEqual([{ tokens: 400_000, selection: 400_000 }, { tokens: 1_000_000, selection: 1_000_000 }]);
  });
});
