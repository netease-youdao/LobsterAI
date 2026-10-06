import { PhotoIcon } from '@heroicons/react/24/outline';
import {
  BrowserAnnotationAnchorKind,
  BrowserAnnotationPageScreenshotAnnotationId,
  BrowserAnnotationScreenshotStatus,
  type CoworkBrowserAnnotationMessageBatch,
  getBrowserAnnotationElementChanges,
} from '@shared/cowork/browserAnnotations';
import React, { useEffect, useMemo, useState } from 'react';

import { i18nService } from '../../services/i18n';
import {
  formatBrowserAnnotationChangeProperty,
  formatBrowserAnnotationChangeValue,
  getBrowserAnnotationExcerpt,
  getBrowserAnnotationMarkerPercent,
  getBrowserAnnotationRegionPercent,
  useBrowserAnnotationAssetDataUrl,
} from '../cowork/BrowserAnnotationMessageAttachments';

export interface UserAttachmentPreviewPayload {
  batches: CoworkBrowserAnnotationMessageBatch[];
  focusAnnotationId: string | null;
  /** Monotonic key so re-opening the same annotation re-triggers the focus. */
  focusRequestKey: number;
}

type BatchAnnotation = CoworkBrowserAnnotationMessageBatch['annotations'][number];

interface AnnotationEntry {
  batch: CoworkBrowserAnnotationMessageBatch;
  annotation: BatchAnnotation;
  index: number;
}

const annotationTargetLabel = (annotation: BatchAnnotation): string => (
  annotation.anchor.kind === BrowserAnnotationAnchorKind.Element
    ? annotation.anchor.tagName
    : i18nService.t(`browserAnnotationTarget_${annotation.anchor.kind}`)
);

