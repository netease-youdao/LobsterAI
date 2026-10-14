import {
  ChatBubbleLeftEllipsisIcon,
  StopIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { ArrowUpIcon } from '@heroicons/react/24/solid';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import {
  type CoworkBtwEntry,
  CoworkBtwStatus,
  type CoworkBtwThread,
} from '../../../shared/cowork/btw';
import type { CoworkSelectedTextSnippet } from '../../../shared/cowork/selectedText';
import { i18nService } from '../../services/i18n';
import EditIcon from '../icons/EditIcon';
import MarkdownContent from '../MarkdownContent';
import { ActivityIndicator } from './AssistantTurnBlock';
import {
  clampCoworkBtwPanelGeometry,
  COWORK_BTW_PANEL_DEFAULT_HEIGHT,
  COWORK_BTW_PANEL_DEFAULT_WIDTH,
  type CoworkBtwPanelGeometry,
  CoworkBtwResizeDirection,
  type CoworkBtwResizeDirection as CoworkBtwResizeDirectionType,
  getInitialCoworkBtwPanelGeometry,
  resizeCoworkBtwPanelGeometry,
} from './coworkBtwPanelGeometry';
import { MessageActionButton, MessageCopyButton } from './MessageActionButton';
import SelectedTextSnippetBadge from './SelectedTextSnippetBadge';

interface CoworkBtwFloatingPanelProps {
  thread: CoworkBtwThread;
  promptAnchorRef?: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onClearEntries: () => void;
  onDraftChange: (draft: string) => void;
  onSelectedTextSnippetsChange: (snippets: CoworkSelectedTextSnippet[]) => void;
  onLocateSelectedText?: (sourceMessageId: string) => void;
  onSubmit: () => void;
  onStop: (runId: string) => void;
  resolveLocalFilePath?: (href: string, text: string) => string | null;
}

interface PointerOperation {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startGeometry: CoworkBtwPanelGeometry;
}

interface ResizePointerOperation extends PointerOperation {
  direction: CoworkBtwResizeDirectionType;
}

const COWORK_BTW_RESIZE_HANDLES: ReadonlyArray<{
  direction: CoworkBtwResizeDirectionType;
  className: string;
}> = [
  {
    direction: CoworkBtwResizeDirection.Top,
    className: '-top-1 left-3 right-3 h-2 cursor-ns-resize',
  },
  {
    direction: CoworkBtwResizeDirection.TopRight,
    className: '-right-1 -top-1 h-3 w-3 cursor-nesw-resize',
  },
  {
    direction: CoworkBtwResizeDirection.Right,
    className: '-right-1 bottom-3 top-3 w-2 cursor-ew-resize',
  },
  {
    direction: CoworkBtwResizeDirection.BottomRight,
    className: '-bottom-1 -right-1 h-3 w-3 cursor-nwse-resize',
  },
  {
    direction: CoworkBtwResizeDirection.Bottom,
    className: '-bottom-1 left-3 right-3 h-2 cursor-ns-resize',
  },
  {
    direction: CoworkBtwResizeDirection.BottomLeft,
    className: '-bottom-1 -left-1 h-3 w-3 cursor-nesw-resize',
  },
  {
    direction: CoworkBtwResizeDirection.Left,
    className: '-left-1 bottom-3 top-3 w-2 cursor-ew-resize',
  },
  {
    direction: CoworkBtwResizeDirection.TopLeft,
    className: '-left-1 -top-1 h-3 w-3 cursor-nwse-resize',
  },
];

const getViewport = () => ({
  width: window.innerWidth,
  height: window.innerHeight,
});

const logPanelGeometry = (
  action: 'opened' | 'dragged' | 'resized',
  geometry: CoworkBtwPanelGeometry,
): void => {
  try {
    window.electron?.log?.fromRenderer?.(
      'debug',
      'CoworkBtw',
      `${action} side-chat window; x=${Math.round(geometry.x)}; y=${Math.round(geometry.y)}; `
      + `width=${Math.round(geometry.width)}; height=${Math.round(geometry.height)}.`,
    );
  } catch (error) {
    console.debug('[CoworkBtwFloatingPanel] failed to forward geometry diagnostic.', error);
  }
};

const logQuestionLoadedForEditing = (
  sessionId: string,
  questionLength: number,
  selectedTextSnippetCount: number,
): void => {
  try {
    window.electron?.log?.fromRenderer?.(
      'debug',
      'CoworkBtw',
      `loaded a previous side-chat question into the draft for session ${sessionId}; `
      + `chars=${questionLength}; selectedExcerpts=${selectedTextSnippetCount}.`,
    );
  } catch (error) {
    console.debug('[CoworkBtwFloatingPanel] failed to forward edit diagnostic.', error);
  }
};

const getEntryCopyContent = (entry: CoworkBtwEntry): string => (
  [
    ...(entry.selectedTextSnippets ?? []).map(snippet => snippet.text),
    entry.question,
  ]
    .map(value => value.trim())
    .filter(Boolean)
    .join('\n\n')
);

const CoworkBtwFloatingPanel: React.FC<CoworkBtwFloatingPanelProps> = ({
  thread,
  promptAnchorRef,
  onClose,
  onClearEntries,
  onDraftChange,
  onSelectedTextSnippetsChange,
  onLocateSelectedText,
  onSubmit,
  onStop,
  resolveLocalFilePath,
}) => {
  const [geometry, setGeometry] = useState(() => (
    typeof window === 'undefined'
      ? {
          x: 16,
          y: 16,
          width: COWORK_BTW_PANEL_DEFAULT_WIDTH,
          height: COWORK_BTW_PANEL_DEFAULT_HEIGHT,
        }
      : getInitialCoworkBtwPanelGeometry(getViewport())
  ));
  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;
  const dragRef = useRef<PointerOperation | null>(null);
  const resizeRef = useRef<ResizePointerOperation | null>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;
  const onSelectedTextSnippetsChangeRef = useRef(onSelectedTextSnippetsChange);
  onSelectedTextSnippetsChangeRef.current = onSelectedTextSnippetsChange;
  const onLocateSelectedTextRef = useRef(onLocateSelectedText);
  onLocateSelectedTextRef.current = onLocateSelectedText;
  const sessionIdRef = useRef(thread.sessionId);
  sessionIdRef.current = thread.sessionId;
  const selectedTextSnippets = thread.selectedTextSnippets ?? [];
  const pendingEntry = useMemo(
    () => thread.entries.find(entry => entry.status === CoworkBtwStatus.Pending),
    [thread.entries],
  );
  const pending = Boolean(pendingEntry);
  // Avoid allocating a trimmed copy of an unbounded controlled draft on every
  // keystroke while preserving the whitespace-only disabled state.
  const hasSelectedSnippets = selectedTextSnippets.length > 0;
  const hasComposerContent = hasSelectedSnippets || /\S/.test(thread.draft);
  const emptyThreadText = i18nService.t('coworkBtwEmptyThread');
  const failedText = i18nService.t('coworkBtwFailed');
  const stoppedText = i18nService.t('coworkBtwStopped');
  const canSubmit = hasComposerContent && !pending;
  const handleEditQuestion = useCallback((entry: CoworkBtwEntry) => {
    const entrySelectedTextSnippets = entry.selectedTextSnippets ?? [];
    onDraftChangeRef.current(entry.question);
    onSelectedTextSnippetsChangeRef.current(entrySelectedTextSnippets);
    window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    logQuestionLoadedForEditing(
      sessionIdRef.current,
      entry.question.length,
      entrySelectedTextSnippets.length,
    );
  }, []);
  const handleLocateSelectedText = useCallback((sourceMessageId: string) => {
    onLocateSelectedTextRef.current?.(sourceMessageId);
  }, []);
  // Geometry and draft changes are high-frequency. Keep the potentially large
  // Markdown subtree stable unless its content, resolver, or locale changes.
  const renderedEntries = useMemo(() => (
    <>
      {thread.entries.length === 0 && (
        <div className="flex h-full min-h-40 flex-col items-center justify-center px-8 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/[0.08] dark:bg-primary/[0.14]">
            <ChatBubbleLeftEllipsisIcon className="h-5 w-5 text-primary/70" />
          </div>
          <p className="mt-3 max-w-[248px] text-[13px] leading-relaxed text-muted">
            {emptyThreadText}
          </p>
        </div>
      )}
      <div className="space-y-3">
        {thread.entries.map((entry) => {
          const entrySelectedTextSnippets = entry.selectedTextSnippets ?? [];
          return (
            <article key={entry.runId} className="space-y-2">
              <div className="group flex flex-col items-end">
                <div className="w-fit max-w-[85%] rounded-2xl bg-chat-user px-4 py-2.5 text-sm whitespace-pre-wrap break-words text-chat-user-foreground shadow-subtle">
                  {entrySelectedTextSnippets.length > 0 && (
                    <div className={entry.question ? 'mb-2' : undefined}>
                      <SelectedTextSnippetBadge
                        snippets={entrySelectedTextSnippets}
                        align="right"
                        onLocate={handleLocateSelectedText}
                      />
                    </div>
                  )}
                  {entry.question}
                </div>
                <div className="pointer-events-none -mr-1 mt-0.5 flex min-h-7 items-center justify-end opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                  <MessageCopyButton content={getEntryCopyContent(entry)} />
                  <MessageActionButton
                    label={i18nService.t('coworkReEdit')}
                    onClick={(event) => {
                      event.stopPropagation();
                      handleEditQuestion(entry);
                    }}
                  >
                    <EditIcon className="h-4 w-4" />
                  </MessageActionButton>
                </div>
              </div>
              <div className="group py-1">
                {entry.status === CoworkBtwStatus.Pending && (
                  <ActivityIndicator
                    fingerprint={entry.runId}
                    startTimestamp={entry.createdAt}
                  />
                )}
                {entry.status === CoworkBtwStatus.Answered && (
                  <MarkdownContent
                    content={entry.answer ?? ''}
                    className="prose dark:prose-invert max-w-none text-sm text-foreground"
                    spacing="compact"
                    resolveLocalFilePath={resolveLocalFilePath}
                  />
                )}
                {entry.status === CoworkBtwStatus.Answered && entry.answer && (
                  <div className="pointer-events-none -ml-1 mt-0.5 flex min-h-7 items-center opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                    <MessageCopyButton content={entry.answer} />
                  </div>
                )}
                {entry.status === CoworkBtwStatus.Failed && (
                  <p className="whitespace-pre-wrap break-words text-sm text-danger">
                    {entry.error || failedText}
                  </p>
                )}
                {entry.status === CoworkBtwStatus.Stopped && (
                  <p className="text-sm text-muted">
                    {stoppedText}
                  </p>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </>
  ), [
    emptyThreadText,
    failedText,
    handleEditQuestion,
    handleLocateSelectedText,
    resolveLocalFilePath,
    stoppedText,
    thread.entries,
  ]);

  useLayoutEffect(() => {
    if (!thread.isOpen) {
      dragRef.current = null;
      resizeRef.current = null;
      return;
    }
    const anchorRect = promptAnchorRef?.current?.getBoundingClientRect();
    const initialGeometry = getInitialCoworkBtwPanelGeometry(
      getViewport(),
      anchorRect
        ? {
            top: anchorRect.top,
            right: anchorRect.right,
            width: anchorRect.width,
            height: anchorRect.height,
          }
        : undefined,
    );
    setGeometry(initialGeometry);
    logPanelGeometry('opened', initialGeometry);
  }, [promptAnchorRef, thread.isOpen, thread.sessionId]);

  useEffect(() => {
    if (!thread.isOpen) return;
    const handleResize = () => {
      setGeometry(current => clampCoworkBtwPanelGeometry(current, getViewport()));
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [thread.isOpen]);

  useEffect(() => {
    if (!thread.isOpen) return;
    const messageList = messageListRef.current;
    if (messageList) {
      messageList.scrollTop = messageList.scrollHeight;
    }
  }, [thread.entries, thread.isOpen]);

  useEffect(() => {
    if (!thread.isOpen) return;
    if (document.activeElement !== inputRef.current) {
      inputRef.current?.focus();
    }
  }, [thread.isOpen, thread.sessionId]);

  // Grow the composer from one line with its content; 128 mirrors max-h-32.
  useLayoutEffect(() => {
    if (!thread.isOpen) return;
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 128)}px`;
  }, [geometry.width, thread.draft, thread.isOpen]);

  const handleDragPointerDown = useCallback((
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startGeometry: geometry,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }, [geometry]);

  const handleDragPointerMove = useCallback((
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    const operation = dragRef.current;
    if (!operation || operation.pointerId !== event.pointerId) return;
    setGeometry(clampCoworkBtwPanelGeometry({
      ...operation.startGeometry,
      x: operation.startGeometry.x + event.clientX - operation.startClientX,
      y: operation.startGeometry.y + event.clientY - operation.startClientY,
    }, getViewport()));
  }, []);

  const handleDragPointerEnd = useCallback((
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    logPanelGeometry('dragged', geometryRef.current);
  }, []);

  const handleResizePointerDown = useCallback((
    event: React.PointerEvent<HTMLDivElement>,
    direction: CoworkBtwResizeDirectionType,
  ) => {
    if (event.button !== 0) return;
    resizeRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startGeometry: geometry,
      direction,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }, [geometry]);

  const handleResizePointerMove = useCallback((
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    const operation = resizeRef.current;
    if (!operation || operation.pointerId !== event.pointerId) return;
    setGeometry(resizeCoworkBtwPanelGeometry(
      operation.startGeometry,
      event.clientX - operation.startClientX,
      event.clientY - operation.startClientY,
      operation.direction,
      getViewport(),
    ));
  }, []);

  const handleResizePointerEnd = useCallback((
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (resizeRef.current?.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    logPanelGeometry('resized', geometryRef.current);
  }, []);

  if (!thread.isOpen || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <section
      data-cowork-btw-floating-panel
      role="dialog"
      aria-label={i18nService.t('coworkBtwWindowTitle')}
      className="non-draggable fixed z-40 flex rounded-2xl border border-border bg-background shadow-modal ring-1 ring-black/[0.03] dark:ring-white/[0.06] dark:shadow-[0_16px_50px_rgba(0,0,0,0.62)]"
      style={{
        left: geometry.x,
        top: geometry.y,
        width: geometry.width,
        height: geometry.height,
      }}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[inherit]">
        <div
          data-cowork-btw-drag-handle
          onPointerDown={handleDragPointerDown}
          onPointerMove={handleDragPointerMove}
          onPointerUp={handleDragPointerEnd}
          onPointerCancel={handleDragPointerEnd}
          className="flex h-11 shrink-0 cursor-move touch-none select-none items-center gap-2 px-4"
        >
          <div className="min-w-0 flex-1 truncate text-sm font-medium text-secondary">
            {i18nService.t('coworkBtwWindowTitle')}
          </div>
          <button
            type="button"
            onPointerDown={event => event.stopPropagation()}
            onClick={() => {
              if (pendingEntry) onStop(pendingEntry.runId);
              onClearEntries();
            }}
            disabled={thread.entries.length === 0}
            className="shrink-0 rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-raised hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            title={i18nService.t('coworkBtwClearContext')}
            aria-label={i18nService.t('coworkBtwClearContext')}
          >
            <TrashIcon className="h-4 w-4" />
          </button>
          <button
            type="button"
            onPointerDown={event => event.stopPropagation()}
            onClick={onClose}
            className="-mr-1.5 shrink-0 rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-raised hover:text-foreground"
            title={i18nService.t('coworkBtwCloseWindow')}
            aria-label={i18nService.t('coworkBtwCloseWindow')}
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>

        <div
          ref={messageListRef}
          aria-live="polite"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-3 pt-0.5 [scrollbar-gutter:stable_both-edges]"
        >
          {renderedEntries}
        </div>

        <div className="shrink-0 px-3 pb-3 pt-1.5">
          <div className="rounded-2xl border border-border bg-surface shadow-card transition-[border-color,box-shadow] duration-200 focus-within:border-primary/35 focus-within:shadow-elevated">
            {hasSelectedSnippets && (
              <div className="px-3 pt-2.5">
                <SelectedTextSnippetBadge
                  snippets={selectedTextSnippets}
                  onClear={() => onSelectedTextSnippetsChange([])}
                  onRemove={(snippetId) => onSelectedTextSnippetsChange(
                    selectedTextSnippets.filter(snippet => snippet.id !== snippetId),
                  )}
                  onLocate={handleLocateSelectedText}
                />
              </div>
            )}
            <div className="flex items-end gap-2 py-1.5 pl-3.5 pr-1.5">
              <textarea
                ref={inputRef}
                value={thread.draft}
                onChange={event => onDraftChange(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter'
                    && !event.shiftKey
                    && !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    if (canSubmit) onSubmit();
                  }
                }}
                rows={1}
                aria-label={i18nService.t('coworkBtwInputPlaceholder')}
                placeholder={i18nService.t('coworkBtwInputPlaceholder')}
                className="block max-h-32 w-full flex-1 resize-none overflow-y-auto bg-transparent py-0.5 text-sm leading-6 text-foreground outline-none placeholder:text-muted"
              />
              <button
                type="button"
                onClick={() => {
                  if (pendingEntry) {
                    onStop(pendingEntry.runId);
                  } else {
                    onSubmit();
                  }
                }}
                disabled={!pendingEntry && !canSubmit}
                className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-all ${
                  pendingEntry || canSubmit
                    ? 'bg-neutral-950 text-white shadow-subtle hover:bg-neutral-800 active:scale-95 dark:bg-white dark:text-neutral-950 dark:hover:bg-neutral-200'
                    : 'cursor-not-allowed bg-neutral-300 text-white dark:bg-neutral-700 dark:text-neutral-500'
                }`}
                title={i18nService.t(pendingEntry ? 'coworkBtwStop' : 'coworkBtwSend')}
                aria-label={i18nService.t(pendingEntry ? 'coworkBtwStop' : 'coworkBtwSend')}
              >
                {pendingEntry
                  ? <StopIcon className="h-4 w-4 fill-current" />
                  : <ArrowUpIcon className="h-[17px] w-[17px]" />}
              </button>
            </div>
          </div>
        </div>
      </div>

      {COWORK_BTW_RESIZE_HANDLES.map(handle => (
        <div
          key={handle.direction}
          data-cowork-btw-resize-handle={handle.direction}
          onPointerDown={event => handleResizePointerDown(event, handle.direction)}
          onPointerMove={handleResizePointerMove}
          onPointerUp={handleResizePointerEnd}
          onPointerCancel={handleResizePointerEnd}
          className={`absolute z-20 touch-none ${handle.className}`}
          aria-hidden="true"
        />
      ))}
    </section>,
    document.body,
  );
};

export default CoworkBtwFloatingPanel;
