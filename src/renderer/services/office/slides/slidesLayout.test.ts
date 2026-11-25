import { describe, expect, test } from 'vitest';

import {
  resolveFitZoom,
  resolveHorizontalThumbSize,
  resolvePresentationScale,
  resolveSlidesThumbLayout,
  resolveSlidesToolbarDensity,
  resolveStagePadding,
  SLIDES_COMPACT_STAGE_BREAKPOINT_PX,
  SLIDES_MIN_FIT_ZOOM,
  SLIDES_TOOLBAR_COMPACT_WIDTH_PX,
  SLIDES_TOOLBAR_MINIMAL_WIDTH_PX,
  SLIDES_WIDE_BREAKPOINT_PX,
  SLIDES_ZOOM_LIMITS,
  SlidesThumbLayout,
  SlidesToolbarDensity,
  stepSlideIndex,
} from './slidesLayout';

describe('slidesLayout', () => {
  test('uses bottom filmstrip below wide breakpoint and left rail at or above it', () => {
    expect(resolveSlidesThumbLayout(380)).toBe(SlidesThumbLayout.Bottom);
    expect(resolveSlidesThumbLayout(SLIDES_WIDE_BREAKPOINT_PX - 1)).toBe(SlidesThumbLayout.Bottom);
    expect(resolveSlidesThumbLayout(SLIDES_WIDE_BREAKPOINT_PX)).toBe(SlidesThumbLayout.Left);
    expect(resolveSlidesThumbLayout(1280)).toBe(SlidesThumbLayout.Left);
  });

  test('tightens stage padding in narrow split panes and restores full padding on wider stages', () => {
    expect(resolveStagePadding(420)).toEqual({ x: 12, y: 16 });
    expect(resolveStagePadding(SLIDES_COMPACT_STAGE_BREAKPOINT_PX - 1)).toEqual({ x: 12, y: 16 });
    expect(resolveStagePadding(SLIDES_COMPACT_STAGE_BREAKPOINT_PX)).toEqual({ x: 24, y: 24 });
    expect(resolveStagePadding(0)).toEqual({ x: 24, y: 24 });
  });

  test('computes fit zoom floored to 0.01 within configured bounds', () => {
    // 440px split pane with 12px horizontal padding -> 416px available for a 960x540 slide
    expect(resolveFitZoom({ width: 960, height: 540 }, { width: 440, height: 600 }, { x: 12, y: 16 })).toBe(0.43);
    // Very narrow stage floors at SLIDES_MIN_FIT_ZOOM
    expect(resolveFitZoom({ width: 1920, height: 1080 }, { width: 120, height: 120 }, { x: 12, y: 16 })).toBe(SLIDES_MIN_FIT_ZOOM);
    // Huge stage caps at max zoom
    expect(resolveFitZoom({ width: 100, height: 50 }, { width: 2000, height: 2000 }, { x: 24, y: 24 })).toBe(SLIDES_ZOOM_LIMITS.max);
    // Degenerate inputs return undefined
    expect(resolveFitZoom({ width: 960, height: 540 }, { width: 20, height: 200 }, { x: 12, y: 16 })).toBeUndefined();
  });

  test('computes horizontal filmstrip thumbnail size preserving aspect ratio within bounds', () => {
    expect(resolveHorizontalThumbSize({ width: 960, height: 540 })).toEqual({ width: 96, height: 54 });
    expect(resolveHorizontalThumbSize({ width: 800, height: 600 })).toEqual({ width: 72, height: 54 });
    // Ultra-wide slides cap width at 112px
    const ultraWide = resolveHorizontalThumbSize({ width: 3200, height: 900 });
    expect(ultraWide.width).toBe(112);
    expect(ultraWide.height).toBeGreaterThanOrEqual(36);
    // Portrait slides keep at least 64px width
    const portrait = resolveHorizontalThumbSize({ width: 540, height: 960 });
    expect(portrait.width).toBe(64);
  });

  test('scales presentation slides to fit viewport without distortion', () => {
    expect(resolvePresentationScale({ width: 960, height: 540 }, { width: 1920, height: 1080 })).toBe(2);
    expect(resolvePresentationScale({ width: 960, height: 540 }, { width: 1440, height: 900 })).toBe(1.5);
    expect(resolvePresentationScale({ width: 0, height: 540 }, { width: 1920, height: 1080 })).toBe(1);
  });

  test('clamps slide index stepping safely', () => {
    expect(stepSlideIndex(0, -1, 6)).toBe(0);
    expect(stepSlideIndex(2, 1, 6)).toBe(3);
    expect(stepSlideIndex(5, 1, 6)).toBe(5);
    expect(stepSlideIndex(0, 1, 0)).toBe(-1);
  });

  test('selects single-row toolbar density tier from editor width', () => {
    expect(resolveSlidesToolbarDensity(0)).toBe(SlidesToolbarDensity.Full);
    expect(resolveSlidesToolbarDensity(SLIDES_TOOLBAR_COMPACT_WIDTH_PX)).toBe(SlidesToolbarDensity.Full);
    expect(resolveSlidesToolbarDensity(SLIDES_TOOLBAR_COMPACT_WIDTH_PX - 1)).toBe(SlidesToolbarDensity.Compact);
    expect(resolveSlidesToolbarDensity(SLIDES_TOOLBAR_MINIMAL_WIDTH_PX)).toBe(SlidesToolbarDensity.Compact);
    expect(resolveSlidesToolbarDensity(SLIDES_TOOLBAR_MINIMAL_WIDTH_PX - 1)).toBe(SlidesToolbarDensity.Minimal);
  });
});
