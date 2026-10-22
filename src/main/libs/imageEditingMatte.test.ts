import { describe, expect, test } from 'vitest';

import { applyForegroundMatte } from './imageEditingMatte';

describe('foreground matte output', () => {
  test('preserves source color and existing transparency, adding real alpha for the background', () => {
    const source = new Uint8Array([30, 60, 90, 255, 40, 70, 100, 150, 50, 80, 110, 255]);
    const matte = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255, 128, 128, 128, 255]);
    const output = applyForegroundMatte(source, matte, 3);
    expect([...output.slice(0, 4)]).toEqual([0, 0, 0, 0]);
    expect([...output.slice(4, 8)]).toEqual([40, 70, 100, 150]);
    expect(output[11]).toBeGreaterThan(0); expect(output[11]).toBeLessThan(255);
    expect(output[8] / output[11]).toBeCloseTo(source[8] / source[11], 2);
    expect(source[3]).toBe(255);
  });
  test('removes faint background texture and keeps near-white foreground opaque', () => {
    const source = new Uint8Array([20, 60, 90, 255, 40, 70, 100, 255, 50, 80, 110, 255, 10, 20, 30, 255]);
    const matte = new Uint8Array([0, 0, 0, 255, 26, 26, 26, 255, 240, 240, 240, 255, 255, 255, 255, 255]);
    const output = applyForegroundMatte(source, matte, 4);
    expect(output.slice(0, 8)).toEqual(new Uint8Array(8));
    expect(output.slice(8)).toEqual(source.slice(8));
  });
  test('rejects an opaque blank, color photograph, or mismatched mask instead of reporting a cutout', () => {
    expect(() => applyForegroundMatte(new Uint8Array(8), new Uint8Array(8).fill(255), 2)).toThrow('imageEditMaskInvalid');
    expect(() => applyForegroundMatte(new Uint8Array(8), new Uint8Array([0, 0, 255, 255, 255, 255, 255, 255]), 2)).toThrow('imageEditMaskInvalid');
    expect(() => applyForegroundMatte(new Uint8Array(8), new Uint8Array(4), 2)).toThrow();
  });
  test('cleans isolated gray background lines while preserving soft edges and separate white subjects', () => {
    const width = 12;
    const source = new Uint8Array(width * 8 * 4).fill(255);
    const matte = new Uint8Array(source.length);
    for (let x = 0; x < width; x++) matte.fill(70, (width * 4 + x) * 4, (width * 4 + x) * 4 + 3);
    for (const p of [width * 4 + 5, width * 7 + 11]) matte.fill(255, p * 4, p * 4 + 4);
    const output = applyForegroundMatte(source, matte, width);
    expect(output[(width * 4 + 1) * 4 + 3]).toBe(0);
    expect(output[(width * 4 + 4) * 4 + 3]).toBeGreaterThan(0);
    expect(output[(width * 4 + 5) * 4 + 3]).toBe(255);
    expect(output[(width * 7 + 11) * 4 + 3]).toBe(255);
  });
});
