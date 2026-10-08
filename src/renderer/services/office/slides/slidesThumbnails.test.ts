import { describe, expect, test } from 'vitest';

import { thumbnailWidth } from './slidesThumbnails';

describe('thumbnail size', () => {
  test('thumbnails take a share of the editor width, within bounds', () => {
    expect(thumbnailWidth(1400)).toBe(150);
    expect(thumbnailWidth(760)).toBe(122);
    expect(thumbnailWidth(460)).toBe(74);
    expect(thumbnailWidth(180)).toBe(72);
  });
});
