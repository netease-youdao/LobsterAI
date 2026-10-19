import {
  ArrowPathIcon,
  ArrowUpRightIcon,
  CheckIcon,
  Cog6ToothIcon,
  EllipsisHorizontalIcon,
  ExclamationCircleIcon,
  NoSymbolIcon,
  Square2StackIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  COMPANION_COPY_MAX_BYTES,
  CompanionQuickAnswerErrorCode,
  CompanionQuickAnswerEventType,
  type CompanionQuickAnswerTurn,
  type DesktopCompanionSelection,
  type DesktopCompanionSelectionCommand,
  DesktopCompanionSelectionCommandType,
  DesktopCompanionSelectionMode,
  type DesktopCompanionState,
} from '../../../shared/desktopCompanion/constants';
import { LanguageTool } from '../../../shared/desktopCompanion/languageTools';
import { CompanionSelectionAction } from '../../../shared/desktopCompanion/selectionActions';
import { CompanionToolbarItem, companionToolbarItems } from '../../../shared/desktopCompanion/selectionToolbar';
import { i18nService } from '../../services/i18n';
import {
  SelectionAnswer,
  SelectionCardHeader,
  SelectionComposer,
  SelectionError,
  type SelectionIcon,
  SelectionThinking,
  SourceQuote,
  SwapLabel,
} from './SelectionCard';
import SelectionLoginRequired from './SelectionLoginRequired';
import { COMPANION_TOOLBAR_PRESENTATION } from './selectionToolbarPresentation';
import { useCompanionAuth } from './useCompanionAuth';
import { useMeasuredSurface } from './useMeasuredSurface';
import { usePointerPassThrough } from './usePointerPassThrough';

const t = (key: string) => i18nService.t(key);

/** How long "Copied" stays on the toolbar before it goes away. */
const COPIED_TOOLBAR_MS = 650;

const actionLabel = (action: CompanionSelectionAction) => t(COMPANION_TOOLBAR_PRESENTATION[action].labelKey);

interface Streaming {
  requestId: string;
  text: string;
}

interface MenuItem {
  key: string;
  icon: SelectionIcon;
  label: string;
  run: () => void;
  /** Settings-like entries sit below a divider in a quieter color. */
  secondary?: boolean;
}

