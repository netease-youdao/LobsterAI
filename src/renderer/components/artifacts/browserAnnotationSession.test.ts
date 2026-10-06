import { expect, test } from 'vitest';

import type { CoworkBrowserAnnotationBatch } from '../../../shared/cowork/browserAnnotations';
import { resolveRemovedActiveBrowserAnnotationBatch } from './browserAnnotationSession';

const previousBatch = { id: 'batch-1' } as CoworkBrowserAnnotationBatch;
const nextBatch = { id: 'batch-2' } as CoworkBrowserAnnotationBatch;

test('returns the active browser annotation batch when it is removed externally', () => {
  expect(resolveRemovedActiveBrowserAnnotationBatch(previousBatch, undefined, true))
    .toBe(previousBatch);
});

test('keeps the annotation session when a current batch still exists', () => {
  expect(resolveRemovedActiveBrowserAnnotationBatch(previousBatch, nextBatch, true))
    .toBeUndefined();
});

test('ignores batch removal after annotation mode has already stopped', () => {
  expect(resolveRemovedActiveBrowserAnnotationBatch(previousBatch, undefined, false))
    .toBeUndefined();
});
