import { describe, expect, test } from 'vitest';

import {
  MEDIA_MODEL_LIST_MAX_HEIGHT,
  MEDIA_MODEL_LOADING_ROWS,
  MEDIA_MODEL_MIN_VISIBLE_ROWS,
  MEDIA_MODEL_ROW_HEIGHT,
  MEDIA_PANEL_EDGE_MARGIN,
  resolveMediaModelListFloorHeight,
  resolveMediaModelListMinHeight,
  resolveMediaPanelMaxHeight,
} from './mediaModelListLayout';

describe('resolveMediaModelListMinHeight', () => {
  test('sizes both tabs for the longer list', () => {
    const moreImageModels = resolveMediaModelListMinHeight({ image: 6, video: 2 }, false);
    const moreVideoModels = resolveMediaModelListMinHeight({ image: 2, video: 6 }, false);
    expect(moreImageModels).toBe(6 * MEDIA_MODEL_ROW_HEIGHT + 8);
    expect(moreVideoModels).toBe(moreImageModels);
  });

  test('keeps one row for the empty-list message', () => {
    expect(resolveMediaModelListMinHeight({ image: 0, video: 0 }, false)).toBe(MEDIA_MODEL_ROW_HEIGHT + 8);
  });

  test('holds a few rows open while the first list loads', () => {
    expect(resolveMediaModelListMinHeight({ image: 0, video: 0 }, true))
      .toBe(MEDIA_MODEL_LOADING_ROWS * MEDIA_MODEL_ROW_HEIGHT + 8);
  });

  test('caps the height where the list starts scrolling', () => {
    expect(resolveMediaModelListMinHeight({ image: 20, video: 3 }, false)).toBe(MEDIA_MODEL_LIST_MAX_HEIGHT);
  });
});

describe('resolveMediaModelListFloorHeight', () => {
  test('keeps a few rows of a long list', () => {
    expect(resolveMediaModelListFloorHeight(MEDIA_MODEL_LIST_MAX_HEIGHT))
      .toBe(MEDIA_MODEL_MIN_VISIBLE_ROWS * MEDIA_MODEL_ROW_HEIGHT + 8);
  });

  test('never asks a short list for more than its own height', () => {
    const oneRow = MEDIA_MODEL_ROW_HEIGHT + 8;
    expect(resolveMediaModelListFloorHeight(oneRow)).toBe(oneRow);
  });
});

describe('resolveMediaPanelMaxHeight', () => {
  test('fits the panel between its bottom edge and the clipping edge', () => {
    // Panel bottom at 463px, home scroller top at 82px.
    expect(resolveMediaPanelMaxHeight(463, 82)).toBe(463 - 82 - MEDIA_PANEL_EDGE_MARGIN);
  });

  test('rounds fractional edges down so the panel never overshoots', () => {
    expect(resolveMediaPanelMaxHeight(400.6, 0)).toBe(392);
  });

  test('never returns a negative height', () => {
    expect(resolveMediaPanelMaxHeight(50, 60)).toBe(0);
  });
});
