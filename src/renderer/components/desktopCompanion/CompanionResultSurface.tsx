import './companionResult.css';

import { ArrowTurnDownLeftIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { CheckCircleIcon, ExclamationCircleIcon, PauseCircleIcon } from '@heroicons/react/24/solid';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { CompanionAnalyticsAction, CompanionAnalyticsInteraction, CompanionAnalyticsOutcome, CompanionAnalyticsSource } from '../../../shared/desktopCompanion/analytics';
import type { DesktopCompanionState } from '../../../shared/desktopCompanion/constants';
import type { CompanionRecentTask } from '../../../shared/desktopCompanion/results';
import { i18nService } from '../../services/i18n';
import { reportCompanionAnalytics } from './analytics';
import { CompanionPhase, companionPhase } from './companionPresentation';
import CompanionTaskFollowUp from './CompanionTaskFollowUp';
import { SelectionError, SelectionThinking, StopGlyph } from './SelectionCard';
import { CompanionFollowUpPhase, useCompanionFollowUp } from './useCompanionFollowUp';
import { useCompanionRecentTasks } from './useCompanionRecentTasks';
import { useMeasuredSurface } from './useMeasuredSurface';
import { usePointerPassThrough } from './usePointerPassThrough';

const t = (key: string) => i18nService.t(key);

/** Compact task notifications open their full conversation in the main window. */
function TaskBubble({ task, expanded, onRefresh, onFollowUp, onCloseFollowUp }: {
  task: CompanionRecentTask;
  expanded: boolean;
  onRefresh: () => void;
  onFollowUp: () => void;
  onCloseFollowUp: () => void;
}) {
  const api = window.electron.desktopCompanion;
  const [stopping, setStopping] = useState(false);
  const [closing, setClosing] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const followUpSubmission = useCompanionFollowUp(task.id, onRefresh);
  const activity = followUpSubmission.activity;
  const steering = activity?.phase === CompanionFollowUpPhase.Steering;
  const followUpExpanded = expanded && !steering;
  const title = activity?.prompt ?? task.title;
  const phase = companionPhase(task, false);
  const running = Boolean(activity) || phase.value === CompanionPhase.Running;
  const StatusIcon = phase.value === CompanionPhase.Completed ? CheckCircleIcon
    : phase.value === CompanionPhase.Error ? ExclamationCircleIcon : PauseCircleIcon;
  const preview = steering ? t('desktopCompanionAnswerSteering') : running ? t('desktopCompanionAnswerThinking')
    : phase.value === CompanionPhase.Completed && task.preview ? task.preview : t(phase.key);
  const stop = async () => {
    setStopping(true);
    setActionFailed(false);
    let success = false;
    try {
      const result = await window.electron.cowork.stopSession(task.id);
      success = result.success;
      if (result.success) onRefresh();
      else setActionFailed(true);
    } catch {
      setActionFailed(true);
    } finally {
      reportCompanionAnalytics({ action: CompanionAnalyticsAction.Action, source: CompanionAnalyticsSource.Result,
        interactionType: CompanionAnalyticsInteraction.Stop,
        outcome: success ? CompanionAnalyticsOutcome.Success : CompanionAnalyticsOutcome.Failed });
      setStopping(false);
    }
  };
  const close = async () => {
    setClosing(true);
    setActionFailed(false);
    try {
      await api.dismissResult(task.id);
      onRefresh();
    } catch {
      setActionFailed(true);
    } finally {
      setClosing(false);
    }
  };
  const followUp = async () => {
    if (expanded) {
      onCloseFollowUp();
      return;
    }
    setActionFailed(false);
    try {
      // Notifications open without focus. Typing needs a focusable native window first.
      await api.openResult();
      onFollowUp();
    } catch {
      setActionFailed(true);
    }
  };
  return (
    <section className="sel-card result-task-item" data-running={running} data-expanded={followUpExpanded}>
      <button type="button" className="result-close" disabled={closing || steering}
        title={t('desktopCompanionResultDismiss')} aria-label={`${t('desktopCompanionResultDismiss')}: ${task.title}`}
        onClick={() => { void close(); }}><XMarkIcon aria-hidden="true" /></button>
      <button type="button" className="result-task"
        title={`${title} · ${running ? preview : t(phase.key)} · ${t('desktopCompanionResultOpenMain')}`}
        aria-label={`${title} · ${running ? preview : t(phase.key)} · ${t('desktopCompanionResultOpenMain')}`}
        onClick={() => { void api.openResult(task.id); }}>
        <span className="result-task-copy" data-stacked={running || actionFailed}>
          {running || actionFailed ? <>
            <strong className="result-task-heading">{title}</strong>
            <span className="result-task-preview" role={actionFailed ? 'alert' : 'status'}>
              {actionFailed ? t('desktopCompanionRequestFailed') : preview}
            </span>
          </> : <>
            <StatusIcon className="result-task-status" data-phase={phase.value} aria-hidden="true" />
            <strong>{task.title}</strong><span className="result-task-separator" aria-hidden="true"> · </span><span>{preview}</span>
          </>}
        </span>
      </button>
      <div className="result-task-actions">
        <button type="button" className="result-follow-up-button"
          disabled={steering}
          title={t('desktopCompanionResultFollowUp')} aria-label={`${t('desktopCompanionResultFollowUp')}: ${task.title}`}
          aria-expanded={followUpExpanded}
          onClick={() => { void followUp(); }}><ArrowTurnDownLeftIcon aria-hidden="true" /></button>
        {running && <button type="button" className="result-stop" disabled={stopping || steering}
          title={t('desktopCompanionStop')} aria-label={t('desktopCompanionStop')}
          onClick={() => { void stop(); }}><StopGlyph /></button>}
      </div>
      <CompanionTaskFollowUp expanded={followUpExpanded} pending={steering} onClose={onCloseFollowUp}
        onSubmit={followUpSubmission.submit}
        onSubmitted={() => { onCloseFollowUp(); onRefresh(); }} />
    </section>
  );
}

export default function CompanionResultSurface({ state }: { state: DesktopCompanionState }) {
  const api = window.electron.desktopCompanion;
  const cardRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollEdges, setScrollEdges] = useState({ top: false, bottom: false });
  const [followUpId, setFollowUpId] = useState<string | null>(null);
  const [keyboardNavigation, setKeyboardNavigation] = useState(false);
  const result = state.result;
  const recordsKey = result.recentTasks.map(task => `${task.sessionId}:${task.viewedAt}`).join('|');
  const { tasks, loading, failed, refresh } = useCompanionRecentTasks(result.visible, recordsKey);
  const followUpTask = tasks.find(task => task.id === followUpId);
  useLayoutEffect(() => {
    setKeyboardNavigation(false);
    // Native window activation must not select the first task's close button.
    if (result.visible) cardRef.current?.focus({ preventScroll: true });
    else setFollowUpId(null);
  }, [result.visible]);
  const updateScrollEdges = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const top = list.scrollTop > 1;
    const bottom = list.scrollTop + list.clientHeight < list.scrollHeight - 1;
    setScrollEdges(previous => previous.top === top && previous.bottom === bottom ? previous : { top, bottom });
  }, []);
  const newestTaskId = tasks[0]?.id;
  useEffect(() => {
    if (result.visible && listRef.current) listRef.current.scrollTop = 0;
  }, [result.visible, newestTaskId]);
  useEffect(() => {
    updateScrollEdges();
    const list = listRef.current;
    if (!list) return;
    const observer = new ResizeObserver(updateScrollEdges);
    observer.observe(list);
    list.querySelectorAll('.result-follow-up').forEach(followUp => observer.observe(followUp));
    return () => observer.disconnect();
  }, [tasks, result.visible, followUpId, updateScrollEdges]);
  useMeasuredSurface(cardRef, result.visible, 'recent');
  const passThrough = useCallback((value: boolean) => { void api.setResultPassThrough(value); }, [api]);
  usePointerPassThrough(result.visible ? 'recent' : null, passThrough, false);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing && !event.defaultPrevented) void api.hideResult();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [api]);
  return (
    <div className="sel-surface">
      <div className="result-stack" ref={cardRef} tabIndex={-1} style={{ maxHeight: result.cardMaxHeight }}
        data-keyboard-navigation={keyboardNavigation}
        onKeyDownCapture={event => { if (event.key === 'Tab') setKeyboardNavigation(true); }}
        onPointerMoveCapture={() => { if (keyboardNavigation) setKeyboardNavigation(false); }}
        onPointerDownCapture={() => { if (keyboardNavigation) setKeyboardNavigation(false); }}
        onPointerLeave={() => { if (keyboardNavigation) setKeyboardNavigation(false); }}>
        {(failed || !tasks.length) && <div className="sel-card result-notice">
          <button type="button" className="result-close"
            title={t('desktopCompanionAnswerClose')} aria-label={t('desktopCompanionAnswerClose')}
            onClick={() => { void api.hideResult(); }}><XMarkIcon aria-hidden="true" /></button>
          {loading && !tasks.length && <SelectionThinking label={t('desktopCompanionLoading')} />}
          {failed && <SelectionError message={t('desktopCompanionRequestFailed')}
            action={<button type="button" onClick={refresh}>{t('desktopCompanionAnswerRetry')}</button>} />}
          {!loading && !failed && !tasks.length && <p className="result-muted">{t('desktopCompanionRecentEmpty')}</p>}
        </div>}
        <div className="result-task-list" ref={listRef} onScroll={updateScrollEdges}
          data-follow-up={Boolean(followUpTask)}
          data-scroll-top={scrollEdges.top} data-scroll-bottom={scrollEdges.bottom}>
          {tasks.map(task => <TaskBubble key={task.id} task={task} expanded={followUpId === task.id}
            onRefresh={refresh} onFollowUp={() => setFollowUpId(task.id)}
            onCloseFollowUp={() => setFollowUpId(current => current === task.id ? null : current)} />)}
        </div>
      </div>
    </div>
  );
}
