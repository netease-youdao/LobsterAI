import '../../cowork/mediaTaskCard.css';
import './imageEditProgress.css';

import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';

import { i18nService } from '../../../services/i18n';
import { imageEditTitle } from '../../../services/imageEditing';
import type { RootState } from '../../../store';
import type { ImageEditJob } from '../../../store/slices/imageEditorSlice';
import { CoworkSessionStatusValue } from '../../../types/cowork';
import { formatElapsed } from '../../cowork/MediaTaskCard';
import { AiEditIcon } from './ImageEditingIcons';
import { ImageEditJobPhase, type ImageEditJobStatus, imageEditJobStatus } from './imageEditJobStatus';

const t = (key: string) => i18nService.t(key);
const buttonClass = 'inline-flex h-8 shrink-0 items-center justify-center rounded-lg px-2.5 text-xs font-medium transition-colors';
const ghostClass = `${buttonClass} text-secondary hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10`;

export function useImageEditJobStatus(job?: ImageEditJob): ImageEditJobStatus | undefined {
  const session = useSelector((state: RootState) => job && state.cowork.currentSession?.id === job.sessionId ? state.cowork.currentSession : undefined);
  const queued = useSelector((state: RootState) => !!job && (state.cowork.pendingSteers[job.sessionId] ?? [])
    .some(steer => steer.attachments?.some(attachment => attachment.imageEdit?.id === job.requestId)));
  return useMemo(() => job && imageEditJobStatus({ requestId: job.requestId, messages: session?.messages ?? [], queued,
    running: session?.status === CoworkSessionStatusValue.Running }), [job, queued, session]);
}

/** Stands in for the tool panel while an edit runs, so the editor shows what is happening instead of going quiet. */
export function ImageEditProgressCard({ job, status, className, onShowInChat, onRetry, onDismiss }: {
  job: ImageEditJob; status: ImageEditJobStatus; className: string;
  onShowInChat?: () => void; onRetry?: () => void; onDismiss: () => void;
}) {
  const failed = status.phase === ImageEditJobPhase.Failed;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (failed) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [failed]);
  const showInChat = onShowInChat && <button type="button" className={ghostClass} onClick={onShowInChat}>{t('imageEditShowInChat')}</button>;

  if (failed) {
    const cause = status.reason ? t('imageEditFailureReason').replace('{label}', t(status.labelKey)).replace('{reason}', status.reason) : t(status.labelKey);
    return <div role="alert" className={`${className} flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl p-2 pl-2.5`}>
      <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-red-500/10 text-red-500">
        <ExclamationTriangleIcon className="h-[18px] w-[18px]" />
      </span>
      <div className="min-w-[180px] flex-1">
        <p className="text-sm font-medium text-foreground">{t('imageEditNotApplied')}</p>
        <p className="line-clamp-2 text-xs leading-5 text-secondary" title={cause}>{cause}</p>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {showInChat}
        <button type="button" className={ghostClass} onClick={onDismiss}>{t('imageEditBackToEdit')}</button>
        {onRetry && <button type="button" className={`${buttonClass} bg-accent text-white hover:bg-accent/90`} onClick={onRetry}>{t('imageEditRetry')}</button>}
      </div>
    </div>;
  }

  const subject = job.regionCount
    ? `${imageEditTitle(job.operation)} · ${t('imageEditRegionCount').replace('{count}', String(job.regionCount))}`
    : imageEditTitle(job.operation);
  return <div role="status" aria-live="polite" className={`${className} relative overflow-hidden rounded-2xl`}>
    <div className="flex items-center gap-3 p-2 pl-2.5">
      <span aria-hidden="true" className="relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-accent/10 text-accent">
        <span className="media-task-aurora" />
        <AiEditIcon className="media-task-icon relative h-[18px] w-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-2 text-sm font-medium text-foreground">
          <span className="truncate">{t(status.labelKey)}</span>
          <span className="shrink-0 text-xs font-normal tabular-nums text-muted">{formatElapsed(Math.max(0, Math.floor((now - job.startedAt) / 1000)))}</span>
        </p>
        <p className="truncate text-xs leading-5 text-secondary">{subject} · {t('imageEditProgressHint')}</p>
      </div>
      {showInChat}
    </div>
    <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden"><span className="image-edit-progress-bar" /></div>
  </div>;
}

/** Washes over the source while it is being edited; the image itself stays visible underneath. */
export function ImageEditStageOverlay() {
  return <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden rounded-lg bg-black/[0.06]">
    <div className="media-task-sweep" />
  </div>;
}

/** The version the running edit will add, shown at the end of the version list until it arrives. */
export function ImageEditPendingVersion({ label }: { label: string }) {
  return <div aria-disabled="true" className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-xs">
    <span aria-hidden="true" className="relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-accent/10 text-accent ring-1 ring-border">
      <span className="media-task-aurora" />
      <AiEditIcon className="media-task-icon relative h-4 w-4" />
    </span>
    <span className="min-w-0 flex-1">
      <span className="block truncate font-medium">{label}</span>
      <span className="block text-muted">{t('imageEditGeneratingVersion')}</span>
    </span>
  </div>;
}
