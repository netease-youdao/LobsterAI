import { IMAGE_EDIT_MAX_PIXELS, type ImagePoint, type ImageRegion } from './types';

export const clampImageCoordinate = (value: number): number => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
export function imagePoint(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }): ImagePoint {
  return { x: clampImageCoordinate((clientX - rect.left) / rect.width), y: clampImageCoordinate((clientY - rect.top) / rect.height) };
}
export function imageRectangle(start: ImagePoint, end: ImagePoint) {
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
}
/** Left, top, width, height in the source image, never the displayed thumbnail. */
export function imageRegionCoordinates(region: ImageRegion, source: { width: number; height: number }) {
  return {
    percent: [region.x, region.y, region.width, region.height].map(value => (value * 100).toFixed(1)),
    pixels: [region.x * source.width, region.y * source.height, region.width * source.width, region.height * source.height].map(Math.round),
  };
}
export function validImageSize(width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height) && width >= 2 && height >= 2
    && width <= 16384 && height <= 16384 && width * height <= IMAGE_EDIT_MAX_PIXELS;
}
export function imageGenerationSize(width: number, height: number, ratio?: string): string {
  const presets: Record<string, string> = { '1:1': '2048x2048', '3:4': '1728x2304', '4:3': '2304x1728', '9:16': '1440x2560', '16:9': '2560x1440' };
  if (ratio && presets[ratio]) return presets[ratio];
  const parts = ratio?.split(':').map(Number);
  const aspect = parts?.length === 2 && parts[0] > 0 && parts[1] > 0 ? parts[0] / parts[1] : width / height;
  // 4 MP fits the existing image-edit providers; multiples of 16 avoid provider rounding errors.
  const w = Math.round(Math.sqrt(4_194_304 * aspect) / 16) * 16;
  const h = Math.floor((4_194_304 / w) / 16) * 16;
  return `${w}x${h}`;
}
