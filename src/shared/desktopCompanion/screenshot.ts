import type { CompanionPoint, CompanionRect, CompanionSize } from './geometry';

export const CompanionScreenshotIpc = {
  GetFrame: 'desktop-companion:screenshot:get-frame',
  Ready: 'desktop-companion:screenshot:ready',
  Finish: 'desktop-companion:screenshot:finish',
} as const;

export interface CompanionScreenshotBridge {
  getScreenshotFrame(): Promise<string>;
  screenshotReady(): Promise<void>;
  finishScreenshot(rect: CompanionRect | null): Promise<void>;
}

/** Drag coordinates are local to one display, in logical pixels. */
export function companionScreenshotRect(start: CompanionPoint, end: CompanionPoint): CompanionRect {
  return {
    x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y),
  };
}

/** Use the actual image size, since desktop thumbnails need not match the requested resolution. */
export function companionScreenshotCrop(value: unknown, display: CompanionSize, image: CompanionSize): CompanionRect | null {
  const rect = value as CompanionRect | null;
  if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    || rect.width < 2 || rect.height < 2 || display.width <= 0 || display.height <= 0) return null;
  const left = Math.max(0, rect.x);
  const top = Math.max(0, rect.y);
  const right = Math.min(display.width, rect.x + rect.width);
  const bottom = Math.min(display.height, rect.y + rect.height);
  if (right <= left || bottom <= top) return null;
  const x = Math.floor(left * image.width / display.width);
  const y = Math.floor(top * image.height / display.height);
  return {
    x, y,
    width: Math.ceil(right * image.width / display.width) - x,
    height: Math.ceil(bottom * image.height / display.height) - y,
  };
}
