/** React port of OpenClaw v2026.8.1 ui/src/components/session-progress-card.ts (MIT).
 * Source commit ea806575e6450e4d1efdfc72c19f04be982a1b9b. Gateway state remains authoritative.
 */
import './openclawProgressCard.css';

import { ArrowPathIcon, CheckIcon, ChevronDownIcon, ChevronUpIcon, ClockIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { useEffect, useId, useMemo, useState } from 'react';

import type { OpenClawProgressCard as Card } from '../../../shared/cowork/progressCard';
import { ProgressCardStepStatus } from '../../../shared/cowork/progressCard';
import { i18nService } from '../../services/i18n';
import type { CoworkSession } from '../../types/cowork';
import { CoworkSessionStatusValue } from '../../types/cowork';
import { CoworkItemStatus } from './progressActivity';
import { deriveProgressActivity, type ProgressActivity,selectProgressDisplay } from './progressActivity';
import ProgressCardMarkdown from './ProgressCardMarkdown';
import { useOpenClawProgressCard } from './useOpenClawProgressCard';

const t = (key: string) => i18nService.t(key);
export function OpenClawProgressCardView({ card, activity, running, failed, ended = false, busy, onDismiss, refreshing = false, refreshError = false, onRefresh }: {
  card: Card | null; activity?: ProgressActivity | null; running: boolean; failed: boolean; ended?: boolean; busy: boolean; onDismiss: () => void; refreshing?: boolean; refreshError?: boolean; onRefresh?: () => void;
}) {
  const steps = card?.steps ?? [];
  const complete = steps.length > 0 && steps.every(s => s.status === ProgressCardStepStatus.Completed);
  const [expanded, setExpanded] = useState(!complete);
  const [now, setNow] = useState(Date.now());
  const bodyId = useId();
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  const current = steps.find(s => s.status === ProgressCardStepStatus.InProgress) ?? steps.find(s => s.status === ProgressCardStepStatus.Pending) ?? steps[steps.length - 1];
  const position = current ? steps.indexOf(current) + 1 : 0;
  const updatedAt = card?.updatedAt ?? activity?.updatedAt ?? now;
  const minutes = Math.max(0, Math.floor((now - updatedAt) / 60_000));
  const updated = minutes < 1 ? t('progressCardJustNow') : minutes < 60
    ? t('progressCardMinutes').replace('{count}', String(minutes))
    : new Date(updatedAt).toLocaleString(i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US');
  const outcome = failed ? t('progressCardFailed') : !running && !complete
    ? t(ended ? 'progressCardTurnEnded' : 'progressCardPaused') : '';
  const title = t(activity ? 'progressCardActivityTitle' : 'progressCardTitle');
  return <section className="openclaw-progress-card" aria-label={t('progressCardTitle')}>
    <div className="openclaw-progress-card-heading">
      <button type="button" className="openclaw-progress-card-toggle" aria-expanded={expanded} aria-controls={bodyId} onClick={() => setExpanded(v => !v)}>
        <span className="openclaw-progress-card-title">{expanded ? title : current?.step ?? title}</span>
        <span className="openclaw-progress-card-meta">
          {expanded && <time dateTime={new Date(updatedAt).toISOString()} title={new Date(updatedAt).toLocaleString()}>{t('progressCardUpdated')} {updated}</time>}
          {steps.length > 0 && <span>{expanded ? ' · ' : ''}{t('progressCardPosition').replace('{total}', String(steps.length)).replace('{current}', String(position))}</span>}
          {outcome && <span> · {outcome}</span>}
        </span>
        {expanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
      </button>
      {card && onRefresh && <button type="button" data-refresh aria-label={t(refreshing ? 'progressCardRefreshing' : refreshError ? 'progressCardRefreshFailed' : 'progressCardRefresh')} title={t(refreshing ? 'progressCardRefreshing' : refreshError ? 'progressCardRefreshFailed' : 'progressCardRefresh')} aria-busy={refreshing} disabled={refreshing || busy} onClick={onRefresh}>
        {refreshing ? <span className="openclaw-progress-card-spinner" /> : <ArrowPathIcon />}
        {refreshError && <span>{t('progressCardRetry')}</span>}
      </button>}
      {complete && <button type="button" data-dismiss aria-label={t('progressCardDismiss')} title={t('progressCardDismiss')} disabled={busy} onClick={onDismiss}><XMarkIcon /></button>}
    </div>
    {expanded && <div id={bodyId} className="openclaw-progress-card-body" tabIndex={0}>
      {card?.markdown && <ProgressCardMarkdown content={card.markdown} />}
      {activity && <>
        <p>{t('progressCardActivityHint')}</p>
        <ol>{activity.steps.map(step => <li key={step.id} data-status={step.status}>
          <span className="openclaw-progress-card-marker" data-running={step.status === CoworkItemStatus.Running} aria-hidden>
            {step.status === CoworkItemStatus.Completed ? <CheckIcon /> : step.status === CoworkItemStatus.Failed ? <XMarkIcon />
              : step.status === CoworkItemStatus.Running ? <span className="openclaw-progress-card-spinner" /> : <ClockIcon />}
          </span>
          <span>{step.text} · {t(step.status === CoworkItemStatus.Completed ? 'coworkTodoCompleted' : step.status === CoworkItemStatus.Failed ? 'progressCardFailed' : step.status === CoworkItemStatus.Running ? 'coworkTodoInProgress' : 'progressCardPaused')}</span>
        </li>)}</ol>
      </>}
      {steps.length > 0 && <ol>{steps.map((step, i) => {
        const active = step.status === ProgressCardStepStatus.InProgress && running;
        const label = step.status === ProgressCardStepStatus.Completed ? t('coworkTodoCompleted') : active ? t('coworkTodoInProgress') : step.status === ProgressCardStepStatus.Pending ? t('coworkTodoPending') : outcome;
        return <li key={i} data-status={step.status} aria-label={`${label}: ${step.step}`}>
          <span className="openclaw-progress-card-marker" data-running={active} aria-hidden>
            {step.status === ProgressCardStepStatus.Completed ? <CheckIcon /> : active ? <span className="openclaw-progress-card-spinner" /> : <ClockIcon />}
          </span><span>{step.step}</span>
        </li>;
      })}</ol>}
    </div>}
  </section>;
}

export default function OpenClawProgressCard({ session }: { session: CoworkSession }) {
  const { card, error, busy, reload, dismiss, refresh, refreshing, refreshError } = useOpenClawProgressCard(session.id);
  const running = session.status === CoworkSessionStatusValue.Running;
  // A paged historical window must never be presented as current execution.
  const activity = useMemo(() => session.messagesOffset + session.messages.length >= session.totalMessages
    ? deriveProgressActivity(session.messages, running) : null, [session.messages, session.messagesOffset, session.totalMessages, running]);
  const display = selectProgressDisplay(card, activity);
  return <>
    {(display.card || display.activity) && <OpenClawProgressCardView key={display.card?.sessionKey ?? display.activity?.turnId}
      card={display.card} activity={display.activity} running={running} failed={session.status === CoworkSessionStatusValue.Error} ended={session.status === CoworkSessionStatusValue.Completed} busy={busy} refreshing={refreshing} refreshError={refreshError} onRefresh={display.card ? () => void refresh() : undefined} onDismiss={() => void dismiss()} />}
    {error && <div className="openclaw-progress-card-error" role="status">{t('progressCardUnavailable')} <button type="button" onClick={() => void reload()}>{t('progressCardRetry')}</button></div>}
  </>;
}
