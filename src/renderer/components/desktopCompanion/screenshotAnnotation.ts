import type { CompanionPoint, CompanionRect, CompanionSize } from '../../../shared/desktopCompanion/geometry';
import { companionScreenshotCrop, companionScreenshotRect } from '../../../shared/desktopCompanion/screenshot';

export const ScreenshotTool = {
  Select: 'select', Rectangle: 'rectangle', Ellipse: 'ellipse', Arrow: 'arrow',
  Pen: 'pen', Mosaic: 'mosaic', Text: 'text',
} as const;
export type ScreenshotTool = typeof ScreenshotTool[keyof typeof ScreenshotTool];
export const ScreenshotHandle = {
  NW: 'nw', N: 'n', NE: 'ne', E: 'e', SE: 'se', S: 's', SW: 'sw', W: 'w',
} as const;
export type ScreenshotHandle = typeof ScreenshotHandle[keyof typeof ScreenshotHandle];
export interface ScreenshotAnnotation {
  tool: Exclude<ScreenshotTool, 'select'>;
  points: CompanionPoint[];
  color: string;
  width: number;
  text?: string;
}

export function screenshotContains(rect: CompanionRect, point: CompanionPoint): boolean {
  return point.x >= rect.x && point.y >= rect.y && point.x <= rect.x + rect.width && point.y <= rect.y + rect.height;
}

export function moveScreenshotSelection(rect: CompanionRect, delta: CompanionPoint, bounds: CompanionSize): CompanionRect {
  return { ...rect, x: Math.max(0, Math.min(bounds.width - rect.width, rect.x + delta.x)),
    y: Math.max(0, Math.min(bounds.height - rect.height, rect.y + delta.y)) };
}

export function resizeScreenshotSelection(rect: CompanionRect, handle: ScreenshotHandle, point: CompanionPoint, bounds: CompanionSize): CompanionRect {
  const x = Math.max(0, Math.min(bounds.width, point.x));
  const y = Math.max(0, Math.min(bounds.height, point.y));
  const left = handle.includes('w') ? Math.min(x, rect.x + rect.width - 2) : rect.x;
  const top = handle.includes('n') ? Math.min(y, rect.y + rect.height - 2) : rect.y;
  const right = handle.includes('e') ? Math.max(x, rect.x + 2) : rect.x + rect.width;
  const bottom = handle.includes('s') ? Math.max(y, rect.y + 2) : rect.y + rect.height;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function translateScreenshotAnnotations(annotations: ScreenshotAnnotation[], delta: CompanionPoint): ScreenshotAnnotation[] {
  return annotations.map(annotation => ({ ...annotation,
    points: annotation.points.map(point => ({ x: point.x + delta.x, y: point.y + delta.y })),
  }));
}

/** Coordinates stay in display pixels; canvas scales once to the original frame resolution. */
export function renderScreenshotCrop(canvas: HTMLCanvasElement, image: HTMLImageElement, rect: CompanionRect,
  display: CompanionSize, annotations: ScreenshotAnnotation[]): void {
  const crop = companionScreenshotCrop(rect, display, { width: image.naturalWidth, height: image.naturalHeight });
  if (!crop) throw new Error('Invalid screenshot selection');
  canvas.width = crop.width;
  canvas.height = crop.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Screenshot canvas unavailable');
  context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  context.scale(image.naturalWidth / display.width, image.naturalHeight / display.height);
  context.translate(-crop.x * display.width / image.naturalWidth, -crop.y * display.height / image.naturalHeight);
  for (const annotation of annotations) {
    const first = annotation.points[0];
    const last = annotation.points[annotation.points.length - 1];
    if (!first || !last) continue;
    context.save();
    context.strokeStyle = annotation.color;
    context.fillStyle = annotation.color;
    context.lineWidth = annotation.width;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    const area = companionScreenshotRect(first, last);
    context.beginPath();
    switch (annotation.tool) {
      case ScreenshotTool.Rectangle:
        context.strokeRect(area.x, area.y, area.width, area.height);
        break;
      case ScreenshotTool.Ellipse:
        context.ellipse(area.x + area.width / 2, area.y + area.height / 2, area.width / 2, area.height / 2, 0, 0, Math.PI * 2);
        context.stroke();
        break;
      case ScreenshotTool.Arrow: {
        const angle = Math.atan2(last.y - first.y, last.x - first.x);
        const head = Math.max(12, annotation.width * 4);
        context.moveTo(first.x, first.y);
        context.lineTo(last.x, last.y);
        context.moveTo(last.x - head * Math.cos(angle - Math.PI / 6), last.y - head * Math.sin(angle - Math.PI / 6));
        context.lineTo(last.x, last.y);
        context.lineTo(last.x - head * Math.cos(angle + Math.PI / 6), last.y - head * Math.sin(angle + Math.PI / 6));
        context.stroke();
        break;
      }
      case ScreenshotTool.Pen:
        context.moveTo(first.x, first.y);
        for (const point of annotation.points) context.lineTo(point.x, point.y);
        if (annotation.points.length === 1) context.lineTo(first.x + 0.1, first.y);
        context.stroke();
        break;
      case ScreenshotTool.Text: {
        const size = annotation.width;
        context.font = `${size}px sans-serif`;
        context.textBaseline = 'top';
        (annotation.text ?? '').split('\n').forEach((line, index) => context.fillText(line, first.x, first.y + index * size * 1.35));
        break;
      }
      case ScreenshotTool.Mosaic: {
        // A later resize may clip the mark. Never downsample transparent pixels outside
        // the crop: their alpha would weaken the mosaic at the new selection boundary.
        const visible = {
          x: Math.max(rect.x, area.x), y: Math.max(rect.y, area.y),
          right: Math.min(rect.x + rect.width, area.x + area.width),
          bottom: Math.min(rect.y + rect.height, area.y + area.height),
        };
        const mosaicWidth = visible.right - visible.x;
        const mosaicHeight = visible.bottom - visible.y;
        if (mosaicWidth < 1 || mosaicHeight < 1) break;
        const scaleX = image.naturalWidth / display.width;
        const scaleY = image.naturalHeight / display.height;
        const block = Math.max(8, annotation.width * 4);
        const miniature = document.createElement('canvas');
        miniature.width = Math.max(1, Math.ceil(mosaicWidth / block));
        miniature.height = Math.max(1, Math.ceil(mosaicHeight / block));
        const miniContext = miniature.getContext('2d');
        if (!miniContext) throw new Error('Screenshot mosaic canvas unavailable');
        miniContext.drawImage(canvas, visible.x * scaleX - crop.x, visible.y * scaleY - crop.y,
          mosaicWidth * scaleX, mosaicHeight * scaleY, 0, 0, miniature.width, miniature.height);
        context.imageSmoothingEnabled = false;
        context.drawImage(miniature, visible.x, visible.y, mosaicWidth, mosaicHeight);
        break;
      }
    }
    context.restore();
  }
}