export default function SelectionSurface({ state }: { state: DesktopCompanionState }) {
  const api = window.electron.desktopCompanion;
  const [selection, setSelection] = useState<DesktopCompanionSelection | null>(null);
  const { isLoggedIn, requireLogin } = useCompanionAuth(selection?.id);
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<CompanionQuickAnswerTurn[]>([]);
  const [streaming, setStreaming] = useState<Streaming | null>(null);
  const [error, setError] = useState('');
  const [input, setInput] = useState('');
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const streamRef = useRef<Streaming | null>(null);
  const selectionRef = useRef<DesktopCompanionSelection | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>();
  const answering = selection?.mode === DesktopCompanionSelectionMode.Answer;
  useMeasuredSurface(rootRef, !!selection, `${selection?.id ?? ''}:${selection?.mode ?? ''}:${!!copyError}`);

  const setStream = (value: Streaming | null) => { streamRef.current = value; setStreaming(value); };
  const command = useCallback((value: DesktopCompanionSelectionCommand) => { void api.selectionCommand(value); }, [api]);
  const setPassThrough = useCallback((passThrough: boolean) => {
    command({ type: DesktopCompanionSelectionCommandType.PassThrough, passThrough });
  }, [command]);
  usePointerPassThrough(selection?.id, setPassThrough);

  useEffect(() => api.onSelection(next => {
    const previous = selectionRef.current;
    selectionRef.current = next;
    setSelection(next);
    if (!next || next.id !== previous?.id || next.action !== previous?.action) {
      clearTimeout(copiedTimer.current);
      setStream(null);
      setTurns([]);
      setQuestion('');
      setError('');
      setInput('');
      setCopied(false);
      setCopyError('');
    }
  }), [api]);

  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  useEffect(() => {
    if (isLoggedIn !== false) return;
    if (streamRef.current) void api.abortQuickAnswer(streamRef.current.requestId);
    setStream(null);
    setTurns([]);
    setQuestion('');
    setInput('');
    setError('');
  }, [api, isLoggedIn]);

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
    if (!current || isLoggedIn !== true) return;
    const requestId = crypto.randomUUID();
    setStream({ requestId, text: '' });
    setError('');
    void api.startQuickAnswer({ requestId, action, text: current.text, question: firstQuestion, history }).then(result => {
      if (!result.success && streamRef.current?.requestId === requestId) {
        if (result.code === CompanionQuickAnswerErrorCode.LoginRequired) requireLogin();
        setError(result.error || t('desktopCompanionRequestFailed'));
        setStream(null);
      }
    }).catch(() => {
      if (streamRef.current?.requestId === requestId) { setError(t('desktopCompanionRequestFailed')); setStream(null); }
    });
  }, [api, isLoggedIn, requireLogin]);

  // Toolbar and menu actions enter the same answer flow; Ask waits for a question first.
  const autoAnswerAction = isLoggedIn === true && answering && selection.action !== CompanionSelectionAction.Ask
    && selection.action !== CompanionSelectionAction.Translate ? selection.action : null;
  useEffect(() => {
    if (autoAnswerAction) ask(autoAnswerAction, []);
  }, [ask, autoAnswerAction, selection?.id]);

  const run = (action: CompanionSelectionAction) => {
    if (action === CompanionSelectionAction.Translate) {
      void api.openLanguageTool({ tool: LanguageTool.Translate, text: selectionRef.current?.text });
      return;
    }
    command({ type: DesktopCompanionSelectionCommandType.Run, action });
    if (action === CompanionSelectionAction.Ask) {
      command({ type: DesktopCompanionSelectionCommandType.FocusInput });
      setTimeout(() => inputRef.current?.focus(), 60);
    }
  };

  const submit = () => {
    const text = input.trim();
    const current = selectionRef.current;
    if (!text || !current?.action || streamRef.current || isLoggedIn !== true) return;
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

  const flashCopied = () => {
    clearTimeout(copiedTimer.current);
    setCopied(true);
    copiedTimer.current = setTimeout(() => setCopied(false), 1_400);
  };

  const copyText = (text: string, onCopied: () => void) => {
    const selectionId = selectionRef.current?.id;
    clearTimeout(copiedTimer.current);
    setCopied(false);
    setCopyError('');
    void api.copyText(text).then(result => {
      if (selectionRef.current?.id !== selectionId) return;
      if (result.success) onCopied();
      else setCopyError(result.error);
    }).catch(() => {
      if (selectionRef.current?.id === selectionId) setCopyError(t('desktopCompanionCopyFailed'));
    });
  };

  const copyAnswer = () => {
    if (latestAnswer) copyText(latestAnswer, flashCopied);
  };

  // The toolbar confirms the copy before it steps aside.
  const copySelection = () => {
    const current = selectionRef.current;
    if (!current || current.tooLarge) return;
    copyText(current.text, () => {
      setCopied(true);
      copiedTimer.current = setTimeout(() => command({ type: DesktopCompanionSelectionCommandType.Dismiss }), COPIED_TOOLBAR_MS);
    });
  };

  const toTask = async () => {
    const current = selectionRef.current;
    if (!current?.action) return;
    try {
      await api.setDraft({
        ...state.draft,
        selectionContext: {
          id: crypto.randomUUID(), action: current.action, sourceText: current.text,
          turns: [...(question ? [{ role: 'user' as const, content: question }] : []), ...turns],
        },
      });
      await api.selectSession(null);
      await api.selectionCommand({ type: DesktopCompanionSelectionCommandType.Dismiss });
      if (!state.panelVisible) await api.togglePanel();
    } catch { setError(t('desktopCompanionRequestFailed')); }
  };

  // Re-sends whatever went unanswered: the pending follow-up, or the first request.
  const retry = () => {
    const current = selectionRef.current;
    if (!current?.action) return;
    ask(current.action, turns[turns.length - 1]?.role === 'user' ? turns : [], question || undefined);
  };

  // Drops the newest answer and asks for it again with the same history.
  const regenerate = () => {
    const current = selectionRef.current;
    if (!current?.action || streamRef.current || turns[turns.length - 1]?.role !== 'assistant') return;
    const history = turns.slice(0, -1);
    setTurns(history);
    ask(current.action, history[history.length - 1]?.role === 'user' ? history : [], question || undefined);
  };

  useEffect(() => {
    if (!answering) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) command({ type: DesktopCompanionSelectionCommandType.Dismiss });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [answering, command]);

  if (!selection) return null;

  if (!answering) {
    const notice = selection.tooLarge
      ? t('desktopCompanionCopyTooLarge').replace('{limit}', String(COMPANION_COPY_MAX_BYTES / 1_000_000))
      : copyError;
    if (notice) return (
      <div className="sel-surface" data-menu={selection.menuUp ? 'up' : 'down'}>
        <div className="sel-stack">
          <div className="sel-toolbar sel-copy-notice" ref={rootRef} role="alert">
            <ExclamationCircleIcon />
            <span>{notice}</span>
            <button type="button" className="sel-icon" aria-label={t('desktopCompanionAnswerClose')}
              onClick={() => command({ type: DesktopCompanionSelectionCommandType.Dismiss })}>
              <XMarkIcon />
            </button>
          </div>
        </div>
      </div>
    );
    const toolItem = (value: CompanionToolbarItem): MenuItem => {
      const presentation = COMPANION_TOOLBAR_PRESENTATION[value];
      return {
        key: value,
        icon: value === CompanionToolbarItem.Copy && copied ? CheckIcon : presentation.icon,
        label: t(value === CompanionToolbarItem.Copy && copied ? 'desktopCompanionSelectionCopied' : presentation.labelKey),
        run: () => {
          if (value === CompanionToolbarItem.Copy) copySelection();
          else if (value === CompanionToolbarItem.ReadAloud) void api.openLanguageTool({ tool: LanguageTool.Tts, text: selection.text });
          else run(value);
        },
      };
    };
    const { visible, overflow } = companionToolbarItems(state.preferences.selectionToolbarOrder);
    const tools = visible.map(toolItem);
    const menu: MenuItem[] = [
      ...overflow.map(toolItem),
      { key: 'exclude', icon: NoSymbolIcon, label: t('desktopCompanionSelectionExclude'), run: () => command({ type: DesktopCompanionSelectionCommandType.ExcludeApp }), secondary: true },
      { key: 'settings', icon: Cog6ToothIcon, label: t('desktopCompanionSelectionSettings'), run: () => command({ type: DesktopCompanionSelectionCommandType.Settings }), secondary: true },
    ];
    const menuOpen = selection.menuOpen;
    return (
      <div className="sel-surface" data-menu={selection.menuUp ? 'up' : 'down'}>
        <div className="sel-stack">
          <div className="sel-toolbar" ref={rootRef} role="toolbar" aria-label={t('desktopCompanionSelection')}>
            {tools.map(({ key, icon: ToolIcon, label, run: onClick }) => (
              <button key={key} type="button" className="sel-tool" data-done={key === CompanionToolbarItem.Copy && copied} onClick={onClick}>
                <ToolIcon />
                {key === CompanionToolbarItem.Copy
                  ? <SwapLabel off={t('desktopCompanionSelectionCopy')} on={t('desktopCompanionSelectionCopied')} showOn={copied} />
                  : <span>{label}</span>}
              </button>
            ))}
            <span className="sel-sep" aria-hidden="true" />
            <button
              type="button"
              className="sel-tool sel-more"
              data-active={menuOpen}
              title={t('desktopCompanionSelectionMore')}
              aria-label={t('desktopCompanionSelectionMore')}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => command({ type: DesktopCompanionSelectionCommandType.More, open: !menuOpen })}
            >
              <EllipsisHorizontalIcon />
            </button>
          </div>
          {menuOpen && (
            <div className="sel-menu" role="menu">
              {menu.map(({ key, icon: ItemIcon, label, run: onClick, secondary }, index) => (
                <div key={key} className="sel-menu-group" data-divided={secondary && !menu[index - 1]?.secondary}>
                  <button type="button" role="menuitem" className="sel-menu-item" data-secondary={secondary} onClick={onClick}>
                    <ItemIcon /><span>{label}</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  const action = selection.action ?? CompanionSelectionAction.Explain;
  const awaitingQuestion = action === CompanionSelectionAction.Ask && !question && turns.length === 0 && !streaming;
  const showActions = !!latestAnswer && !streaming;

  return (
    <div className="sel-surface">
      <div className="sel-card" ref={rootRef} style={{ maxHeight: selection.cardMaxHeight }}>
        <SelectionCardHeader
          title={actionLabel(action)}
          pinned={selection.pinned}
          onPin={() => command({ type: DesktopCompanionSelectionCommandType.Pin, pinned: !selection.pinned })}
          onClose={() => command({ type: DesktopCompanionSelectionCommandType.Dismiss })}
        />
        <div className="sel-scroll" ref={bodyRef} aria-live="polite">
          {copyError && <SelectionError message={copyError} />}
          <SourceQuote key={selection.id} text={selection.text} />
          {question && <p className="sel-question">{question}</p>}
          {turns.map((turn, index) => turn.role === 'user'
            ? <p key={index} className="sel-question">{turn.content}</p>
            : <SelectionAnswer key={index} text={turn.content} />)}
          {streaming && (streaming.text
            ? <SelectionAnswer text={streaming.text} streaming />
            : <SelectionThinking label={t('desktopCompanionAnswerThinking')} />)}
          {isLoggedIn === false ? <SelectionLoginRequired /> : error && (
            <SelectionError
              message={error}
              action={<button type="button" onClick={retry}>{t('desktopCompanionAnswerRetry')}</button>}
            />
          )}
        </div>
        {showActions && (
          <div className="sel-actions">
            <button type="button" className="sel-icon" data-done={copied} onClick={copyAnswer}
              title={t(copied ? 'desktopCompanionSelectionCopied' : 'desktopCompanionSelectionCopy')}
              aria-label={t(copied ? 'desktopCompanionSelectionCopied' : 'desktopCompanionSelectionCopy')}>
              {copied ? <CheckIcon /> : <Square2StackIcon />}
            </button>
            {turns[turns.length - 1]?.role === 'assistant' && (
              <button type="button" className="sel-icon" onClick={regenerate}
                title={t('desktopCompanionAnswerRegenerate')} aria-label={t('desktopCompanionAnswerRegenerate')}>
                <ArrowPathIcon />
              </button>
            )}
            <button type="button" className="sel-action sel-action-end" onClick={() => { void toTask(); }}>
              {t('desktopCompanionAnswerToTask')}<ArrowUpRightIcon />
            </button>
          </div>
        )}
        <SelectionComposer
          inputRef={inputRef}
          value={input}
          placeholder={t(awaitingQuestion ? 'desktopCompanionAnswerAskPlaceholder' : 'desktopCompanionAnswerFollowUp')}
          onChange={setInput}
          onSubmit={submit}
          disabled={isLoggedIn !== true}
          onStop={streaming ? () => { void api.abortQuickAnswer(streaming.requestId); setStream(null); } : undefined}
          onPointerDown={() => command({ type: DesktopCompanionSelectionCommandType.FocusInput })}
        />
      </div>
    </div>
  );
}
