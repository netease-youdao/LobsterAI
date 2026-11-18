import { describe, expect, test } from 'vitest';

import { estimateVideoCredits, VideoBillingUnit } from './videoCreditEstimate';

describe('video confirmation credit estimates', () => {
  const hailuo = {
    billingUnit: VideoBillingUnit.Video, defaultParams: { resolution: '768P', duration: 6 },
    tiers: [
      { resolution: '768p', duration: 6, costYuan: 2 },
      { resolution: '768p', duration: 10, costYuan: 4 },
      { resolution: '1080p', duration: 6, costYuan: 3.5 },
    ],
  };
  test('matches actual request resolution/duration rather than a fixed per-second guess', () => {
    expect(estimateVideoCredits(hailuo, {})).toBe(200);
    expect(estimateVideoCredits(hailuo, { durationSeconds: 10 })).toBe(400);
    expect(estimateVideoCredits(hailuo, { resolution: '1080P' })).toBe(350);
    expect(estimateVideoCredits(hailuo, { resolution: '1080P', durationSeconds: 10 })).toBeUndefined();
  });
  test('supports catalogue per-second rates and parameter defaults', () => {
    const pricing = { billingUnit: VideoBillingUnit.Second, parameterSpec: { duration: { default: 5 }, resolution: { default: '1080P' } }, tiers: [{ resolution: '1080p', costYuan: 1.2 }] };
    expect(estimateVideoCredits(pricing, {})).toBe(600);
    expect(estimateVideoCredits(pricing, { durationSeconds: 3 })).toBe(360);
    expect(estimateVideoCredits({ ...pricing, billingUnit: VideoBillingUnit.SecondIo }, {})).toBe(600);
    expect(estimateVideoCredits({ ...pricing, billingUnit: VideoBillingUnit.SecondIo }, { images: ['image.png'] })).toBeUndefined();
  });
  test('uses the server output-token formula with the selected tier', () => {
    const pricing = { billingUnit: VideoBillingUnit.Token, defaultFps: 24, tiers: [
      { resolution: '720p', hasVideoInput: false, pricePerMillionTokens: 46 },
      { resolution: '720p', hasVideoInput: true, pricePerMillionTokens: 28 },
    ] };
    expect(estimateVideoCredits(pricing, { durationSeconds: 5, resolution: '720P' })).toBe(496.8);
    expect(estimateVideoCredits(pricing, { durationSeconds: 5, resolution: '720p', videos: ['reference.mp4'] })).toBeUndefined();
    expect(estimateVideoCredits(pricing, { durationSeconds: -1, resolution: '720p' })).toBeUndefined();
  });
  test('does not invent totals for ambiguous, unsupported or malformed pricing', () => {
    expect(estimateVideoCredits(null, {})).toBeUndefined();
    expect(estimateVideoCredits({ ...hailuo, tiers: [...hailuo.tiers, hailuo.tiers[0]] }, {})).toBeUndefined();
    expect(estimateVideoCredits(hailuo, { durationSeconds: 'bad' })).toBeUndefined();
    expect(estimateVideoCredits(hailuo, { providerOptions: { duration: 10 } })).toBeUndefined();
    expect(estimateVideoCredits(hailuo, { media: [{ type: 'reference_video' }] })).toBeUndefined();
  });
});
