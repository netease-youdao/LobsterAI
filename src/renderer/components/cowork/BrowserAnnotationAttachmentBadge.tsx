import { ChatBubbleLeftIcon, PhotoIcon } from '@heroicons/react/24/outline';
import {
  BrowserAnnotationAnchorKind,
  BrowserAnnotationScreenshotStatus,
  type CoworkBrowserAnnotationBatch,
  getBrowserAnnotationElementChanges,
} from '@shared/cowork/browserAnnotations';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import { i18nService } from '../../services/i18n';
import XMarkIcon from '../icons/XMarkIcon';
import {
  type BrowserAnnotationAttachmentOpenPayload,
  formatBrowserAnnotationChangeProperty,
  formatBrowserAnnotationChangeValue,
  getBrowserAnnotationExcerpt,
  useBrowserAnnotationAssetDataUrl,
} from './BrowserAnnotationMessageAttachments';
import type { ImagePreviewSource } from './ImagePreviewModal';
import { type PopoverPlacement, resolvePopoverPlacement } from './popoverPlacement';

interface BrowserAnnotationAttachmentBadgeProps {
  draftKey: string;
  batches: CoworkBrowserAnnotationBatch[];
  align?: 'left' | 'right';
  onClear?: () => void;
  onPreviewImage?: (image: ImagePreviewSource) => void;
  /** Preferred over onPreviewImage: opens the annotation restore view. */
  onOpenAnnotation?: (payload: BrowserAnnotationAttachmentOpenPayload) => void;
  readOnly?: boolean;
}

const AnnotationThumbnail: React.FC<{
  draftKey: string;
  batch: CoworkBrowserAnnotationBatch;
  annotationId: string;
  assetId?: string;
  index: number;
  previewName?: string;
  onPreviewImage?: (image: ImagePreviewSource) => void;
  onOpenAnnotation?: (payload: BrowserAnnotationAttachmentOpenPayload) => void;
}> = ({ draftKey, batch, annotationId, assetId, index, previewName, onPreviewImage, onOpenAnnotation }) => {
  const { src, failed } = useBrowserAnnotationAssetDataUrl({
    draftKey,
    batchId: batch.id,
    annotationId,
    assetId,
  });
  const body = (
    <>
      {src ? (
        <img src={src} alt="" className="h-full w-full object-cover" />
      ) : failed ? (
        <PhotoIcon className="h-4 w-4 text-muted" aria-hidden="true" />
      ) : null}
      <span className="absolute left-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
        {index}
      </span>
    </>
  );
  const frameClass = 'relative flex h-10 w-14 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-raised';
  const handleOpen = src && onOpenAnnotation
    ? () => onOpenAnnotation({ batchId: batch.id, annotationId, src, name: previewName })
    : src && onPreviewImage
      ? () => onPreviewImage({ src, name: previewName })
      : null;
  if (handleOpen) {
    return (
      <button
        type="button"
        className={`${frameClass} cursor-zoom-in`}
        onClick={handleOpen}
        aria-label={previewName || i18nService.t('browserAnnotationsTitle')}
      >
        {body}
      </button>
    );
  }
  return <div className={frameClass}>{body}</div>;
};

// Popover width; keep in sync with the w-[360px] class on the popover below.
const POPOVER_WIDTH = 360;

