import { describe, expect, test } from 'vitest';

import {
  clampZoomScale,
  createZoomAnchor,
  getAnchoredScrollDelta,
  getWheelZoomScale,
  getZoomedSize,
  MAX_ZOOM_SCALE,
  MIN_ZOOM_SCALE,
  resolveSvgIntrinsicSize,
  stepZoomScale,
} from './zoomPan';

describe('zoom scale', () => {
  test('clamps to the supported range', () => {
    expect(clampZoomScale(0.01)).toBe(MIN_ZOOM_SCALE);
    expect(clampZoomScale(9)).toBe(MAX_ZOOM_SCALE);
    expect(clampZoomScale(1.6)).toBe(1.6);
  });

  test('one wheel notch zooms about 10% and the opposite notch undoes it', () => {
    const zoomedIn = getWheelZoomScale(1, -100);
    expect(zoomedIn).toBeCloseTo(Math.exp(0.1));
    expect(getWheelZoomScale(zoomedIn, 100)).toBeCloseTo(1);
  });

  test('small pinch deltas are applied without the per-notch cap', () => {
    expect(getWheelZoomScale(2, -4)).toBeCloseTo(2 * Math.exp(0.04));
  });

  test('wheel zoom stops at the limits', () => {
    expect(getWheelZoomScale(MAX_ZOOM_SCALE, -100)).toBe(MAX_ZOOM_SCALE);
    expect(getWheelZoomScale(MIN_ZOOM_SCALE, 100)).toBe(MIN_ZOOM_SCALE);
  });

  test('button steps do not accumulate floating point drift', () => {
    let scale = 1;
    for (let i = 0; i < 9; i += 1) scale = stepZoomScale(scale, -1);
    expect(scale).toBe(MIN_ZOOM_SCALE);
    expect(stepZoomScale(1.2, 1)).toBe(1.3);
    expect(stepZoomScale(MAX_ZOOM_SCALE, 1)).toBe(MAX_ZOOM_SCALE);
  });
});

describe('zoom anchor', () => {
  test('keeps the point under the pointer in place after zooming', () => {
    const before = { left: 16, top: 16, width: 600, height: 400 };
    const anchor = createZoomAnchor({ clientX: 166, clientY: 116 }, before);
    expect(anchor).toEqual({ clientX: 166, clientY: 116, ratioX: 0.25, ratioY: 0.25 });

    // Doubled in size while the scroll position is still at the origin.
    const after = { left: 16, top: 16, width: 1200, height: 800 };
    expect(getAnchoredScrollDelta(anchor!, after)).toEqual({ x: 150, y: 100 });
  });

  test('works for points outside the content, e.g. the margin around a small image', () => {
    const anchor = createZoomAnchor({ clientX: 0, clientY: 0 }, { left: 100, top: 100, width: 200, height: 100 });
    expect(anchor).toMatchObject({ ratioX: -0.5, ratioY: -1 });
  });

  test('cannot anchor to empty content', () => {
    expect(createZoomAnchor({ clientX: 10, clientY: 10 }, { left: 0, top: 0, width: 0, height: 0 })).toBeNull();
  });
});

describe('getZoomedSize', () => {
  test('fits wide content to the available width at 100%', () => {
    expect(getZoomedSize({ intrinsicWidth: 1600, aspectRatio: 1.6, availableWidth: 600, scale: 1 }))
      .toEqual({ width: 600, height: 375 });
  });

  test('never upscales small content at 100%', () => {
    expect(getZoomedSize({ intrinsicWidth: 240, aspectRatio: 1.5, availableWidth: 600, scale: 1 }))
      .toEqual({ width: 240, height: 160 });
  });

  test('scales the fitted size', () => {
    expect(getZoomedSize({ intrinsicWidth: 1600, aspectRatio: 1.6, availableWidth: 600, scale: 1.5 }))
      .toEqual({ width: 900, height: 562.5 });
  });

  test('content without an intrinsic width fills the available width', () => {
    expect(getZoomedSize({ intrinsicWidth: null, aspectRatio: 2, availableWidth: 600, scale: 1 }))
      .toEqual({ width: 600, height: 300 });
  });

  test('returns null until both the content and the viewport are measured', () => {
    expect(getZoomedSize({ intrinsicWidth: 100, aspectRatio: 1, availableWidth: 0, scale: 1 })).toBeNull();
    expect(getZoomedSize({ intrinsicWidth: 100, aspectRatio: Number.NaN, availableWidth: 600, scale: 1 })).toBeNull();
  });
});

describe('resolveSvgIntrinsicSize', () => {
  test('uses the Mermaid max-width as the natural width', () => {
    expect(resolveSvgIntrinsicSize({
      width: '100%',
      height: null,
      viewBox: '-8 -8 1124 147',
      maxWidth: '1124px',
    })).toEqual({ width: 1124, aspectRatio: 1124 / 147, fallbackViewBox: null });
  });

  test('prefers declared width and height', () => {
    expect(resolveSvgIntrinsicSize({ width: '1200', height: '800', viewBox: '0 0 100 100' }))
      .toEqual({ width: 1200, aspectRatio: 1.5, fallbackViewBox: null });
  });

  test('converts absolute units such as Graphviz points to px', () => {
    const size = resolveSvgIntrinsicSize({ width: '300pt', height: '150pt', viewBox: '0.00 0.00 300.00 150.00' });
    expect(size.width).toBeCloseTo(400);
    expect(size.aspectRatio).toBeCloseTo(2);
  });

  test('derives the width from the height and viewBox', () => {
    expect(resolveSvgIntrinsicSize({ width: null, height: '200', viewBox: '0,0,400,100' }))
      .toEqual({ width: 800, aspectRatio: 4, fallbackViewBox: null });
  });

  test('fills the available width when only a viewBox or a relative width is given', () => {
    expect(resolveSvgIntrinsicSize({ width: null, height: null, viewBox: '0 0 1200 800' }))
      .toEqual({ width: null, aspectRatio: 1.5, fallbackViewBox: null });
    expect(resolveSvgIntrinsicSize({ width: '100%', height: '50em', viewBox: '0 0 400 300' }))
      .toEqual({ width: null, aspectRatio: 4 / 3, fallbackViewBox: null });
  });

  test('adds a viewBox so SVGs without one still scale', () => {
    expect(resolveSvgIntrinsicSize({ width: '300', height: '200px', viewBox: null }))
      .toEqual({ width: 300, aspectRatio: 1.5, fallbackViewBox: '0 0 300 200' });
    expect(resolveSvgIntrinsicSize({ width: null, height: null, viewBox: '0 0 0 10' }))
      .toEqual({ width: 300, aspectRatio: 2, fallbackViewBox: '0 0 300 150' });
  });
});
