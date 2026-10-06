import { createHash, randomUUID } from 'crypto';
import { nativeImage } from 'electron';
import fs from 'fs';
import path from 'path';

import {
  BrowserAnnotationLimit,
  type BrowserAnnotationRect,
  type BrowserAnnotationScreenshotRef,
} from '../../shared/cowork/browserAnnotations';

export interface BrowserAnnotationAssetIdentity {
  draftKey: string;
  batchId: string;
  annotationId: string;
  assetId: string;
}

export interface SaveBrowserAnnotationAssetInput extends Omit<BrowserAnnotationAssetIdentity, 'assetId'> {
  imageDataUrl: string;
  viewportWidth: number;
  viewportHeight: number;
  targetRect?: BrowserAnnotationRect;
  markerViewportPoint?: { x: number; y: number };
  compact?: boolean;
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 96);
}

function draftSegment(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function calculateBrowserAnnotationCrop(
  imageSize: { width: number; height: number },
  viewportSize: { width: number; height: number },
  targetRect?: BrowserAnnotationRect,
  compact = false,
): { x: number; y: number; width: number; height: number; padding: number } | null {
  if (
    !targetRect
    || targetRect.width <= 0
    || targetRect.height <= 0
    || viewportSize.width <= 0
    || viewportSize.height <= 0
  ) return null;
  const scaleX = imageSize.width / viewportSize.width;
  const scaleY = imageSize.height / viewportSize.height;
  const padding = compact
    ? BrowserAnnotationLimit.CompactCropPaddingPx
    : BrowserAnnotationLimit.CropPaddingPx;
  const left = Math.max(0, Math.floor((targetRect.x - padding) * scaleX));
  const top = Math.max(0, Math.floor((targetRect.y - padding) * scaleY));
  const right = Math.min(imageSize.width, Math.ceil((targetRect.x + targetRect.width + padding) * scaleX));
  const bottom = Math.min(imageSize.height, Math.ceil((targetRect.y + targetRect.height + padding) * scaleY));
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top, padding };
}

export class BrowserAnnotationAssetStore {
  constructor(private readonly rootDir: string) {}

  save(input: SaveBrowserAnnotationAssetInput): BrowserAnnotationScreenshotRef {
    const image = nativeImage.createFromDataURL(input.imageDataUrl);
    if (image.isEmpty()) throw new Error('Invalid browser annotation image.');
    const sourceSize = image.getSize();
    const crop = calculateBrowserAnnotationCrop(
      sourceSize,
      { width: input.viewportWidth, height: input.viewportHeight },
      input.targetRect,
      input.compact,
    );
    let processed = crop ? image.crop(crop) : image;
    const processedSize = processed.getSize();
    const maxEdge = input.compact
      ? BrowserAnnotationLimit.CompactLongestEdgePx
      : crop
        ? BrowserAnnotationLimit.TargetLongestEdgePx
        : BrowserAnnotationLimit.FallbackLongestEdgePx;
    const longestEdge = Math.max(processedSize.width, processedSize.height);
    if (longestEdge > maxEdge) {
      const ratio = maxEdge / longestEdge;
      processed = processed.resize({
        width: Math.max(1, Math.round(processedSize.width * ratio)),
        height: Math.max(1, Math.round(processedSize.height * ratio)),
        quality: 'best',
      });
    }
    const png = processed.toPNG();
    const assetId = randomUUID();
    const assetPath = this.resolvePath({ ...input, assetId });
    fs.mkdirSync(path.dirname(assetPath), { recursive: true });
    fs.writeFileSync(assetPath, png, { mode: 0o600 });
    const size = processed.getSize();
    return {
      assetId,
      mimeType: 'image/png',
      width: size.width,
      height: size.height,
      byteSize: png.byteLength,
      isCompact: Boolean(input.compact),
      annotationViewportRect: input.targetRect,
      cropViewportRect: input.targetRect && crop
        ? {
            x: Math.max(0, input.targetRect.x - crop.padding),
            y: Math.max(0, input.targetRect.y - crop.padding),
            width: crop.width,
            height: crop.height,
          }
        : undefined,
      cropPaddingPx: crop?.padding,
      markerViewportPoint: input.markerViewportPoint,
      capturedAt: Date.now(),
    };
  }

  read(identity: BrowserAnnotationAssetIdentity): { dataUrl: string; byteSize: number } {
    const assetPath = this.resolvePath(identity);
    const bytes = fs.readFileSync(assetPath);
    return { dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, byteSize: bytes.byteLength };
  }

  delete(identity: BrowserAnnotationAssetIdentity): void {
    fs.rmSync(this.resolvePath(identity), { force: true });
  }

  deleteBatch(input: Pick<BrowserAnnotationAssetIdentity, 'draftKey' | 'batchId'>): void {
    const batchPath = path.join(
      this.rootDir,
      draftSegment(input.draftKey),
      safeSegment(input.batchId),
    );
    if (!batchPath.startsWith(path.resolve(this.rootDir) + path.sep)) {
      throw new Error('Invalid browser annotation asset path.');
    }
    fs.rmSync(batchPath, { recursive: true, force: true });
  }

  private resolvePath(identity: BrowserAnnotationAssetIdentity): string {
    const batchId = safeSegment(identity.batchId);
    const annotationId = safeSegment(identity.annotationId);
    const assetId = safeSegment(identity.assetId);
    if (!batchId || !annotationId || !assetId) {
      throw new Error('Invalid browser annotation asset identity.');
    }
    const root = path.resolve(this.rootDir);
    const result = path.resolve(root, draftSegment(identity.draftKey), batchId, annotationId, `${assetId}.png`);
    if (!result.startsWith(root + path.sep)) throw new Error('Invalid browser annotation asset path.');
    return result;
  }
}
