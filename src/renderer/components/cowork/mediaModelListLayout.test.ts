import { describe, expect, test } from 'vitest';

import {
  MEDIA_MODEL_LIST_MAX_HEIGHT,
  MEDIA_MODEL_LOADING_ROWS,
  MEDIA_MODEL_ROW_HEIGHT,
  resolveMediaModelListMinHeight,
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