const BrowserAnnotationAttachmentBadge: React.FC<BrowserAnnotationAttachmentBadgeProps> = ({
  draftKey,
  batches,
  align = 'left',
  onClear,
  onPreviewImage,
  onOpenAnnotation,
  readOnly = false,
}) => {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<PopoverPlacement>({
    direction: 'up',
    alignSide: align,
    maxWidth: null,
  });
  const rootRef = useRef<HTMLDivElement>(null);
  const annotations = useMemo(() => batches.flatMap(batch => (
    batch.annotations.map(annotation => ({ batch, annotation }))
  )), [batches]);

  const resolvePlacement = (): PopoverPlacement => {
    const root = rootRef.current;
    if (!root) return { direction: 'up', alignSide: align, maxWidth: null };
    return resolvePopoverPlacement(root, {
      preferredAlign: align,
      // Rows are ~60px within the max-h-72 popover body plus the header.
      estimatedHeight: Math.min(324, annotations.length * 60 + 45),
      desiredWidth: Math.min(POPOVER_WIDTH, window.innerWidth - 32),
    });
  };

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  if (annotations.length === 0) return null;
  const popoverAlignmentClass = placement.alignSide === 'right' ? 'right-0' : 'left-0';
  const popoverPlacementClass = placement.direction === 'down' ? 'top-full mt-2' : 'bottom-full mb-2';
  return (
    <div ref={rootRef} className="relative inline-flex">
      <div className="inline-flex h-8 items-center rounded-full border border-border bg-surface-raised text-xs text-foreground transition-colors hover:bg-surface">
        <button
          type="button"
          onClick={() => {
            if (!open) setPlacement(resolvePlacement());
            setOpen(value => !value);
          }}
          className={`inline-flex h-full items-center gap-1.5 rounded-l-full pl-3 ${(!readOnly && onClear) ? 'pr-2' : 'rounded-r-full pr-3'}`}
          aria-expanded={open}
        >
          <ChatBubbleLeftIcon className="h-3.5 w-3.5" />
          <span>{i18nService.t('browserAnnotationsCount').replace('{count}', String(annotations.length))}</span>
        </button>
        {!readOnly && onClear ? (
          <button
            type="button"
            className="mr-1 rounded-full p-1 text-muted hover:bg-black/10 hover:text-foreground dark:hover:bg-white/10"
            aria-label={i18nService.t('browserAnnotationsClear')}
            onClick={event => {
              event.stopPropagation();
              onClear();
            }}
          >
            <XMarkIcon className="h-3 w-3" />
          </button>
        ) : null}
      </div>
      {open ? (
        <div
          className={`absolute ${popoverPlacementClass} ${popoverAlignmentClass} z-50 w-[360px] max-w-[calc(100vw-32px)] overflow-hidden rounded-xl border border-border bg-surface-raised shadow-xl`}
          style={placement.maxWidth === null ? undefined : { maxWidth: placement.maxWidth }}
        >
          <div className="border-b border-border px-3 py-2 text-xs font-medium text-foreground">
            {i18nService.t('browserAnnotationsTitle')}
          </div>
          <div className="max-h-72 overflow-y-auto p-2">
            {annotations.map(({ batch, annotation }, index) => {
              const target = annotation.anchor.kind === BrowserAnnotationAnchorKind.Element
                ? annotation.anchor.tagName
                : i18nService.t(`browserAnnotationTarget_${annotation.anchor.kind}`);
              const excerpt = getBrowserAnnotationExcerpt(annotation) || batch.pageTitle || batch.pageUrl;
              const elementChanges = getBrowserAnnotationElementChanges(annotation.elementEdit);
              return (
                <div key={annotation.id} className="flex gap-2 rounded-lg p-2 hover:bg-surface">
                  <AnnotationThumbnail
                    draftKey={draftKey}
                    batch={batch}
                    annotationId={annotation.id}
                    assetId={annotation.screenshot.status === BrowserAnnotationScreenshotStatus.Ready
                      ? annotation.screenshot.asset.assetId
                      : undefined}
                    index={index + 1}
                    previewName={annotation.comment || batch.pageTitle || batch.pageUrl}
                    onPreviewImage={onPreviewImage}
                    onOpenAnnotation={onOpenAnnotation}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted">
                      <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 font-mono text-foreground">
                        {target}
                      </span>
                      <span className="truncate">{excerpt}</span>
                    </div>
                    {annotation.comment ? (
                      <div className="mt-0.5 line-clamp-2 text-xs text-foreground">
                        {annotation.comment}
                      </div>
                    ) : null}
                    {elementChanges.length > 0 ? (
                      <div className="mt-1.5 space-y-0.5">
                        {elementChanges.map(change => (
                          <div
                            key={change.property}
                            className="break-words font-mono text-[11px] leading-4 text-muted"
                          >
                            <span className="text-secondary">
                              {formatBrowserAnnotationChangeProperty(change.property)}:
                            </span>{' '}
                            {formatBrowserAnnotationChangeValue(change.originalValue)}
                            <span className="px-1 text-secondary">→</span>
                            <span className="text-foreground">
                              {formatBrowserAnnotationChangeValue(change.currentValue)}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default BrowserAnnotationAttachmentBadge;
