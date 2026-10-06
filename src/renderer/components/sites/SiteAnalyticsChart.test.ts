import { describe, expect, test } from 'vitest';

import { smoothPath } from './SiteAnalyticsChart';

describe('smoothPath', () => {
  test('keeps curve control points within each segment value range', () => {
    const points: Array<[number, number]> = [
      [0, 100],
      [1, 100],
      [2, 0],
      [3, 100],
    ];
    const path = smoothPath(points);
    const segments = [...path.matchAll(/C\s+\S+\s+(\S+),\s+\S+\s+(\S+),\s+\S+\s+(\S+)/g)];

    expect(segments).toHaveLength(points.length - 1);
    segments.forEach((segment, index) => {
      const minY = Math.min(points[index][1], points[index + 1][1]);
      const maxY = Math.max(points[index][1], points[index + 1][1]);
      expect(Number(segment[1])).toBeGreaterThanOrEqual(minY);
      expect(Number(segment[1])).toBeLessThanOrEqual(maxY);
      expect(Number(segment[2])).toBeGreaterThanOrEqual(minY);
      expect(Number(segment[2])).toBeLessThanOrEqual(maxY);
      expect(Number(segment[3])).toBe(points[index + 1][1]);
    });
  });
});
