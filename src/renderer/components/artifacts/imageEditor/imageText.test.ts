import { describe, expect, test } from 'vitest';

import { ImageEditorTool } from '../../../../shared/imageEditing/types';
import { imageTextBounds, imageTextBox, wrapImageText } from './imageText';

describe('image text layout', () => {
  test('normalizes reverse dragging without changing the region', () => {
    expect(imageTextBox({ x: 0.8, y: 0.6 }, { x: 0.2, y: 0.3 }, 1000, 1000))
      .toEqual({ x: 0.2, y: 0.3, width: 0.6000000000000001, height: 0.3 });
  });
  test('gives clicks and small drags a usable box inside the image, including at corners', () => {
    const box = imageTextBox({ x: 0.99, y: 0.99 }, { x: 0.99, y: 0.99 }, 400, 200);
    expect(box).toEqual({ x: 0.7, y: 0.8, width: 0.3, height: 0.2 });
    expect(imageTextBox({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, 80, 20))
      .toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });
  test('wraps Chinese, surrogate pairs, and explicit blank lines without dropping characters', () => {
    expect(wrapImageText('你好😀世界\n\nABCD', 3, text => Array.from(text).length)).toEqual(['你好😀', '世界', '', 'ABC', 'D']);
  });
  test('retains the fallback bounds for existing single-point text marks', () => {
    expect(imageTextBounds({ id: 'old', tool: ImageEditorTool.Text, points: [{ x: 0.25, y: 0.5 }],
      color: '#fff', width: 0.004, text: 'Existing text' })).toEqual({ x: 0.25, y: 0.5, width: 0.75, height: 0.5 });
  });
});
