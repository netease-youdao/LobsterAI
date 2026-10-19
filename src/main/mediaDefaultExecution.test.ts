import { expect, test } from 'vitest';

import { type MediaDefaultModel,MediaType } from '../shared/media/defaultPolicy';
import { applyMediaDefaultParameters, MediaDefaultImageBudget } from './mediaDefaultExecution';

const defaults = (): MediaDefaultModel => ({
  enabled: true, modelId: 'image-default', modelName: 'Image', params: { size: '2K', n: 1 }, maxOutputsPerTurn: 1,
});

test('default image requests cannot multiply output counts or enable sequential generation', () => {
  expect(applyMediaDefaultParameters({ count: 8, n: 5, sequential_image_generation: 'auto', images: ['ref'] },
    defaults(), MediaType.Image)).toEqual({ size: '2K', count: 1, n: 1, sequential_image_generation: 'disabled', images: ['ref'] });
  expect(applyMediaDefaultParameters({ n: 3 }, undefined, MediaType.Image)).toEqual({ n: 3 });
});

test('video defaults fill missing settings; explicit settings remain visible in confirmation', () => {
  const video = { ...defaults(), params: { resolution: '720p', durationSeconds: 5 } };
  expect(applyMediaDefaultParameters({}, video, MediaType.Video)).toEqual(video.params);
  expect(applyMediaDefaultParameters({ durationSeconds: 10 }, video, MediaType.Video).durationSeconds).toBe(10);
});

test('a root and its descendants share a single automatic image allowance', () => {
  const budget = new MediaDefaultImageBudget();
  const rootSnapshot = defaults();
  expect(budget.needsConfirmation(rootSnapshot, 'root-call')).toBe(false);
  expect(budget.needsConfirmation(rootSnapshot, 'subagent-call')).toBe(true);
  expect(budget.needsConfirmation(rootSnapshot, 'subagent-call')).toBe(true); // A denied/retried call cannot bypass confirmation.
  expect(budget.needsConfirmation(rootSnapshot, 'root-call')).toBe(false);
  expect(budget.needsConfirmation(defaults(), 'new-turn')).toBe(false);
  expect(budget.needsConfirmation(undefined, 'manual-selection')).toBe(false);
});

test('a trusted two-asset skin workflow receives two serial automatic attempts', () => {
  const budget = new MediaDefaultImageBudget();
  const skin = { ...defaults(), maxOutputsPerTurn: 2 };
  expect(budget.needsConfirmation(skin, 'backdrop')).toBe(false);
  expect(budget.needsConfirmation(skin, 'emblem')).toBe(false);
  expect(budget.needsConfirmation(skin, 'extra-retry')).toBe(true);
});
