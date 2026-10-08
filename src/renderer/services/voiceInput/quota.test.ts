import { describe, expect, test } from 'vitest';

import {
  applyVoiceInputQuotaConsumption,
  calculateVoiceInputConsumedSeconds,
} from './quota';

describe('calculateVoiceInputConsumedSeconds', () => {
  test.each([
    [0, 0],
    [1, 1],
    [16_000, 1],
    [16_001, 2],
    [Number.NaN, 0],
  ])('converts %s output samples to %s billed seconds', (sampleCount, expectedSeconds) => {
    expect(calculateVoiceInputConsumedSeconds(sampleCount)).toBe(expectedSeconds);
  });
});

describe('applyVoiceInputQuotaConsumption', () => {
  test('subtracts completed recording usage from the session quota snapshot', () => {
    expect(applyVoiceInputQuotaConsumption({
      usedSecondsToday: 60,
      remainingSecondsToday: 1140,
      limitSecondsToday: 1200,
    }, 45)).toEqual({
      usedSecondsToday: 105,
      remainingSecondsToday: 1095,
      limitSecondsToday: 1200,
    });
  });

  test('marks quota exhausted when recording consumes the exact remainder', () => {
    expect(applyVoiceInputQuotaConsumption({
      usedSecondsToday: 1199,
      remainingSecondsToday: 1,
      limitSecondsToday: 1200,
    }, 1)).toEqual({
      usedSecondsToday: 1200,
      remainingSecondsToday: 0,
      limitSecondsToday: 1200,
    });
  });
});
