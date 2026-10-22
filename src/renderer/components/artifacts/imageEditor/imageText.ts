import { imageRectangle } from '../../../../shared/imageEditing/geometry';
import type { ImageMark, ImagePoint } from '../../../../shared/imageEditing/types';

export function imageTextBox(start: ImagePoint, end: ImagePoint, displayWidth: number, displayHeight: number) {
  const rect = imageRectangle(start, end);
  const width = Math.min(1, Math.max(rect.width, 120 / displayWidth));
  const height = Math.min(1, Math.max(rect.height, 40 / displayHeight));
  return { x: Math.min(rect.x, 1 - width), y: Math.min(rect.y, 1 - height), width, height };
}

export function imageTextBounds(mark: ImageMark) {
  return imageRectangle(mark.points[0], mark.points[1] ?? { x: 1, y: 1 });
}

/** Character wrapping also supports Chinese and preserves explicit blank lines. */
export function wrapImageText(text: string, maxWidth: number, measure: (value: string) => number): string[] {
  return text.split('\n').flatMap(paragraph => {
    const lines: string[] = [];
    let line = '';
    for (const char of Array.from(paragraph)) {
      if (line && measure(line + char) > maxWidth) { lines.push(line); line = ''; }
      line += char;
    }
    lines.push(line);
    return lines;
  });
}
