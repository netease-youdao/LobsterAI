import React, { useEffect, useRef, useState } from 'react';

import { TaskStatus } from '../../../scheduledTask/constants';
import { hasResendableReport, hasRunDeliveryFailure, isWeixinReportDelivery } from '../../../scheduledTask/runDelivery';
import type { ScheduledTask, ScheduledTaskRun } from '../../../scheduledTask/types';
import { isWeixinContextRejected, sanitizeWeixinDeliveryError, WeixinDeliveryError } from '../../../shared/im/weixin';
import { i18nService } from '../../services/i18n';

export function getWeixinDeliveryHint(error: string): string {
  if (error.startsWith(WeixinDeliveryError.ContextExpired)) return 'scheduledTasksWeixinContextExpired';
  if (error.startsWith(WeixinDeliveryError.AccountExpired)) return 'scheduledTasksWeixinAccountExpired';
  if (error.startsWith(WeixinDeliveryError.ReportUnavailable)) return 'scheduledTasksWeixinReportUnavailable';
  if (isWeixinContextRejected(error)) return 'scheduledTasksWeixinSessionExpired';
  if (error.startsWith(WeixinDeliveryError.Rejected)) return 'scheduledTasksWeixinRejected';
  return 'scheduledTasksWeixinUnconfirmed';
}

const RunDeliveryNotice: React.FC<{ run: ScheduledTaskRun; task?: ScheduledTask }> = ({ run, task }) => {
  const [resolvedTask, setResolvedTask] = useState(task);
  const [sending, setSending] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (task) {
      setResolvedTask(task);
      return;
    }
    let cancelled = false;
    void window.electron?.scheduledTasks.get(run.taskId).then(result => {
      if (!cancelled && result.success && result.task) setResolvedTask(result.task);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [task, run.taskId]);

  const weixin = Boolean(resolvedTask && isWeixinReportDelivery(resolvedTask.delivery));
  const failed = hasRunDeliveryFailure(run, resolvedTask?.delivery);
  const canResend = weixin && hasResendableReport(run);
  if (!failed && !canResend) return null;
  const safeError = sanitizeWeixinDeliveryError(sendError ?? run.deliveryError ?? '');

  const resend = async () => {
    if (inFlight.current || accepted) return;
    inFlight.current = true;
    setSending(true);
    setSendError(null);
    try {
      const result = await window.electron.scheduledTasks.resendWeixinReport(run.taskId, run.id);
      if (result.success) setAccepted(true);
      else setSendError(sanitizeWeixinDeliveryError(result.error));
    } catch (error) {
      setSendError(sanitizeWeixinDeliveryError(error));
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };

  return (
    <div className="mx-5 my-3 rounded-lg border border-border bg-surface px-4 py-3 text-sm" role="status">
      <p className={accepted ? 'text-green-600 dark:text-green-400' : failed || sendError ? 'text-amber-600 dark:text-amber-400' : 'text-foreground'}>
        {i18nService.t(accepted ? 'scheduledTasksWeixinResent' : failed || sendError
          ? run.status === TaskStatus.Success ? 'scheduledTasksReportReadyDeliveryFailed' : 'scheduledTasksDeliveryFailed'
          : 'scheduledTasksReportSaved')}
      </p>
      {!accepted && weixin && (failed || sendError) && (
        <>
          <p className="mt-1 text-xs text-secondary">{i18nService.t(getWeixinDeliveryHint(safeError))}</p>
          <p className="mt-1 break-words font-mono text-xs text-secondary">{safeError}</p>
        </>
      )}
      {canResend && !accepted && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" disabled={sending} onClick={() => void resend()}
            className="rounded-md bg-primary px-3 py-1.5 text-xs text-white disabled:opacity-50">
            {i18nService.t(sending ? 'scheduledTasksWeixinResending' : 'scheduledTasksWeixinResend')}
          </button>
          <span className="text-xs text-secondary">{i18nService.t('scheduledTasksWeixinResendHint')}</span>
        </div>
      )}
    </div>
  );
};

export default RunDeliveryNotice;
