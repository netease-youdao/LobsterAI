import './questionDock.css';

import {
  ArrowRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PencilIcon,
  QuestionMarkCircleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { coworkService } from '../../../services/cowork';
import { i18nService } from '../../../services/i18n';
import type { CoworkPermissionRequest, CoworkPermissionResult } from '../../../types/cowork';
import { stripQuestionRecommendation } from '../questionOptionLabel';
import { readInteractionDraft, saveInteractionDraft } from './interactionDraft';
import {
  type DockRequest,
  emptyQuestionDraft,
  permissionDockAnswer,
  permissionDockRequest,
  type QuestionDraft,
  questionResolved,
  QuestionSource,
} from './questionDockModel';

const t = (key: string) => i18nService.t(key);
const AUTO_ADVANCE_DELAY_MS = 180;
const OPTION_SELECTOR = '.cowork-question-option';
const isRecommendedOption = (label: string) => stripQuestionRecommendation(label) !== label;

interface QuestionDockProps {
  sessionId: string;
  permissions: CoworkPermissionRequest[];
}

/**
 * Inline question queue shown above the prompt input. Requests are ordered by
 * first arrival (persisted, so reordering the store or remounting keeps the
 * queue stable) and expired native questions drop out on their own.
 */
export default function QuestionDock({ sessionId, permissions }: QuestionDockProps) {
  const arrival = useRef(new Map<string, number>());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const requests = useMemo(() => {
    const all = permissions
      .filter((permission) => permission.sessionId === sessionId)
      .map(permissionDockRequest)
      .filter((request): request is DockRequest => request !== null);
    for (const request of all) {
      if (arrival.current.has(request.key)) continue;
      const storageKey = `question-arrival:${request.key}`;
      const saved = readInteractionDraft<{ at: number }>(storageKey);
      const at = saved && Number.isFinite(saved.at) ? saved.at : Date.now() + arrival.current.size / 1000;
      arrival.current.set(request.key, at);
      saveInteractionDraft(storageKey, { at });
    }
    return all
      .filter((request) => !request.expiresAt || request.expiresAt > now)
      .sort((a, b) => arrival.current.get(a.key)! - arrival.current.get(b.key)!);
  }, [sessionId, permissions, now]);
  const request = requests[0];
  return request ? <QuestionDockCard key={request.key} request={request} queueCount={requests.length} /> : null;
}

interface QuestionDockCardProps {
  request: DockRequest;
  queueCount?: number;
  onRespond?: (result: CoworkPermissionResult) => Promise<boolean | void> | boolean | void;
  onMinimize?: () => void;
  hidden?: boolean;
}

export function QuestionDockCard({ request, queueCount = 1, onRespond, onMinimize, hidden = false }: QuestionDockCardProps) {
  const storageKey = `question-dock:${request.key}`;
  const [draft, setDraft] = useState<QuestionDraft>(() => readInteractionDraft<QuestionDraft>(storageKey) ?? emptyQuestionDraft());
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [expired, setExpired] = useState(() => Boolean(request.expiresAt && request.expiresAt <= Date.now()));
  const flight = useRef(false);
  const mounted = useRef(true);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const card = useRef<HTMLElement>(null);
  const freeAnswer = useRef<HTMLTextAreaElement>(null);
  const focusNextQuestion = useRef(false);
  const canSkip = request.source === QuestionSource.Plugin;

  useEffect(() => { saveInteractionDraft(storageKey, draft); }, [storageKey, draft]);
  useEffect(() => {
    if (!request.expiresAt) return;
    const id = setInterval(() => setExpired(request.expiresAt! <= Date.now()), 1000);
    return () => clearInterval(id);
  }, [request.expiresAt]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const index = Math.min(draft.step, request.questions.length - 1);
  const question = request.questions[index];
  const recommendedIndex = question.options.findIndex((option) => isRecommendedOption(option.label));
  const lastStep = index === request.questions.length - 1;
  const freeText = draft.freeText[question.id] ?? '';

  useLayoutEffect(() => {
    if (!focusNextQuestion.current || hidden || draft.collapsed) return;
    focusNextQuestion.current = false;
    const options = card.current?.querySelectorAll<HTMLButtonElement>(OPTION_SELECTOR);
    const target = card.current?.querySelector<HTMLButtonElement>(`${OPTION_SELECTOR}[aria-pressed="true"]`)
      ?? (draftRef.current.freeText[question.id] ? freeAnswer.current : options?.[Math.max(0, recommendedIndex)])
      ?? freeAnswer.current;
    target?.focus({ preventScroll: true });
  }, [question.id, hidden, draft.collapsed, recommendedIndex]);
  useLayoutEffect(() => {
    const input = freeAnswer.current;
    if (!input) return;
    const resize = () => {
      input.style.height = 'auto';
      input.style.height = `${Math.max(24, Math.min(100, input.scrollHeight))}px`;
    };
    resize();
    let width = input.getBoundingClientRect().width;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      const nextWidth = input.getBoundingClientRect().width;
      if (nextWidth !== width) {
        width = nextWidth;
        resize();
      }
    });
    observer?.observe(input);
    return () => observer?.disconnect();
  }, [freeText, question.id, hidden, draft.collapsed]);

  const cancelAdvance = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const update = (value: QuestionDraft) => {
    if (value.step !== draftRef.current.step) focusNextQuestion.current = Boolean(card.current?.contains(document.activeElement));
    draftRef.current = value;
    setDraft(value);
    saveInteractionDraft(storageKey, value);
    setFailed(false);
  };
  const submit = async (value: QuestionDraft) => {
    if (flight.current || expired || (request.expiresAt !== undefined && request.expiresAt <= Date.now())) return;
    if (!request.questions.every((item) => questionResolved(value, item.id))) return;
    cancelAdvance();
    flight.current = true;
    setBusy(true);
    setFailed(false);
    // The action id keeps a retried submission identical to the failed one.
    const body = { ...value, actionId: value.actionId ?? crypto.randomUUID() };
    update(body);
    try {
      const respond = onRespond ?? ((result: CoworkPermissionResult) => coworkService.respondToPermission(request.requestId, result));
      const success = await respond(permissionDockAnswer(request, body)) !== false;
      if (success) saveInteractionDraft(storageKey, null);
      if (mounted.current) setFailed(!success);
    } catch {
      if (mounted.current) setFailed(true);
    } finally {
      flight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const advance = (value: QuestionDraft) => {
    if (!lastStep) {
      update({ ...value, step: index + 1 });
      return;
    }
    const unresolved = request.questions.findIndex((item) => !questionResolved(value, item.id));
    if (unresolved >= 0) update({ ...value, step: unresolved });
    else void submit(value);
  };
  const choose = (optionId: string) => {
    if (flight.current || busy || expired) return;
    cancelAdvance();
    const current = draftRef.current;
    const selected = current.answers[question.id] ?? [];
    const values = question.multiSelect
      ? selected.includes(optionId) ? selected.filter((value) => value !== optionId) : [...selected, optionId]
      : [optionId];
    const next: QuestionDraft = {
      ...current,
      actionId: undefined,
      answers: { ...current.answers, [question.id]: values },
      // A single choice replaces any typed answer; multi-select keeps both.
      freeText: { ...current.freeText, [question.id]: question.multiSelect ? current.freeText[question.id] ?? '' : '' },
      skipped: current.skipped.filter((id) => id !== question.id),
    };
    update(next);
    if (!question.multiSelect) timer.current = setTimeout(() => advance(next), AUTO_ADVANCE_DELAY_MS);
  };
  const changeText = (value: string) => {
    cancelAdvance();
    const current = draftRef.current;
    update({
      ...current,
      actionId: undefined,
      answers: { ...current.answers, [question.id]: question.multiSelect ? current.answers[question.id] ?? [] : [] },
      freeText: { ...current.freeText, [question.id]: value },
      skipped: current.skipped.filter((id) => id !== question.id),
    });
  };
  const skip = () => {
    cancelAdvance();
    const next: QuestionDraft = {
      ...draft,
      actionId: undefined,
      answers: { ...draft.answers, [question.id]: [] },
      freeText: { ...draft.freeText, [question.id]: '' },
      skipped: [...new Set([...draft.skipped, question.id])],
    };
    update(next);
    advance(next);
  };
  const collapse = () => {
    cancelAdvance();
    update({ ...draftRef.current, collapsed: true });
    onMinimize?.();
  };

  useEffect(() => {
    if (hidden || draft.collapsed || busy) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      if (timer.current) clearTimeout(timer.current);
      const next = { ...draftRef.current, collapsed: true };
      draftRef.current = next;
      setDraft(next);
      saveInteractionDraft(storageKey, next);
      onMinimize?.();
    };
    document.addEventListener('keydown', dismiss);
    return () => document.removeEventListener('keydown', dismiss);
  }, [hidden, draft.collapsed, busy, storageKey, onMinimize]);

  if (hidden) return null;
  if (draft.collapsed) {
    return (
      <button
        type="button"
        className="cowork-question-restore"
        onClick={() => {
          focusNextQuestion.current = true;
          update({ ...draft, collapsed: false });
        }}
      >
        <QuestionMarkCircleIcon aria-hidden="true" />
        {t('coworkQuestionDockWaiting')}
        {queueCount > 1 && ` · ${queueCount}`}
      </button>
    );
  }

  const currentResolved = questionResolved(draft, question.id);
  const showSubmit = question.multiSelect || Boolean(freeText.trim()) || failed;
  const showFooter = question.allowFreeText || showSubmit || canSkip;
  const status = expired
    ? 'coworkQuestionDockExpired'
    : failed
      ? 'coworkNativeQuestionSubmitFailed'
      : busy
        ? 'coworkQuestionDockSending'
        : queueCount > 1
          ? 'coworkQuestionDockQueue'
          : null;

  return (
    <section
      ref={card}
      data-question-status={expired ? 'expired' : failed ? 'failed' : busy ? 'running' : 'waiting'}
      className="cowork-question-dock"
      aria-label={t('coworkQuestionDockWaiting')}
      aria-busy={busy}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) {
          event.stopPropagation();
          collapse();
        }
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement
          || event.nativeEvent.isComposing || busy || expired) return;
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.target instanceof HTMLButtonElement && event.target.matches(OPTION_SELECTOR)
          && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
          const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(OPTION_SELECTOR));
          const active = options.indexOf(event.target);
          const next = event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? options.length - 1
              : (active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
          event.preventDefault();
          options[next]?.focus();
          return;
        }
        const n = Number(event.key);
        if (n >= 1 && n <= question.options.length) {
          event.preventDefault();
          choose(question.options[n - 1].id);
        }
      }}
    >
      <header>
        <h2>{question.title}</h2>
        <nav aria-label={t('coworkQuestionDockNavigation')}>
          <button
            type="button"
            disabled={index === 0 || busy}
            aria-label={t('coworkQuestionDockPrevious')}
            onClick={() => { cancelAdvance(); update({ ...draft, step: index - 1 }); }}
          >
            <ChevronLeftIcon />
          </button>
          <span>{index + 1} / {request.questions.length}</span>
          <button
            type="button"
            disabled={lastStep || busy}
            aria-label={t('coworkQuestionDockNext')}
            onClick={() => { cancelAdvance(); update({ ...draft, step: index + 1 }); }}
          >
            <ChevronRightIcon />
          </button>
          <button type="button" disabled={busy} aria-label={t('coworkQuestionDockClose')} onClick={collapse}>
            <XMarkIcon />
          </button>
        </nav>
      </header>
      <div className="cowork-question-page" key={question.id}>
        {question.multiSelect && <p className="cowork-question-hint">{t('coworkQuestionWizardMultiSelectHint')}</p>}
        <div role="group" aria-label={question.title}>
          {question.options.map((option, optionIndex) => {
            const selected = draft.answers[question.id]?.includes(option.id) ?? false;
            const recommended = optionIndex === recommendedIndex;
            const highlighted = selected || (!currentResolved && optionIndex === Math.max(0, recommendedIndex));
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={selected}
                disabled={busy || expired}
                className={`cowork-question-option${highlighted ? ' is-highlighted' : ''}`}
                onClick={() => choose(option.id)}
              >
                <span className="cowork-question-number">{selected && question.multiSelect ? '✓' : optionIndex + 1}</span>
                <span className="cowork-question-copy">
                  <strong>
                    {recommended ? `${stripQuestionRecommendation(option.label)} ${t('coworkQuestionDockRecommended')}` : option.label}
                  </strong>
                  {option.description && <span>{option.description}</span>}
                </span>
                <ArrowRightIcon className="cowork-question-arrow" />
              </button>
            );
          })}
        </div>
      </div>
      {showFooter && <footer>
        {question.allowFreeText && (
          <>
            <PencilIcon className="cowork-question-pencil" />
            <textarea
              ref={freeAnswer}
              rows={1}
              aria-label={t('coworkQuestionDockOther')}
              placeholder={t('coworkQuestionDockOther')}
              value={freeText}
              disabled={busy || expired}
              onChange={(event) => changeText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && currentResolved) {
                  event.preventDefault();
                  advance(draft);
                }
              }}
            />
          </>
        )}
        {showSubmit && (
          <button
            type="button"
            className="cowork-question-submit"
            disabled={busy || expired || !currentResolved}
            onClick={() => advance(draft)}
          >
            {t(failed ? 'retry' : lastStep ? 'coworkQuestionDockSubmit' : 'coworkQuestionDockNext')}
          </button>
        )}
        {canSkip && (
          <button type="button" className="cowork-question-skip" disabled={busy || expired} onClick={skip}>
            {t('coworkQuestionDockSkip')}
          </button>
        )}
      </footer>}
      {status && (
        <p className="cowork-question-hint" role={failed ? 'alert' : 'status'}>
          {t(status).replace('{count}', String(queueCount))}
        </p>
      )}
    </section>
  );
}
