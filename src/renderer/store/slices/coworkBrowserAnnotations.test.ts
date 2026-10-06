import { expect, test } from 'vitest';

import {
  BrowserAnnotationAnchorKind,
  BrowserAnnotationScreenshotStatus,
  type CoworkBrowserAnnotationBatch,
} from '../../../shared/cowork/browserAnnotations';
import reducer, {
  clearDraftBrowserAnnotationBatches,
  removeDraftBrowserAnnotationBatch,
  upsertDraftBrowserAnnotationBatch,
} from './coworkSlice';

const createBatch = (id: string): CoworkBrowserAnnotationBatch => ({
  version: 1,
  id,
  browserTabId: 'tab-1',
  documentId: 'doc-1',
  navigationVersion: 1,
  pageUrl: 'https://example.com',
  annotations: [{
    id: `annotation-${id}`,
    order: 0,
    comment: 'Update this',
    anchor: {
      kind: BrowserAnnotationAnchorKind.Element,
      pageUrl: 'https://example.com',
      framePath: [],
      rect: { x: 1, y: 2, width: 3, height: 4 },
      tagName: 'h1',
    },
    capture: {
      viewportWidth: 100,
      viewportHeight: 100,
      viewportScale: 1,
      zoomPercent: 100,
      scrollX: 0,
      scrollY: 0,
      targetRect: { x: 1, y: 2, width: 3, height: 4 },
    },
    screenshot: {
      status: BrowserAnnotationScreenshotStatus.Failed,
      reason: 'capture-failed',
      failedAt: 1,
    },
    createdAt: 1,
    updatedAt: 1,
  }],
  createdAt: 1,
  updatedAt: 1,
});

test('browser annotation draft batches can be upserted, removed, and cleared', () => {
  let state = reducer(undefined, upsertDraftBrowserAnnotationBatch({
    draftKey: 'session-1',
    batch: createBatch('one'),
  }));
  state = reducer(state, upsertDraftBrowserAnnotationBatch({
    draftKey: 'session-1',
    batch: createBatch('two'),
  }));
  expect(state.draftBrowserAnnotationBatches['session-1']).toHaveLength(2);

  state = reducer(state, removeDraftBrowserAnnotationBatch({
    draftKey: 'session-1',
    batchId: 'one',
  }));
  expect(state.draftBrowserAnnotationBatches['session-1']?.[0].id).toBe('two');

  state = reducer(state, clearDraftBrowserAnnotationBatches('session-1'));
  expect(state.draftBrowserAnnotationBatches['session-1']).toBeUndefined();
});
