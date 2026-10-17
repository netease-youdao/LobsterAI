import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  moveScreenshotSelection, renderScreenshotCrop, resizeScreenshotSelection, type ScreenshotAnnotation,
screenshotContains,
  ScreenshotHandle, ScreenshotTool, translateScreenshotAnnotations, } from './screenshotAnnotation';

const rect = { x: 100, y: 80, width: 200, height: 120 };
const bounds = { width: 800, height: 600 };

describe('screenshot selection editing', () => {
  test('moving remains inside the captured display and retains its size', () => {
    expect(moveScreenshotSelection(rect, { x: -500, y: 900 }, bounds))
      .toEqual({ x: 0, y: 480, width: 200, height: 120 });
  });

  test('all eight handles preserve the opposite edges', () => {
    const at = { x: 150, y: 100 };
    const results = {
      [ScreenshotHandle.NW]: { x: 150, y: 100, width: 150, height: 100 },
      [ScreenshotHandle.N]: { x: 100, y: 100, width: 200, height: 100 },
      [ScreenshotHandle.NE]: { x: 100, y: 100, width: 50, height: 100 },
      [ScreenshotHandle.E]: { x: 100, y: 80, width: 50, height: 120 },
      [ScreenshotHandle.SE]: { x: 100, y: 80, width: 50, height: 20 },
      [ScreenshotHandle.S]: { x: 100, y: 80, width: 200, height: 20 },
      [ScreenshotHandle.SW]: { x: 150, y: 80, width: 150, height: 20 },
      [ScreenshotHandle.W]: { x: 150, y: 80, width: 150, height: 120 },
    };
    for (const handle of Object.values(ScreenshotHandle)) {
      expect(resizeScreenshotSelection(rect, handle, at, bounds)).toEqual(results[handle]);
    }
  });

  test('resize clamps to display edges and never crosses the opposite handle', () => {
    expect(resizeScreenshotSelection(rect, ScreenshotHandle.NW, { x: -50, y: -100 }, bounds))
      .toEqual({ x: 0, y: 0, width: 300, height: 200 });
    expect(resizeScreenshotSelection(rect, ScreenshotHandle.NW, { x: 700, y: 500 }, bounds))
      .toEqual({ x: 298, y: 198, width: 2, height: 2 });
    expect(resizeScreenshotSelection(rect, ScreenshotHandle.SE, { x: 900, y: 800 }, bounds))
      .toEqual({ x: 100, y: 80, width: 700, height: 520 });
    expect(resizeScreenshotSelection(rect, ScreenshotHandle.SE, { x: 0, y: 0 }, bounds))
      .toEqual({ x: 100, y: 80, width: 2, height: 2 });
  });

  test('moving annotations does not mutate undo or gesture snapshots', () => {
    const annotations: ScreenshotAnnotation[] = [{ tool: ScreenshotTool.Text, points: [{ x: 120, y: 90 }],
      text: 'hello', color: '#ef4444', width: 24 }];
    const moved = translateScreenshotAnnotations(annotations, { x: -100, y: 400 });
    expect(moved[0].points).toEqual([{ x: 20, y: 490 }]);
    expect(annotations[0].points).toEqual([{ x: 120, y: 90 }]);
    expect(moved[0].text).toBe('hello');
  });

  test('hit testing includes handles at the exact selection boundaries', () => {
    expect(screenshotContains(rect, { x: 300, y: 200 })).toBe(true);
    expect(screenshotContains(rect, { x: 301, y: 200 })).toBe(false);
  });
});

function canvasFixture() {
  const context = {
    drawImage: vi.fn(), scale: vi.fn(), translate: vi.fn(), save: vi.fn(), restore: vi.fn(),
    beginPath: vi.fn(), strokeRect: vi.fn(), ellipse: vi.fn(), stroke: vi.fn(), moveTo: vi.fn(),
    lineTo: vi.fn(), fillText: vi.fn(), imageSmoothingEnabled: true,
  };
  const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
  return { canvas, context };
}

describe('annotated screenshot export', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('retains the original resolution and rounds the same crop as main on fractional displays', () => {
    const { canvas, context } = canvasFixture();
    const image = { naturalWidth: 1000, naturalHeight: 750 } as HTMLImageElement;
    renderScreenshotCrop(canvas, image, { x: 11, y: 9, width: 101, height: 101 }, bounds, []);
    expect([canvas.width, canvas.height]).toEqual([127, 127]);
    expect(context.drawImage).toHaveBeenCalledWith(image, 13, 11, 127, 127, 0, 0, 127, 127);
    expect(context.scale).toHaveBeenCalledWith(1.25, 1.25);
    expect(context.translate).toHaveBeenCalledWith(-10.4, -8.8);
  });

  test('mosaic samples the composed crop and disables smoothing when scaling blocks back up', () => {
    const { canvas, context } = canvasFixture();
    const smoothingAtDraw: boolean[] = [];
    context.drawImage.mockImplementation(() => { smoothingAtDraw.push(context.imageSmoothingEnabled); });
    const mini = canvasFixture();
    vi.stubGlobal('document', { createElement: () => mini.canvas });
    const image = { naturalWidth: 1600, naturalHeight: 1200 } as HTMLImageElement;
    renderScreenshotCrop(canvas, image, rect, bounds, [{ tool: ScreenshotTool.Mosaic,
      points: [{ x: 120, y: 100 }, { x: 200, y: 160 }], color: '#ef4444', width: 4 }]);
    expect([mini.canvas.width, mini.canvas.height]).toEqual([5, 4]);
    expect(mini.context.drawImage).toHaveBeenCalledWith(canvas, 40, 40, 160, 120, 0, 0, 5, 4);
    expect(smoothingAtDraw[smoothingAtDraw.length - 1]).toBe(false);
    expect(context.drawImage).toHaveBeenLastCalledWith(mini.canvas, 120, 100, 80, 60);
  });

  test('multiline text remains text data and respects its stored font size', () => {
    const { canvas, context } = canvasFixture();
    const image = { naturalWidth: 800, naturalHeight: 600 } as HTMLImageElement;
    renderScreenshotCrop(canvas, image, rect, bounds, [{ tool: ScreenshotTool.Text,
      points: [{ x: 120, y: 100 }], text: '<img>\n第二行', color: '#ef4444', width: 20 }]);
    expect(context.fillText.mock.calls).toEqual([['<img>', 120, 100], ['第二行', 120, 127]]);
  });

  test('resizing across a mosaic samples only opaque pixels inside the new crop', () => {
    const { canvas, context } = canvasFixture();
    const mini = canvasFixture();
    vi.stubGlobal('document', { createElement: () => mini.canvas });
    const image = { naturalWidth: 800, naturalHeight: 600 } as HTMLImageElement;
    renderScreenshotCrop(canvas, image, rect, bounds, [{ tool: ScreenshotTool.Mosaic,
      points: [{ x: 0, y: 0 }, { x: 140, y: 120 }], color: '#ef4444', width: 4 }]);
    expect(mini.context.drawImage).toHaveBeenCalledWith(canvas, 0, 0, 40, 40, 0, 0, 3, 3);
    expect(context.drawImage).toHaveBeenLastCalledWith(mini.canvas, 100, 80, 40, 40);
  });

  test('an invalid crop fails before attempting to draw an image', () => {
    const { canvas, context } = canvasFixture();
    const image = { naturalWidth: 800, naturalHeight: 600 } as HTMLImageElement;
    expect(() => renderScreenshotCrop(canvas, image, { ...rect, width: 0 }, bounds, [])).toThrow('Invalid screenshot selection');
    expect(context.drawImage).not.toHaveBeenCalled();
  });
});