const AnnotationDetailRow: React.FC<{
  entry: AnnotationEntry;
  focused: boolean;
  onFocus: () => void;
}> = ({ entry, focused, onFocus }) => {
  const { annotation, index } = entry;
  const target = annotationTargetLabel(annotation);
  const excerpt = getBrowserAnnotationExcerpt(annotation);
  const elementChanges = getBrowserAnnotationElementChanges(annotation.elementEdit);
  return (
    <button
      type="button"
      onClick={onFocus}
      className={`w-full rounded-lg p-2 text-left transition-colors ${
        focused ? 'bg-primary/10 ring-1 ring-primary/40' : 'hover:bg-surface-raised'
      }`}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
        <span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
          {index}
        </span>
        <span className="shrink-0 rounded bg-surface-raised px-1.5 py-0.5 font-mono text-foreground">
          {target}
        </span>
        {excerpt ? <span className="truncate">{excerpt}</span> : null}
      </div>
      {annotation.comment ? (
        <div className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground">
          {annotation.comment}
        </div>
      ) : null}
      {elementChanges.length > 0 ? (
        <div className="mt-1 space-y-0.5">
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
    </button>
  );
};

/**
 * Codex-style hero surface: the screenshot fills the available panel area,
 * centered with object-contain; annotation regions overlay as clickable
 * frames when the batch carries a full-page screenshot.
 */
const HeroImageSurface: React.FC<{
  sessionId: string;
  batch: CoworkBrowserAnnotationMessageBatch;
  entries: AnnotationEntry[];
  focusedAnnotationId: string | null;
  onFocusAnnotation: (annotationId: string) => void;
}> = ({ sessionId, batch, entries, focusedAnnotationId, onFocusAnnotation }) => {
  const pageScreenshot = batch.pageScreenshot ?? null;
  const focusedEntry = entries.find(entry => entry.annotation.id === focusedAnnotationId)
    ?? entries[0];
  // Full-page mode loads the batch screenshot; legacy mode falls back to the
  // focused annotation's crop (older messages have no page screenshot).
  const legacyAnnotation = pageScreenshot ? null : focusedEntry?.annotation ?? null;
  const { src, failed } = useBrowserAnnotationAssetDataUrl({
    draftKey: sessionId,
    batchId: batch.id,
    annotationId: pageScreenshot
      ? BrowserAnnotationPageScreenshotAnnotationId
      : legacyAnnotation?.id ?? '',
    assetId: pageScreenshot
      ? pageScreenshot.asset.assetId
      : legacyAnnotation?.screenshot.status === BrowserAnnotationScreenshotStatus.Ready
        ? legacyAnnotation.screenshot.asset.assetId
        : undefined,
  });
  const legacyMarker = legacyAnnotation ? getBrowserAnnotationMarkerPercent(legacyAnnotation) : null;
  return (
    <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-3 [container-type:size]">
      {src ? (
        <div className="relative max-h-[100cqh] max-w-full">
          <img
            src={src}
            alt={batch.pageTitle || batch.pageUrl}
            className="block max-h-[100cqh] max-w-full rounded-xl border border-border object-contain shadow-sm select-none"
            draggable={false}
          />
          {pageScreenshot ? entries.map(entry => {
            const region = getBrowserAnnotationRegionPercent(pageScreenshot, entry.annotation);
            if (!region) return null;
            const focused = entry.annotation.id === focusedAnnotationId;
            const dimmed = focusedAnnotationId !== null && !focused;
            return (
              <button
                key={entry.annotation.id}
                type="button"
                data-annotation-region={entry.annotation.id}
                data-annotation-focused={focused ? 'true' : undefined}
                className={`absolute rounded-sm border-2 transition-all ${
                  focused
                    ? 'z-10 border-primary bg-primary/15 shadow-[0_0_0_2px_rgba(255,255,255,0.6)]'
                    : dimmed
                      ? 'border-primary/30 bg-transparent hover:border-primary/70 hover:bg-primary/10'
                      : 'border-primary/55 bg-primary/5 hover:border-primary/80 hover:bg-primary/10'
                }`}
                style={{
                  left: `${region.left}%`,
                  top: `${region.top}%`,
                  width: `${region.width}%`,
                  height: `${region.height}%`,
                }}
                onClick={() => onFocusAnnotation(entry.annotation.id)}
                aria-label={entry.annotation.comment || annotationTargetLabel(entry.annotation)}
              >
                <span
                  className={`absolute -left-2.5 -top-2.5 flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold text-primary-foreground shadow-md ring-2 ring-white/90 transition-opacity dark:ring-black/60 ${
                    focused ? 'bg-primary' : dimmed ? 'bg-primary/60' : 'bg-primary/85'
                  }`}
                  aria-hidden="true"
                >
                  {entry.index}
                </span>
              </button>
            );
          }) : null}
          {legacyAnnotation && legacyMarker ? (
            <span
              className="absolute flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground shadow-md ring-2 ring-white/90 dark:ring-black/60"
              style={{ left: `${legacyMarker.x}%`, top: `${legacyMarker.y}%` }}
              aria-hidden="true"
            >
              {focusedEntry?.index}
            </span>
          ) : null}
        </div>
      ) : (
        <div className="flex h-32 w-48 items-center justify-center rounded-xl border border-border bg-surface-raised">
          {failed ? <PhotoIcon className="h-6 w-6 text-muted" aria-hidden="true" /> : null}
        </div>
      )}
    </div>
  );
};

const UserAttachmentPanelContent: React.FC<{
  sessionId: string;
  payload: UserAttachmentPreviewPayload | null;
}> = ({ sessionId, payload }) => {
  const entries = useMemo(() => {
    const result: AnnotationEntry[] = [];
    let index = 1;
    for (const batch of payload?.batches ?? []) {
      for (const annotation of batch.annotations) {
        result.push({ batch, annotation, index });
        index += 1;
      }
    }
    return result;
  }, [payload?.batches]);

  const [focusedAnnotationId, setFocusedAnnotationId] = useState<string | null>(
    payload?.focusAnnotationId ?? null,
  );
  useEffect(() => {
    setFocusedAnnotationId(payload?.focusAnnotationId ?? null);
  }, [payload?.focusAnnotationId, payload?.focusRequestKey]);

  if (entries.length === 0) {
    return (
      <div className="flex h-full flex-1 items-center justify-center text-sm text-secondary">
        {i18nService.t('browserAnnotationsTitle')}
      </div>
    );
  }

  // The hero shows the batch that owns the focused annotation (first batch
  // otherwise); clicking a detail row from another page swaps the hero image.
  const focusedEntry = entries.find(entry => entry.annotation.id === focusedAnnotationId);
  const heroBatch = focusedEntry?.batch ?? entries[0].batch;
  const heroEntries = entries.filter(entry => entry.batch.id === heroBatch.id);

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-surface">
      <HeroImageSurface
        sessionId={sessionId}
        batch={heroBatch}
        entries={heroEntries}
        focusedAnnotationId={focusedAnnotationId}
        onFocusAnnotation={setFocusedAnnotationId}
      />
      <div className="max-h-[40%] shrink-0 space-y-1 overflow-y-auto border-t border-border p-2">
        {entries.map(entry => (
          <AnnotationDetailRow
            key={entry.annotation.id}
            entry={entry}
            focused={entry.annotation.id === focusedAnnotationId}
            onFocus={() => setFocusedAnnotationId(entry.annotation.id)}
          />
        ))}
      </div>
    </div>
  );
};

export default UserAttachmentPanelContent;
