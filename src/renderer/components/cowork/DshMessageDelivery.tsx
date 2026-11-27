import { useEffect, useState } from 'react';

import { DshDeliveryOutcome, DshRecoveryPhase, type DshSessionRecovery } from '../../../shared/dshEngine/hostConstants';
import { i18nService } from '../../services/i18n';
import { COWORK_DETAIL_CONTENT_CLASS, COWORK_DETAIL_GUTTER_CLASS } from './messageDisplayUtils';

const WAIT_HINT_MS = 15_000;

export function useDshMessageRecovery(sessionId: string | undefined, busy: boolean) {
  const [visible, setVisible] = useState<(DshSessionRecovery & { sessionId: string }) | null>(null);
  useEffect(() => {
    const api = window.electron?.dshHost;
    if (!busy || !sessionId || !api) return;
    let revision = 0;
    let timer: number | undefined;
    const refresh = async () => {
      const current = ++revision;
      window.clearTimeout(timer);
      const state = await api.getSessionRecovery(sessionId).catch(() => null);
      if (current !== revision) return;
      const remaining = state ? state.since + WAIT_HINT_MS - Date.now() : 0;
      if (!state || remaining > 0) {
        setVisible(null);
        if (state) timer = window.setTimeout(() => void refresh(), remaining);
        return;
      }
      setVisible(old => old?.sessionId === sessionId && old.messageId === state.messageId
        && old.phase === state.phase && old.since === state.since ? old : { ...state, sessionId });
      // A prompt acknowledgement can arrive over HTTP while the event stream is still unavailable.
      if (state.phase === DshRecoveryPhase.Checking) timer = window.setTimeout(() => void refresh(), 2000);
    };
    const offConnection = api.onConnectionChanged(() => void refresh());
    const offSession = window.electron.cowork.onStreamSessionStatus(event => {
      if (event.sessionId === sessionId) void refresh();
    });
    void refresh();
    return () => { revision++; window.clearTimeout(timer); offConnection(); offSession(); setVisible(null); };
  }, [sessionId, busy]);
  return busy && visible?.sessionId === sessionId ? visible : null;
}

export function DshMessageDelivery({ outcome, phase, reply, onCancel, onRetry, onContinue }: {
  outcome?: DshDeliveryOutcome | null;
  phase?: DshRecoveryPhase;
  reply?: boolean;
  onCancel?: () => void;
  onRetry?: () => void;
  onContinue?: () => void;
}) {
  const t = i18nService.t.bind(i18nService);
  let label: string;
  let action: (() => void) | undefined;
  let actionLabel: string | undefined;
  if (reply) {
    if (outcome === DshDeliveryOutcome.Interrupted) {
      label = t('coworkDeliveryInterrupted'); action = onContinue; actionLabel = t('coworkDeliveryContinue');
    } else if (!outcome && phase === DshRecoveryPhase.Waiting) label = t('coworkDeliveryWaiting');
    else return null;
  } else if (outcome === DshDeliveryOutcome.Cancelled) label = t('coworkDeliveryCancelled');
  else if (outcome === DshDeliveryOutcome.Unconfirmed) label = t('coworkDeliveryUnconfirmed');
  else if (outcome === DshDeliveryOutcome.Unsent) {
    label = t('coworkDeliveryUnsent'); action = onRetry; actionLabel = t('coworkDeliveryResend');
  } else if (!outcome && phase === DshRecoveryPhase.Pending) {
    label = t('coworkDeliveryPending'); action = onCancel; actionLabel = t('cancel');
  } else if (!outcome && phase === DshRecoveryPhase.Checking) label = t('coworkDeliveryChecking');
  else return null;
  const hint = <div className={`mt-1 flex items-center gap-2 text-xs text-secondary ${reply ? 'justify-start' : 'justify-end'}`}>
    <span role="status">{label}</span>
    {action && <button type="button" className="rounded px-1 underline underline-offset-2 hover:text-foreground" onClick={action}>{actionLabel}</button>}
  </div>;
  return reply ? <div className={COWORK_DETAIL_GUTTER_CLASS}><div className={COWORK_DETAIL_CONTENT_CLASS}>{hint}</div></div> : hint;
}
