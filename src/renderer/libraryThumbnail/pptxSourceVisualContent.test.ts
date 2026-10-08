import { describe, expect, test } from 'vitest';

import { analyzePptxFirstSlideSource } from './pptxSourceVisualContent';

describe('PPTX first-slide source visual analysis', () => {
  test('keeps an empty placeholder slide classified as intentionally blank', () => {
    const result = analyzePptxFirstSlideSource({
      slides: [{
        background: { type: 'none' },
        nodes: [{
          background: { type: 'none' },
          border: { type: 'none' },
          extend: { w: 400, h: 100 },
          source: { 'p:nvSpPr': { 'p:nvPr': { 'p:ph': { attrs: { type: 'title' } } } } },
        }],
      }],
    });

    expect(result).toEqual({
      sourceHasVisualContent: false,
      sourceVisualElementCount: 0,
    });
  });

  test('detects non-empty slide text independently from rendered DOM', () => {
    const result = analyzePptxFirstSlideSource({
      slides: [{
        nodes: [{
          source: { 'p:txBody': { 'a:p': { 'a:r': { 'a:t': 'Quarterly report' } } } },
        }],
      }],
    });

    expect(result.sourceHasVisualContent).toBe(true);
    expect(result.sourceVisualElementCount).toBe(1);
  });

  test('detects pictures even when the renderer has not produced an image element', () => {
    const result = analyzePptxFirstSlideSource({
      slides: [{
        nodes: [{ path: 'ppt/media/image1.png', source: {} }],
      }],
    });

    expect(result.sourceHasVisualContent).toBe(true);
  });

  test('includes user-drawn layout and master visuals but ignores inherited placeholders', () => {
    const result = analyzePptxFirstSlideSource({
      slides: [{
        nodes: [],
        slideLayout: {
          background: { type: 'none' },
          nodes: [
            {
              userDrawn: false,
              background: { type: 'solidFill', color: '#222222' },
            },
            {
              userDrawn: true,
              background: { type: 'solidFill', color: '#222222' },
            },
          ],
        },
      }],
    });

    expect(result.sourceHasVisualContent).toBe(true);
    expect(result.sourceVisualElementCount).toBe(1);
  });

  test('treats a white background by itself as an intentional blank slide', () => {
    const result = analyzePptxFirstSlideSource({
      slides: [{ background: { type: 'solidFill', color: '#ffffff' }, nodes: [] }],
    });

    expect(result.sourceHasVisualContent).toBe(false);
  });

  test('detects a non-white or image background', () => {
    expect(analyzePptxFirstSlideSource({
      slides: [{ background: { type: 'solidFill', color: '#112244' }, nodes: [] }],
    }).sourceHasVisualContent).toBe(true);
    expect(analyzePptxFirstSlideSource({
      slides: [{ background: { type: 'blipFill' }, nodes: [] }],
    }).sourceHasVisualContent).toBe(true);
  });
});
