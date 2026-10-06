import { PhotoIcon } from '@heroicons/react/24/outline';
import {
  type BrowserAnnotationAnchor,
  BrowserAnnotationAnchorKind,
  type BrowserAnnotationPageScreenshot,
  type BrowserAnnotationScreenshotState,
  BrowserAnnotationScreenshotStatus,
  type CoworkBrowserAnnotation,
  type CoworkBrowserAnnotationMessageBatch,
  resolveBrowserAnnotationViewportRect,
} from '@shared/cowork/browserAnnotations';
import { useEffect, useState } from 'react';
import React from 'react';

import { i18nService } from '../../services/i18n';

export interface BrowserAnnotationAssetIdentityInput {
  draftKey: string;
  batchId: string;
  annotationId: string;
  assetId?: string;
}

export interface BrowserAnnotationAssetLoadState {
  src: string;
  failed: boolean;
}

/** Loads an annotation screenshot asset from the local asset store as a data URL. */
export function useBrowserAnnotationAssetDataUrl(
  input: BrowserAnnotationAssetIdentityInput,
): BrowserAnnotationAssetLoadState {
  const { draftKey, batchId, annotationId, assetId } = input;
  const [src, setSrc] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const unavailable = !assetId || !draftKey;
  useEffect(() => {
    if (unavailable) return undefined;
    let alive = true;
    setSrc('');
    setLoadFailed(false);
    void window.electron?.artifact?.readBrowserAnnotationAsset({
      draftKey,
      batchId,
      annotationId,
      assetId,
    }).then(result => {
      if (!alive) return;
      if (result?.success && result.dataUrl) setSrc(result.dataUrl);
      else setLoadFailed(true);
    }).catch(() => {
      if (alive) setLoadFailed(true);
    });
    return () => { alive = false; };
  }, [annotationId, assetId, batchId, draftKey, unavailable]);
  return { src, failed: unavailable || loadFailed };
}

export function getBrowserAnnotationExcerpt(
  annotation: Pick<CoworkBrowserAnnotation, 'anchor'>,
): string {
  const anchor: BrowserAnnotationAnchor = annotation.anchor;
  if (anchor.kind === BrowserAnnotationAnchorKind.Text) return anchor.selectedText;
  return anchor.immediateText || anchor.name || anchor.nearbyText || '';
}

export const formatBrowserAnnotationChangeProperty = (property: string): string => (
  property.replace(/[A-Z]/g, character => `-${character.toLowerCase()}`)
);

export const formatBrowserAnnotationChangeValue = (value: string | number | undefined): string => (
  value === undefined || value === '' ? '—' : String(value)
);

/**
 * Maps the recorded marker viewport point into a percentage position inside
 * the stored (possibly cropped) screenshot so the marker can be re-overlaid.
 */
export function getBrowserAnnotationMarkerPercent(
  annotation: Pick<CoworkBrowserAnnotation, 'capture'> & {
    screenshot: BrowserAnnotationScreenshotState;
  },
): { x: number; y: number } | null {
  if (annotation.screenshot.status !== BrowserAnnotationScreenshotStatus.Ready) return null;
  const asset = annotation.screenshot.asset;
  const crop = asset.cropViewportRect ?? {
    x: 0,
    y: 0,
    width: annotation.capture.viewportWidth,
    height: annotation.capture.viewportHeight,
  };
  if (crop.width <= 0 || crop.height <= 0) return null;
  const targetRect = asset.annotationViewportRect ?? annotation.capture.targetRect;
  const point = asset.markerViewportPoint
    ?? annotation.capture.markerViewportPoint
    ?? (targetRect
      ? {
          x: targetRect.x + Math.min(16, targetRect.width / 2),
          y: targetRect.y + Math.min(16, targetRect.height / 2),
        }
      : null);
  if (!point) return null;
  return {
    x: Math.min(98, Math.max(2, ((point.x - crop.x) / crop.width) * 100)),
    y: Math.min(98, Math.max(2, ((point.y - crop.y) / crop.height) * 100)),
  };
}

