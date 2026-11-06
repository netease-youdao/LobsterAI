import './mediaTaskCard.css';

import { CheckCircleIcon, ExclamationTriangleIcon, FilmIcon, SparklesIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useState } from 'react';

import { MediaBillingStatus, MediaDeliveryStatus, MediaTaskPhase, MediaTaskStatus, TERMINAL_MEDIA_TASK_STATUSES } from '../../../shared/media/constants';
import { i18nService } from '../../services/i18n';

export const mediaTaskLabelKey = (details: Record<string, unknown>): string => {
  if (details.deliveryStatus === MediaDeliveryStatus.Failed) return 'imageEditFailed';
  if (details.deliveryStatus === MediaDeliveryStatus.Retrying) return 'mediaTaskDownloadRetry';
  if (details.deliveryStatus === MediaDeliveryStatus.Pending) return 'mediaTaskFetching';
  switch (details.status) {
    case MediaTaskStatus.Succeeded: return 'mediaTaskSaved';
    case MediaTaskStatus.Failed: return 'mediaTaskFailed';
    case MediaTaskStatus.Timeout: return 'mediaTaskTimedOut';
    case MediaTaskStatus.Cancelled: return 'mediaTaskCancelled';
  }
  switch (details.phase) {
    case MediaTaskPhase.Queued: return 'mediaTaskQueued';
    case MediaTaskPhase.Submitting: return details.mediaType === 'image' ? 'mediaTaskProcessing' : 'mediaTaskSubmitting';
    case MediaTaskPhase.Verifying: return 'mediaTaskVerifying';
    case MediaTaskPhase.Fetching: return 'mediaTaskFetching';
    default: return details.slow ? 'mediaTaskSlow' : 'mediaTaskProcessing';
  }
};

const MAX_TILE_WIDTH = 480;
const MAX_TILE_HEIGHT = 420;
const ratioOf = (value: unknown, pattern: RegExp): number | undefined => {
  const match = typeof value === 'string' ? pattern.exec(value.trim()) : null;
  const ratio = match ? Number(match[1]) / Number(match[2]) : NaN;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : undefined;
};

/** The requested output shape (aspectRatio "3:4" or size "1024x1536"), so the placeholder matches the result. */
export const mediaTaskAspectRatio = (input: Record<string, unknown> | undefined, isVideo: boolean): number => {
  const ratio = ratioOf(input?.aspectRatio, /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/)
    ?? ratioOf(input?.size, /^(\d+)\s*[x×*]\s*(\d+)$/i)
    ?? (isVideo ? 16 / 9 : 1);
  return Math.min(2.4, Math.max(0.4, ratio));
};

/** Finished for good: a terminal status with no file download still pending. */
export const isMediaTaskSettled = (details: Record<string, unknown>): boolean =>
  TERMINAL_MEDIA_TASK_STATUSES.has(String(details.status))
  && details.deliveryStatus !== MediaDeliveryStatus.Pending && details.deliveryStatus !== MediaDeliveryStatus.Retrying;

export const formatElapsed = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

const MediaTaskCard: React.FC<{ details: Record<string, unknown>; startedAt?: number; input?: Record<string, unknown> }> = ({ details, startedAt, input }) => {
  const [now, setNow] = useState(Date.now);
  const terminal = isMediaTaskSettled(details);
  const success = terminal && details.status === MediaTaskStatus.Succeeded && details.deliveryStatus !== MediaDeliveryStatus.Failed;
  useEffect(() => {
    if (terminal) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [terminal]);
  const label = i18nService.t(mediaTaskLabelKey(details));
  const model = String(details.model ?? '');
  const taskId = String(details.taskId);
  const detailTitle = [model, taskId].filter(Boolean).join(' · ');

  if (!terminal) {
    const isVideo = details.mediaType === 'video';
    const aspect = mediaTaskAspectRatio(input, isVideo);
    const Icon = isVideo ? FilmIcon : SparklesIcon;
    const elapsed = startedAt !== undefined ? Math.max(0, Math.floor((now - startedAt) / 1000)) : undefined;
    return (
      <div className="my-2" data-media-task-id={taskId}>
        <div
          aria-busy="true"
          title={detailTitle}
          className="relative max-w-full overflow-hidden rounded-2xl border border-border bg-surface-raised"
          style={{ aspectRatio: String(aspect), width: `min(100%, ${Math.round(Math.min(MAX_TILE_WIDTH, MAX_TILE_HEIGHT * aspect))}px)` }}
        >
          <div aria-hidden="true" className="media-task-aurora" />
          <div aria-hidden="true" className="media-task-sweep" />
          <div className="absolute inset-x-3 bottom-3 flex">
            <span role="status" className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-surface/85 px-2.5 py-1 text-xs font-medium text-foreground shadow-sm backdrop-blur">
              <Icon aria-hidden="true" className="media-task-icon h-3.5 w-3.5 shrink-0 text-primary" />
              <span className="truncate">{label}</span>
              {elapsed !== undefined && <span className="shrink-0 tabular-nums text-secondary">{formatElapsed(elapsed)}</span>}
            </span>
          </div>
        </div>
        <p className="mt-1.5 text-xs text-muted">
          {model && <span className="mr-1.5">{model} ·</span>}{i18nService.t('mediaTaskBackground')}
        </p>
      </div>
    );
  }

  if (success) {
    return (
      <div className="my-2 flex items-center gap-1.5 text-xs text-secondary" title={detailTitle} data-media-task-id={taskId}>
        <CheckCircleIcon aria-hidden="true" className="h-4 w-4 shrink-0 text-green-500" />
        <span>{label}</span>
        {details.billingStatus === MediaBillingStatus.Refunded && <span className="text-muted">· {i18nService.t('mediaTaskRefunded')}</span>}
      </div>
    );
  }

  return (
    <div className="my-2 rounded-xl border border-border bg-surface-raised p-3" title={detailTitle} data-media-task-id={taskId}>
      <div className="flex items-center gap-2">
        <ExclamationTriangleIcon aria-hidden="true" className="h-4 w-4 shrink-0 text-amber-500" />
        <span className="text-sm font-medium text-foreground">{label}</span>
      </div>
      {typeof details.errorMessage === 'string' && details.errorMessage && <p className="mt-1.5 text-sm text-secondary">{details.errorMessage}</p>}
      {details.billingStatus === MediaBillingStatus.Refunded && <p className="mt-1 text-xs text-secondary">{i18nService.t('mediaTaskRefunded')}</p>}
    </div>
  );
};

export default MediaTaskCard;
