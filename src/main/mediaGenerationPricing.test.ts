import { describe, expect, test } from 'vitest';

import { calculatePerSecondIoCredits, type MediaPricingConfig } from './mediaGenerationPricing';

const h3Pricing: MediaPricingConfig = {
  billingUnit: 'per_second_io',
  freeInputImageCount: 5,
  inputImageCostYuan: 0.2,
  defaultInputVideoDurationForEstimate: 15,
  defaultParams: { duration: 5, resolution: '768P' },
  tiers: [
    { resolution: '768p', costYuan: 0.5 },
    { resolution: '2k', costYuan: 0.8 },
  ],
};

describe('calculatePerSecondIoCredits', () => {
  test('prices MiniMax H3 output seconds by resolution', () => {
    expect(calculatePerSecondIoCredits(h3Pricing, { resolution: '2K', durationSeconds: 6 })).toBe(480);
  });

  test('includes conservative reference-video seconds and excess images', () => {
    expect(calculatePerSecondIoCredits(h3Pricing, {
      resolution: '768P',
      durationSeconds: 5,
      videos: ['reference.mp4'],
      images: ['1', '2', '3', '4', '5', '6'],
    })).toBe(1020);
  });

  test('uses supplied reference-video durations when available', () => {
    expect(calculatePerSecondIoCredits(h3Pricing, {
      resolution: '768P',
      durationSeconds: 5,
      videos: ['a.mp4', 'b.mp4'],
      referenceVideoDurations: [2, 3],
    })).toBe(500);
  });

  test('counts provider-native reference media without double-counting image URLs', () => {
    expect(calculatePerSecondIoCredits(h3Pricing, {
      resolution: '768P',
      durationSeconds: 5,
      images: ['1', '2', '3', '4', '5', '6'],
      providerOptions: {
        media: [
          { type: 'reference_image', url: '6' },
          { type: 'reference_video', url: 'reference.mp4' },
        ],
      },
      referenceVideoDuration: 3,
    })).toBe(420);
  });
});
