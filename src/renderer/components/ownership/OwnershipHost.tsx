import { ChevronRightIcon } from '@heroicons/react/24/outline';
import { OwnershipErrorCode, OwnershipSyncState } from '@shared/ownership/constants';
import React, { useEffect, useRef, useSyncExternalStore } from 'react';

import { authService } from '../../services/auth';
import { i18nService } from '../../services/i18n';
import { ownershipService, OwnershipView } from '../../services/ownership';
import Modal from '../common/Modal';
import OwnershipDetailContent from './OwnershipDetailContent';

const OwnershipHost: React.FC = () => {
  const panel = useSyncExternalStore(ownershipService.subscribe, ownershipService.getSnapshot, ownershipService.getSnapshot);
  const dialog = useRef<HTMLDivElement>(null);
  const focusReturn = useRef<HTMLElement | null>(null);
  const open = panel !== null;
  useEffect(() => ownershipService.start(), []);
  useEffect(() => {
    if (!open) return;
    focusReturn.current = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => dialog.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      if (focusReturn.current?.isConnected) focusReturn.current.focus();
    };
  }, [open]);
  useEffect(() => {
    if (panel?.view !== OwnershipView.Detail) return;
    const timer = setInterval(() => { void ownershipService.refreshDetail(); }, 3000);
    return () => clearInterval(timer);
  }, [panel?.view, panel?.target.kind, panel?.target.id]);
  if (!panel) return null;
  const t = (key: string) => i18nService.t(key);
  const preview = panel.preview;
  const taskCount = preview ? preview.anonymousTaskCount + preview.subtaskCount : 0;
  const additionalTasks = preview?.tasks.filter(task => preview.agentWillAssociate || task.id !== preview.targetId) ?? [];
  const reason = panel.error || preview?.reason;
  const authRequired = reason === OwnershipErrorCode.AuthRequired;
  const close = () => { if (!panel.loading) ownershipService.close(); };
  const trapFocus = (event: React.KeyboardEvent) => {
    if (event.key !== 'Tab') return;
    const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), summary, [href], input:not(:disabled), [tabindex="0"]') ?? []);
    if (!items.length) { event.preventDefault(); return; }
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.shiftKey && index <= 0) { event.preventDefault(); items[items.length - 1].focus(); }
    else if (!event.shiftKey && (index < 0 || index === items.length - 1)) { event.preventDefault(); items[0].focus(); }
  };
  return <Modal onClose={close} onEscape={close}
    overlayClassName="fixed inset-0 z-[90] flex items-center justify-center bg-black/40"
    className="mx-4 flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-xl">
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="ownership-dialog-title" tabIndex={-1} onKeyDown={trapFocus} className="flex min-h-0 flex-col outline-none">
      <h2 id="ownership-dialog-title" className="shrink-0 border-b border-border px-6 py-4 text-base font-medium text-foreground">
        {t(panel.view === OwnershipView.Preview ? 'ownershipAssociate' : 'ownershipDetails')}
      </h2>
      <div className="min-h-0 space-y-4 overflow-auto px-6 py-5 text-sm text-foreground" aria-live="polite">
        {panel.loading && <p className="text-secondary">{t(panel.intent ? 'ownershipCommitting' : 'loading')}</p>}
        {!panel.loading && panel.view === OwnershipView.Detail && panel.detail && <OwnershipDetailContent detail={panel.detail} />}
        {panel.notice && <p className="text-secondary">{t(panel.notice)}</p>}
        {reason && <p role="alert" className="rounded-lg bg-surface-raised p-3 text-sm">{t(`ownershipError_${reason}`)}</p>}
        {preview?.eligible && !panel.loading && <>
          <p className="break-words"><span className="text-secondary">{t('ownershipConfirmAccount')}</span> <strong>{preview.account?.label}</strong> · {preview.account?.scopeLabel}</p>
          <div className="space-y-2 rounded-lg bg-surface-raised p-3">
            <p className="break-words font-medium">{preview.targetTitle}</p>
            {(preview.agentWillAssociate || taskCount > 1 || preview.subtaskCount > 0) && <p className="text-xs leading-5 text-secondary">
              {t(preview.agentWillAssociate ? (taskCount > 0 ? 'ownershipAgentTaskCount' : 'ownershipAgentOnly') : 'ownershipTaskCount')
                .replace('{count}', String(taskCount))}
              {preview.subtaskCount > 0 && <> · {t('ownershipIncludedSubtasks').replace('{count}', String(preview.subtaskCount))}</>}
            </p>}
          </div>
          <p className="text-xs leading-5 text-secondary">{t('ownershipConfirmVisibility')}</p>
          <details key={preview.planId} className="group">
            <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-xs text-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary [&::-webkit-details-marker]:hidden">
              <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" aria-hidden="true" />
              {t('ownershipAssociationDetails')}
            </summary>
            <div className="mt-3 space-y-3 border-t border-border pt-3 text-xs leading-5 text-secondary">
              {panel.detail && <p className="break-words">{t('ownershipComputer')}：{panel.detail.deviceName}
                {panel.detail.agent && <> · {t('ownershipAgent')}：{panel.detail.agent.name}</>}
              </p>}
              {additionalTasks.length > 0 && <div className="space-y-2">
                <p>{t(preview.agentWillAssociate ? 'ownershipIncludedTasks' : 'ownershipAdditionalTasks')}</p>
                <ul className="max-h-40 space-y-1 overflow-auto rounded-lg bg-surface-raised p-3 text-foreground">
                  {additionalTasks.map(task => <li key={task.id} className={`break-words ${task.isSubtask ? 'pl-4' : ''}`}>
                    {task.isSubtask ? `${t('ownershipSubtask')} · ` : ''}{task.title}
                  </li>)}
                </ul>
              </div>}
              {preview.existingOwnedTaskCount > 0 && <p>{t('ownershipRetainedTasks').replace('{count}', String(preview.existingOwnedTaskCount))}</p>}
              {!preview.agentWillAssociate && <p>{t('ownershipForksExcluded')}</p>}
              <p>{t(preview.agentWillAssociate ? 'ownershipAgentLocalFiles' : 'ownershipTaskAgentUnchanged')}</p>
              <p>{t('ownershipNoAutomaticRemote')}</p>
            </div>
          </details>
        </>}
        {panel.view === OwnershipView.Unknown && <p>{t('ownershipUnknown')}</p>}
      </div>
      <div className="flex shrink-0 justify-end gap-2 border-t border-border px-6 py-4">
        <button type="button" disabled={panel.loading} onClick={close} className="rounded-lg border border-border px-4 py-2 text-sm text-foreground disabled:opacity-40">
          {t(panel.view === OwnershipView.Preview ? 'cancel' : 'close')}
        </button>
        {authRequired && <button type="button" onClick={() => {
          ownershipService.waitForLogin();
          void authService.login().then(result => { if (!result.success) ownershipService.loginFailed(); }).catch(() => ownershipService.loginFailed());
        }} className="rounded-lg bg-primary px-4 py-2 text-sm text-white">{t('ownershipLogin')}</button>}
        {panel.view === OwnershipView.Unknown && panel.intent && <button type="button"
          onClick={() => void ownershipService.reconcile(panel.intent!)} className="rounded-lg bg-primary px-4 py-2 text-sm text-white">{t('ownershipCheckResult')}</button>}
        {!panel.loading && panel.view === OwnershipView.Detail && panel.detail?.syncState === OwnershipSyncState.Failed && <button type="button"
          onClick={() => void ownershipService.retrySync()} className="rounded-lg border border-border px-4 py-2 text-sm text-foreground">{t('ownershipRetrySync')}</button>}
        {!authRequired && !panel.loading && panel.view === OwnershipView.Detail && panel.detail?.canAssociate && <button type="button"
          onClick={() => void ownershipService.open(panel.target, OwnershipView.Preview)} className="rounded-lg bg-primary px-4 py-2 text-sm text-white">{t('ownershipAssociate')}</button>}
        {preview?.eligible && <button type="button" disabled={panel.loading || !!panel.error}
          onClick={() => void ownershipService.commit()} className="rounded-lg bg-primary px-4 py-2 text-sm text-white disabled:opacity-40">
          {t('ownershipConfirm')}
        </button>}
        {!authRequired && reason && panel.view === OwnershipView.Preview && <button type="button"
          onClick={() => void ownershipService.open(panel.target, OwnershipView.Preview)} className="rounded-lg border border-border px-4 py-2 text-sm text-foreground">{t('ownershipRecheck')}</button>}
      </div>
    </div>
  </Modal>;
};
export default OwnershipHost;