export interface BrowserAnnotationRegionPercent {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Maps an annotation's target rect onto the batch-level page screenshot as
 * percentage bounds, so the restore view can frame the region.
 */
export function getBrowserAnnotationRegionPercent(
  pageScreenshot: BrowserAnnotationPageScreenshot,
  annotation: Pick<CoworkBrowserAnnotation, 'anchor' | 'capture'>,
): BrowserAnnotationRegionPercent | null {
  if (pageScreenshot.viewportWidth <= 0 || pageScreenshot.viewportHeight <= 0) return null;
  const rect = resolveBrowserAnnotationViewportRect(
    annotation.anchor,
    annotation.capture,
    { x: pageScreenshot.scrollX, y: pageScreenshot.scrollY },
  );
  if (rect.width <= 0 || rect.height <= 0) return null;
  const left = (rect.x / pageScreenshot.viewportWidth) * 100;
  const top = (rect.y / pageScreenshot.viewportHeight) * 100;
  const width = (rect.width / pageScreenshot.viewportWidth) * 100;
  const height = (rect.height / pageScreenshot.viewportHeight) * 100;
  if (left >= 100 || top >= 100 || left + width <= 0 || top + height <= 0) return null;
  const clampedLeft = Math.max(0, left);
  const clampedTop = Math.max(0, top);
  return {
    left: clampedLeft,
    top: clampedTop,
    width: Math.max(0.5, Math.min(100 - clampedLeft, width - (clampedLeft - left))),
    height: Math.max(0.5, Math.min(100 - clampedTop, height - (clampedTop - top))),
  };
}

export interface BrowserAnnotationAttachmentOpenPayload {
  batchId: string;
  annotationId: string;
  src: string;
  name?: string;
}

const AnnotationAttachmentCard: React.FC<{
  draftKey: string;
  batch: CoworkBrowserAnnotationMessageBatch;
  annotation: CoworkBrowserAnnotationMessageBatch['annotations'][number];
  index: number;
  onOpen?: (payload: BrowserAnnotationAttachmentOpenPayload) => void;
}> = ({ draftKey, batch, annotation, index, onOpen }) => {
  const { src } = useBrowserAnnotationAssetDataUrl({
    draftKey,
    batchId: batch.id,
    annotationId: annotation.id,
    assetId: annotation.screenshot.status === BrowserAnnotationScreenshotStatus.Ready
      ? annotation.screenshot.asset.assetId
      : undefined,
  });
  const label = annotation.comment || batch.pageTitle || batch.pageUrl;
  const body = (
    <>
      {src ? (
        <img src={src} alt="" className="h-full w-full object-cover" />
      ) : (
        <PhotoIcon className="h-5 w-5 text-muted" aria-hidden="true" />
      )}
      <span className="absolute left-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
        {index}
      </span>
    </>
  );
  const frameClass = 'relative flex h-24 w-32 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-surface-raised';
  if (!src || !onOpen) {
    return <div className={frameClass}>{body}</div>;
  }
  return (
    <button
      type="button"
      className={`${frameClass} cursor-pointer transition-colors hover:border-primary`}
      onClick={() => onOpen({ batchId: batch.id, annotationId: annotation.id, src, name: label })}
      title={i18nService.t('browserAnnotationViewAttachment')}
      aria-label={label || i18nService.t('browserAnnotationViewAttachment')}
    >
      {body}
    </button>
  );
};

const BrowserAnnotationMessageAttachments: React.FC<{
  draftKey: string;
  batches: CoworkBrowserAnnotationMessageBatch[];
  onOpen?: (payload: BrowserAnnotationAttachmentOpenPayload) => void;
  className?: string;
}> = ({ draftKey, batches, onOpen, className }) => {
  const entries = batches.flatMap(batch => batch.annotations.map(annotation => ({ batch, annotation })));
  if (entries.length === 0) return null;
  return (
    <div className={`flex flex-wrap justify-end gap-2 ${className ?? ''}`}>
      {entries.map(({ batch, annotation }, index) => (
        <AnnotationAttachmentCard
          key={annotation.id}
          draftKey={draftKey}
          batch={batch}
          annotation={annotation}
          index={index + 1}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
};

export default BrowserAnnotationMessageAttachments;
