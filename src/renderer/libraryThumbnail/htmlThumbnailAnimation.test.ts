import { describe, expect, test } from 'vitest';

import { HtmlThumbnailLimits } from '../../shared/library/htmlThumbnail';
import {
  getHtmlThumbnailAnimationWaitMs,
  type HtmlThumbnailAnimationTiming,
} from './htmlThumbnailAnimation';

const timing = (overrides: Partial<HtmlThumbnailAnimationTiming> = {}): HtmlThumbnailAnimationTiming => ({
  names: 'fadeUp',
  durations: '1s',
  delays: '0s',
  iterations: '1',
  ...overrides,
});

describe('getHtmlThumbnailAnimationWaitMs', () => {
  test('does not wait when no animation timing was collected', () => {
    expect(getHtmlThumbnailAnimationWaitMs([])).toBe(0);
  });

  test.each([
    { durations: '1s', delays: '200ms', expected: 1_200 },
    { durations: '250ms', delays: '.5s', expected: 750 },
    { durations: '.25s', delays: '0.1s', expected: 350 },
    { durations: '1.5s', delays: '0s', expected: 1_500 },
    { durations: ' 100ms ', delays: ' 50ms ', expected: 150 },
  ])('combines CSS duration $durations and delay $delays', ({ durations, delays, expected }) => {
    expect(getHtmlThumbnailAnimationWaitMs([timing({ durations, delays })])).toBe(
      expected + HtmlThumbnailLimits.AnimationSettleMs,
    );
  });

  test.each(['', 'none', 'none, none'])('ignores declarations without a named animation: %s', names => {
    expect(getHtmlThumbnailAnimationWaitMs([timing({ names, durations: '10s' })])).toBe(0);
  });

  test('cycles shorter CSS timing lists to match the animation-name list', () => {
    expect(getHtmlThumbnailAnimationWaitMs([timing({
      names: 'first, second, third, fourth',
      durations: '100ms, 200ms',
      delays: '0s, 100ms, 300ms',
      iterations: '1, 2',
    })])).toBe(500 + HtmlThumbnailLimits.AnimationSettleMs);
  });

  test('ignores extra durations that have no corresponding animation name', () => {
    expect(getHtmlThumbnailAnimationWaitMs([timing({
      durations: '100ms, 10s',
      delays: '50ms, 10s',
      iterations: '1, 100',
    })])).toBe(150 + HtmlThumbnailLimits.AnimationSettleMs);
  });

  test('uses the longest declaration instead of summing unrelated animations', () => {
    expect(getHtmlThumbnailAnimationWaitMs([
      timing({ durations: '300ms' }),
      timing({ durations: '700ms', delays: '100ms' }),
      timing({ durations: '200ms' }),
    ])).toBe(800 + HtmlThumbnailLimits.AnimationSettleMs);
  });

  test('honors fractional iteration counts and defaults an omitted count to one', () => {
    expect(getHtmlThumbnailAnimationWaitMs([timing({
      durations: '200ms', delays: '100ms', iterations: '2.5',
    })])).toBe(600 + HtmlThumbnailLimits.AnimationSettleMs);
    expect(getHtmlThumbnailAnimationWaitMs([timing({
      durations: '200ms', iterations: '',
    })])).toBe(200 + HtmlThumbnailLimits.AnimationSettleMs);
  });

  test.each(['infinite', 'Infinity', 'NaN', 'var(--iterations)', '0', '-1'])('does not wait for non-finite or inactive iteration count %s', iterations => {
    expect(getHtmlThumbnailAnimationWaitMs([timing({ iterations, delays: '1s' })])).toBe(0);
  });

  test('ignores an infinite animation without skipping another finite reveal', () => {
    expect(getHtmlThumbnailAnimationWaitMs([timing({
      names: 'pulse, fadeUp',
      durations: '100s, 700ms',
      delays: '0s, 100ms',
      iterations: 'infinite, 1',
    })])).toBe(800 + HtmlThumbnailLimits.AnimationSettleMs);
  });

  test('subtracts negative delay from the remaining finite animation time', () => {
    expect(getHtmlThumbnailAnimationWaitMs([timing({ delays: '-200ms' })])).toBe(
      800 + HtmlThumbnailLimits.AnimationSettleMs,
    );
    expect(getHtmlThumbnailAnimationWaitMs([timing({ delays: '-2s' })])).toBe(0);
  });

  test('waits for a delayed zero-duration reveal but not an immediate zero-duration animation', () => {
    expect(getHtmlThumbnailAnimationWaitMs([timing({ durations: '0s', delays: '1s' })])).toBe(
      1_000 + HtmlThumbnailLimits.AnimationSettleMs,
    );
    expect(getHtmlThumbnailAnimationWaitMs([timing({ durations: '0ms' })])).toBe(0);
  });

  test.each(['var(--duration)', 'calc(1s + 1s)', 'unknown', 'Infinitys', '100', '-1s'])('does not hold the queue for an invalid or unresolved duration %s', durations => {
    expect(getHtmlThumbnailAnimationWaitMs([timing({ durations })])).toBe(0);
  });

  test('skips unresolved delays without suppressing another finite animation', () => {
    expect(getHtmlThumbnailAnimationWaitMs([timing({ delays: 'var(--delay)' })])).toBe(0);
    expect(getHtmlThumbnailAnimationWaitMs([
      timing({ delays: 'var(--delay)' }),
      timing({ durations: '200ms' }),
    ])).toBe(200 + HtmlThumbnailLimits.AnimationSettleMs);
  });

  test.each([
    { durations: '10s', delays: '0s', iterations: '1' },
    { durations: '100ms', delays: '10s', iterations: '1' },
    { durations: '1s', delays: '0s', iterations: '1000000000' },
    { durations: '2.99s', delays: '0s', iterations: '1' },
  ])('caps snapshot delay including the settle margin for $durations + $delays × $iterations', options => {
    expect(getHtmlThumbnailAnimationWaitMs([timing(options)])).toBe(HtmlThumbnailLimits.AnimationTimeoutMs);
  });
});
