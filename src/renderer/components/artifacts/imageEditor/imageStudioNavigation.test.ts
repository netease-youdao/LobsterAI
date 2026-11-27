import { describe, expect, test } from 'vitest';

import imageEditorReducer, {
  closeImageStudio,
  openImageStudio,
  selectImageStudioArtifact,
} from '../../../store/slices/imageEditorSlice';
import { type Artifact, ArtifactTypeValue } from '../../../types/artifact';
import {
  canNavigateStudioGalleryByKey,
  captureStudioViewportSnapshot,
  clampStudioZoom,
  computeStudioStageGeometry,
  getStudioArtifactCacheKey,
  normalizeStudioGallery,
  resolveStudioViewportScroll,
} from './imageStudioNavigation';

const makeImageArtifact = (id: string, overrides: Partial<Artifact> = {}): Artifact => ({
  id,
  sessionId: 'session-1',
  messageId: 'msg-1',
  type: ArtifactTypeValue.Image,
  title: `${id}.png`,
  fileName: `${id}.png`,
  filePath: `/tmp/${id}.png`,
  content: '',
  createdAt: 1000,
  ...overrides,
});

describe('imageStudioNavigation', () => {
  test('normalizes a studio gallery, deduplicates ids, and locates active artifact', () => {
    const a = makeImageArtifact('img-a');
    const b = makeImageArtifact('img-b');
    const c = makeImageArtifact('img-c');

    expect(normalizeStudioGallery(a)).toEqual({ items: [a], activeIndex: 0 });
    expect(normalizeStudioGallery(b, [a, b, b, c])).toEqual({ items: [a, b, c], activeIndex: 1 });
    // Matches by filePath if artifact id differs.
    const bClone = makeImageArtifact('img-b-copy', { filePath: '/tmp/img-b.png' });
    expect(normalizeStudioGallery(bClone, [a, b, c])).toEqual({ items: [a, b, c], activeIndex: 1 });
    // Prepends active artifact when missing from the supplied list.
    const d = makeImageArtifact('img-d');
    expect(normalizeStudioGallery(d, [a, b])).toEqual({ items: [d, a, b], activeIndex: 0 });
  });

  test('clamps studio zoom safely within editor limits', () => {
    expect(clampStudioZoom(0.1)).toBe(0.25);
    expect(clampStudioZoom(12)).toBe(8);
    expect(clampStudioZoom(2.5)).toBe(2.5);
    expect(clampStudioZoom(Number.NaN)).toBe(1);
  });

  test('captures centered viewport snapshot at fit zoom as (0.5, 0.5)', () => {
    const snapshot = captureStudioViewportSnapshot({
      imageWidth: 1024,
      imageHeight: 1024,
      viewportWidth: 1000,
      viewportHeight: 800,
      insetTop: 66,
      insetBottom: 130,
      horizontalGutter: 68,
      zoom: 1,
      scrollLeft: 0,
      scrollTop: 0,
    });
    expect(snapshot.zoom).toBe(1);
    expect(snapshot.centerX).toBeCloseTo(0.5, 6);
    expect(snapshot.centerY).toBeCloseTo(0.5, 6);
  });

  test('round-trips zoomed pan coordinates exactly across same-size images', () => {
    const baseMetrics = {
      imageWidth: 1024,
      imageHeight: 1024,
      viewportWidth: 1000,
      viewportHeight: 800,
      insetTop: 66,
      insetBottom: 130,
      horizontalGutter: 68,
    };
    const snapshot = captureStudioViewportSnapshot({
      ...baseMetrics,
      zoom: 3,
      scrollLeft: 700,
      scrollTop: 800,
    });
    const restored = resolveStudioViewportScroll(baseMetrics, snapshot);
    expect(restored.scrollLeft).toBeCloseTo(700, 6);
    expect(restored.scrollTop).toBeCloseTo(800, 6);
  });

  test('maps preserved focal point cleanly and clamps scroll when image dimensions differ', () => {
    const snapshot = captureStudioViewportSnapshot({
      imageWidth: 1024,
      imageHeight: 1024,
      viewportWidth: 1000,
      viewportHeight: 800,
      insetTop: 66,
      insetBottom: 130,
      horizontalGutter: 68,
      zoom: 2.5,
      scrollLeft: 520,
      scrollTop: 610,
    });

    const targetMetrics = {
      imageWidth: 2048,
      imageHeight: 1024,
      viewportWidth: 1000,
      viewportHeight: 800,
      insetTop: 66,
      insetBottom: 130,
      horizontalGutter: 68,
    };
    const geometry = computeStudioStageGeometry({ ...targetMetrics, zoom: snapshot.zoom });
    const restored = resolveStudioViewportScroll(targetMetrics, snapshot);
    expect(restored.scrollLeft).toBeGreaterThanOrEqual(0);
    expect(restored.scrollLeft).toBeLessThanOrEqual(Math.max(0, geometry.innerWidth - targetMetrics.viewportWidth));
    expect(restored.scrollTop).toBeGreaterThanOrEqual(0);
    expect(restored.scrollTop).toBeLessThanOrEqual(Math.max(0, geometry.innerHeight - targetMetrics.viewportHeight));

    // Re-capturing from the restored scroll should point at the same normalized region.
    const roundTrip = captureStudioViewportSnapshot({
      ...targetMetrics,
      zoom: snapshot.zoom,
      scrollLeft: restored.scrollLeft,
      scrollTop: restored.scrollTop,
    });
    expect(roundTrip.centerX).toBeCloseTo(snapshot.centerX, 3);
    expect(roundTrip.centerY).toBeCloseTo(snapshot.centerY, 3);
  });

  test('allows keyboard gallery navigation only in clean studio view mode', () => {
    const ready = {
      canNavigate: true,
      isTyping: false,
      isViewMode: true,
      hasVersionMenuOpen: false,
      isBusy: false,
      hasActiveDraft: false,
    };
    expect(canNavigateStudioGalleryByKey(ready)).toBe(true);
    expect(canNavigateStudioGalleryByKey({ ...ready, canNavigate: false })).toBe(false);
    expect(canNavigateStudioGalleryByKey({ ...ready, isTyping: true })).toBe(false);
    expect(canNavigateStudioGalleryByKey({ ...ready, isViewMode: false })).toBe(false);
    expect(canNavigateStudioGalleryByKey({ ...ready, hasVersionMenuOpen: true })).toBe(false);
    expect(canNavigateStudioGalleryByKey({ ...ready, isBusy: true })).toBe(false);
    expect(canNavigateStudioGalleryByKey({ ...ready, hasActiveDraft: true })).toBe(false);
  });

  test('builds cache keys sensitive to contentVersion and filePath', () => {
    const a = makeImageArtifact('img-1', { contentVersion: 1 });
    const b = makeImageArtifact('img-1', { contentVersion: 2 });
    expect(getStudioArtifactCacheKey(a)).not.toBe(getStudioArtifactCacheKey(b));
  });

  test('imageEditorSlice preserves gallery list when switching active studio artifact', () => {
    const a = makeImageArtifact('img-a');
    const b = makeImageArtifact('img-b');
    let state = imageEditorReducer(undefined, openImageStudio({ artifact: a, artifacts: [a, b] }));
    expect(state.studio?.artifact.id).toBe('img-a');
    expect(state.studio?.artifacts?.map((item) => item.id)).toEqual(['img-a', 'img-b']);

    state = imageEditorReducer(state, selectImageStudioArtifact(b));
    expect(state.studio?.artifact.id).toBe('img-b');
    expect(state.studio?.artifacts?.map((item) => item.id)).toEqual(['img-a', 'img-b']);

    state = imageEditorReducer(state, closeImageStudio());
    expect(state.studio).toBeUndefined();
  });
});
