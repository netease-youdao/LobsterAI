import React, { useEffect, useState } from 'react';

import { MediaBillingStatus, MediaDeliveryStatus, MediaTaskPhase, MediaTaskStatus, TERMINAL_MEDIA_TASK_STATUSES } from '../../../shared/media/constants';
import { i18nService } from '../../services/i18n';

export const mediaTaskLabelKey = (details: Record<string, unknown>): string => {
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

const MediaTaskCard: React.FC<{ details: Record<string, unknown>; startedAt?: number }> = ({ details, startedAt }) => {
  const [now, setNow] = useState(Date.now);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState('');
  const fetching = details.deliveryStatus === MediaDeliveryStatus.Pending || details.deliveryStatus === MediaDeliveryStatus.Retrying;
  const terminal = TERMINAL_MEDIA_TASK_STATUSES.has(String(details.status)) && !fetching;
  const success = details.status === MediaTaskStatus.Succeeded && !fetching;
  useEffect(() => {
    if (terminal) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [terminal]);
  const cancel = async () => {
    setCancelling(true);
    try {
      const result = await window.electron.cowork.cancelMediaTask(String(details.taskId));
      if (!result.success) setError(result.message || i18nService.t('mediaTaskCancelFailed'));
    } catch { setError(i18nService.t('mediaTaskCancelFailed')); }
    finally { setCancelling(false); }
  };
  return (
    <div className="my-2 rounded-xl border border-border bg-surface-raised p-3" data-media-task-id={String(details.taskId)}>
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${success ? 'bg-green-500' : terminal ? 'bg-amber-500' : 'bg-blue-500 animate-pulse'}`} />
        <span className="text-sm font-medium text-foreground">{i18nService.t(mediaTaskLabelKey(details))}</span>
        {!terminal && startedAt !== undefined && <span className="text-xs text-muted">{i18nService.t('mediaTaskElapsed').replace('{seconds}', String(Math.max(0, Math.floor((now - startedAt) / 1000))))}</span>}
      </div>
      <div className="mt-1 text-xs text-muted">{String(details.model ?? '')} · {String(details.taskId)}</div>
      {!terminal && <p className="mt-2 text-xs text-secondary">{i18nService.t('mediaTaskBackground')}</p>}
      {typeof details.errorMessage === 'string' && details.errorMessage && <p className="mt-2 text-sm text-secondary">{details.errorMessage}</p>}
      {details.billingStatus === MediaBillingStatus.Refunded && <p className="mt-1 text-xs text-secondary">{i18nService.t('mediaTaskRefunded')}</p>}
      {!terminal && details.canCancel === true && <button className="mt-2 rounded border border-border px-2 py-1 text-xs" disabled={cancelling} onClick={() => { void cancel(); }}>{i18nService.t('mediaTaskCancel')}</button>}
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </div>
  );
};

export default MediaTaskCard;
