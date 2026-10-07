import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  ArrowUpIcon,
  ChatBubbleLeftEllipsisIcon,
  CheckIcon,
  DocumentDuplicateIcon,
  EllipsisHorizontalIcon,
  LanguageIcon,
  ListBulletIcon,
  QuestionMarkCircleIcon,
  SparklesIcon,
  StopIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { MapPinIcon } from '@heroicons/react/24/solid';
import { type ComponentType, type SVGProps, useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import {
  CompanionQuickAnswerEventType,
  type CompanionQuickAnswerTurn,
  type DesktopCompanionSelection,
  DesktopCompanionSelectionCommandType,
  DesktopCompanionSelectionMode,
  type DesktopCompanionState,
} from '../../../shared/desktopCompanion/constants';
import {
  CompanionSelectionAction,
  companionTranslationTarget,
} from '../../../shared/desktopCompanion/selectionActions';
import { i18nService } from '../../services/i18n';
import CompanionCharacter from './mascot/CompanionCharacter';
import { CompanionMood } from './mascot/companionMood';
import { useMeasuredSurface } from './useMeasuredSurface';

const t = (key: string) => i18nService.t(key);

const ACTION_ICONS: Record<CompanionSelectionAction, ComponentType<SVGProps<SVGSVGElement>>> = {
  [CompanionSelectionAction.Translate]: LanguageIcon,
  [CompanionSelectionAction.Explain]: QuestionMarkCircleIcon,
  [CompanionSelectionAction.Summarize]: ListBulletIcon,
  [CompanionSelectionAction.Polish]: SparklesIcon,
  [CompanionSelectionAction.Ask]: ChatBubbleLeftEllipsisIcon,
};

const actionLabel = (action: CompanionSelectionAction) => t(`desktopCompanionAction${action.charAt(0).toUpperCase()}${action.slice(1)}`);

function Answer({ text }: { text: string }) {
  return (
    <div className="sel-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} onClick={event => { event.preventDefault(); if (href) void window.electron.shell.openExternal(href); }}>{children}</a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

interface Streaming {
  requestId: string;
  text: string;
}

export default function SelectionSurface({ state }: { state: DesktopCompanionState }) {
  const api = window.electron.desktopCompanion;
  const [selection, setSelection] = useState<DesktopCompanionSelection | null>(null);
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<CompanionQuickAnswerTurn[]>([]);
  const [streaming, setStreaming] = useState<Streaming | null>(null);
  const [error, setError] = useState('');
  const [input, setInput] = useState('');
  const [copied, setCopied] = useState(false);
  const streamRef = useRef<Streaming | null>(null);
  const selectionRef = useRef<DesktopCompanionSelection | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const answering = selection?.mode === DesktopCompanionSelectionMode.Answer;
  useMeasuredSurface(rootRef, !!selection, `${selection?.id ?? ''}:${selection?.mode ?? ''}`);

  const setStream = (value: Streaming | null) => { streamRef.current = value; setStreaming(value); };

  useEffect(() => api.onSelection(next => {
    const previous = selectionRef.current;
    selectionRef.current = next;
    setSelection(next);
    if (!next || next.id !== previous?.id) {
      setStream(null);
      setTurns([]);
      setQuestion('');
      setError('');
      setInput('');
      setCopied(false);
    }
  }), [api]);

  useEffect(() => api.onQuickAnswer(event => {
    const current = streamRef.current;
    if (!current || event.requestId !== current.requestId) return;
    if (event.type === CompanionQuickAnswerEventType.Delta) {
      setStream({ ...current, text: current.text + event.text });
    } else if (event.type === CompanionQuickAnswerEventType.Done) {
      if (current.text.trim()) setTurns(previous => [...previous, { role: 'assistant', content: current.text }]);
      setStream(null);
    } else {
      setError(event.message);
      setStream(null);
    }
  }), [api]);

  // Keep the newest text in view while it streams.
  useEffect(() => {
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [streaming?.text, turns.length]);

  const ask = useCallback((action: CompanionSelectionAction, history: CompanionQuickAnswerTurn[], firstQuestion?: string) => {
    const current = selectionRef.current;
    if (!current) return;
    const requestId = crypto.randomUUID();
    setStream({ requestId, text: '' });
    setError('');
    void api.startQuickAnswer({ requestId, action, text: current.text, question: firstQuestion, history }).then(result => {
      if (!result.success && streamRef.current?.requestId === requestId) {
        setError(result.error || t('desktopCompanionRequestFailed'));
        setStream(null);
      }
    }).catch(() => {
      if (streamRef.current?.requestId === requestId) { setError(t('desktopCompanionRequestFailed')); setStream(null); }
    });
  }, [api]);

  const run = (action: CompanionSelectionAction) => {
    void api.selectionCommand({ type: DesktopCompanionSelectionCommandType.Run, action });
    if (action === CompanionSelectionAction.Ask) {
      void api.selectionCommand({ type: DesktopCompanionSelectionCommandType.FocusInput });
      setTimeout(() => inputRef.current?.focus(), 60);
      return;
    }
    ask(action, []);
  };

  const submit = () => {
    const text = input.trim();
    const current = selectionRef.current;
    if (!text || !current?.action || streamRef.current) return;
    setInput('');
    if (current.action === CompanionSelectionAction.Ask && !question && turns.length === 0) {
      setQuestion(text);
      ask(CompanionSelectionAction.Ask, [], text);
      return;
    }
    const history: CompanionQuickAnswerTurn[] = [...turns, { role: 'user', content: text }];
    setTurns(history);
    ask(current.action, history, question || undefined);
  };

  const latestAnswer = streaming?.text || [...turns].reverse().find(turn => turn.role === 'assistant')?.content || '';

  const copy = () => {
    if (!latestAnswer) return;
    void api.copyText(latestAnswer).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1_400);
    });
  };

  const toTask = async () => {
    const current = selectionRef.current;
    if (!current) return;
    const prompt = t('desktopCompanionTaskFromSelection').replace('{text}', current.text).replace('{answer}', latestAnswer);
    await api.setDraft({ prompt, attachments: [], workingDirectory: state.draft.workingDirectory });
    await api.selectSession(null);
    await api.selectionCommand({ type: DesktopCompanionSelectionCommandType.Dismiss });
    if (!state.panelVisible) await api.togglePanel();
  };

  // Re-sends whatever went unanswered: the pending follow-up, or the first request.
  const retry = () => {
    const current = selectionRef.current;
    if (!current?.action) return;
    ask(current.action, turns[turns.length - 1]?.role === 'user' ? turns : [], question || undefined);
  };

  useEffect(() => {
    if (!answering) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) void api.selectionCommand({ type: DesktopCompanionSelectionCommandType.Dismiss });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [answering, api]);

  if (!selection) return null;

  if (!answering) {
    return (
      <div className="sel-surface">
        <div className="sel-toolbar" ref={rootRef} role="toolbar" aria-label={t('desktopCompanionSelection')}>
          <span className="sel-brand"><CompanionCharacter skin={state.preferences.skin} mood={CompanionMood.Idle} size={22} showBadge={false} /></span>
          {selection.actions.map((action, index) => {
            const Icon = ACTION_ICONS[action];
            return (
              <button type="button" key={action} className="sel-action" data-primary={index === 0} onClick={() => run(action)}>
                <Icon />{actionLabel(action)}
              </button>
            );
          })}
          <span className="sel-divider" />
          <button
            type="button"
            className="sel-action sel-more"
            title={t('desktopCompanionSelectionMore')}
            aria-label={t('desktopCompanionSelectionMore')}
            onClick={() => { void api.selectionCommand({ type: DesktopCompanionSelectionCommandType.More }); }}
          >
            <EllipsisHorizontalIcon />
          </button>
        </div>
      </div>
    );
  }

  const action = selection.action ?? CompanionSelectionAction.Explain;
  const Icon = ACTION_ICONS[action];
  const direction = action === CompanionSelectionAction.Translate
    ? t(companionTranslationTarget(selection.text) === 'zh' ? 'desktopCompanionTranslateToZh' : 'desktopCompanionTranslateToEn')
    : '';
  const awaitingQuestion = action === CompanionSelectionAction.Ask && !question && turns.length === 0 && !streaming;

  return (
    <div className="sel-surface">
      <div className="sel-card" ref={rootRef}>
        <header className="sel-header">
          <span className="sel-chip"><Icon />{actionLabel(action)}{direction && <em>{direction}</em>}</span>
          <span className="sel-source" title={selection.text}>{selection.text}</span>
          <button
            type="button"
            className="sel-icon"
            data-on={selection.pinned}
            title={t(selection.pinned ? 'desktopCompanionAnswerUnpin' : 'desktopCompanionAnswerPin')}
            aria-label={t(selection.pinned ? 'desktopCompanionAnswerUnpin' : 'desktopCompanionAnswerPin')}
            onClick={() => { void api.selectionCommand({ type: DesktopCompanionSelectionCommandType.Pin, pinned: !selection.pinned }); }}
          >
            <MapPinIcon />
          </button>
          <button
            type="button"
            className="sel-icon"
            title={t('desktopCompanionAnswerClose')}
            aria-label={t('desktopCompanionAnswerClose')}
            onClick={() => { void api.selectionCommand({ type: DesktopCompanionSelectionCommandType.Dismiss }); }}
          >
            <XMarkIcon />
          </button>
        </header>
        {!awaitingQuestion && (
          <div className="sel-body" ref={bodyRef} aria-live="polite">
            {question && <p className="sel-question">{question}</p>}
            {turns.map((turn, index) => turn.role === 'user'
              ? <p key={index} className="sel-question">{turn.content}</p>
              : <Answer key={index} text={turn.content} />)}
            {streaming && (streaming.text
              ? <div className="sel-streaming"><Answer text={streaming.text} /><span className="sel-caret" /></div>
              : <p className="sel-thinking"><span className="sel-dots"><i /><i /><i /></span>{t('desktopCompanionAnswerThinking')}</p>)}
            {error && (
              <p className="sel-error" role="alert">
                {error}
                <button type="button" onClick={retry}><ArrowPathIcon />{t('desktopCompanionAnswerRetry')}</button>
              </p>
            )}
          </div>
        )}
        <footer className="sel-footer">
          <form className="sel-ask" onSubmit={event => { event.preventDefault(); submit(); }}>
            <input
              ref={inputRef}
              value={input}
              placeholder={t(awaitingQuestion ? 'desktopCompanionAnswerAskPlaceholder' : 'desktopCompanionAnswerFollowUp')}
              onChange={event => setInput(event.target.value)}
              onMouseDown={() => { void api.selectionCommand({ type: DesktopCompanionSelectionCommandType.FocusInput }); }}
              maxLength={4_000}
            />
            {streaming ? (
              <button
                type="button"
                className="sel-send"
                title={t('desktopCompanionAnswerStop')}
                aria-label={t('desktopCompanionAnswerStop')}
                onClick={() => { void api.abortQuickAnswer(streaming.requestId); setStream(null); }}
              >
                <StopIcon />
              </button>
            ) : (
              <button type="submit" className="sel-send" disabled={!input.trim()} aria-label={t('desktopCompanionSend')}><ArrowUpIcon /></button>
            )}
          </form>
          {!awaitingQuestion && (
            <>
              <button type="button" className="sel-ghost" disabled={!latestAnswer} onClick={copy}>
                {copied ? <CheckIcon /> : <DocumentDuplicateIcon />}{t(copied ? 'desktopCompanionSelectionCopied' : 'desktopCompanionSelectionCopy')}
              </button>
              <button type="button" className="sel-ghost" disabled={!latestAnswer || !!streaming} onClick={() => { void toTask(); }}>
                <ArrowTopRightOnSquareIcon />{t('desktopCompanionAnswerToTask')}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
