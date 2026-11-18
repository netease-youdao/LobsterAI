import { describe, expect, test } from 'vitest';

import { fromUniverStyle, toUniverStyle, XlsxStyles } from './xlsxStyles';

describe('theme colors', () => {
  test('the palette lists each theme color over its lighter and darker variants, as Excel does', () => {
    const grid = new XlsxStyles(undefined, undefined, 'zh').themeColorGrid();
    expect(grid).toHaveLength(10);
    expect(grid.every(column => column.length === 6)).toBe(true);
    // Background 1 (white) darkens by 5–50%; text 1 (black) lightens by 50–5%.
    expect(grid[0]).toEqual(['#FFFFFF', '#F2F2F2', '#D9D9D9', '#BFBFBF', '#A6A6A6', '#808080']);
    expect(grid[1]).toEqual(['#000000', '#808080', '#595959', '#404040', '#262626', '#0D0D0D']);
    // Accents: lighter 80%, 60%, 40%, then darker 25% and 50%.
    expect(grid[4][0]).toBe('#4472C4');
    expect(grid[4].slice(1).map(color => Number.parseInt(color.slice(1, 3), 16))).toEqual([...grid[4].slice(1).map(color => Number.parseInt(color.slice(1, 3), 16))].sort((a, b) => b - a));
  });
});

describe('text rotation', () => {
  const aligned = (rotation?: number) => ({ ...fromUniverStyle({}), alignment: { wrap: false, shrink: false, rotation } });

  test('Excel\'s counterclockwise angles turn Univer\'s way, and back', () => {
    // Excel: 1–90 rises counterclockwise, 91–180 falls clockwise; Univer turns clockwise for positive angles.
    expect(toUniverStyle(aligned(45)).tr).toEqual({ a: -45 });
    expect(toUniverStyle(aligned(135)).tr).toEqual({ a: 45 });
    expect(toUniverStyle(aligned(90)).tr).toEqual({ a: -90 });
    expect(toUniverStyle(aligned(180)).tr).toEqual({ a: 90 });
    expect(toUniverStyle(aligned(255)).tr).toEqual({ a: 0, v: 1 });
    for (const rotation of [1, 45, 90, 91, 135, 180, 255]) {
      expect(fromUniverStyle(toUniverStyle(aligned(rotation))).alignment.rotation).toBe(rotation);
    }
    expect(fromUniverStyle({ tr: { a: -30, v: 0 } }).alignment.rotation).toBe(30);
    expect(fromUniverStyle({ tr: { a: 30, v: 0 } }).alignment.rotation).toBe(120);
    expect(fromUniverStyle({ tr: { a: 0, v: 0 } }).alignment.rotation).toBeUndefined();
  });
});
