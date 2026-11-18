import './selectionSurface.css';

import { ArrowUpIcon } from '@heroicons/react/16/solid';
import { Bars2Icon, ExclamationCircleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { type ComponentType, type ReactNode, type Ref, type SVGProps, useLayoutEffect, useRef, useState } from 'react';

import { i18nService } from '../../services/i18n';
import CompanionMarkdown, { type CompanionMarkdownProps } from './CompanionMarkdown';
import LobsterMark from './mascot/LobsterMark';

const t = (key: string) => i18nService.t(key);

export type SelectionIcon = ComponentType<SVGProps<SVGSVGElement>>;

/** A pushpin, outlined until the card is pinned. */
export function PinIcon({ pinned }: { pinned: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
      <path d="M8.25 3.75h7.5l-.9 6.3 3.15 3.45H6l3.15-3.45-.9-6.3Z" />
      <path d="M12 13.5v6.75" strokeLinecap="round" fill="none" />
    </svg>
  );
}

export function StopGlyph() {
  return <span className="sel-stop-glyph" aria-hidden="true" />;
}

/** Both labels take up room, so a button keeps its width when "Copy" turns into "Copied". */
export function SwapLabel({ on, off, showOn }: { on: string; off: string; showOn: boolean }) {
  return (
    <span className="sel-swap">
      <span aria-hidden={showOn}>{off}</span>
      <span aria-hidden={!showOn}>{on}</span>
    </span>
  );
}

interface HeaderProps {
  /** Defaults to the LobsterAI mark; standalone tools can use their own icon. */
  icon?: SelectionIcon;
  title: string;
  pinned: boolean;
  onPin: () => void;
  onClose: () => void;
  closeLabel?: string;
  /** Extra controls placed before pin and close. */
  children?: ReactNode;
}

/** The card's title bar. Dragging it moves the card; the main process then keeps it open. */
export function SelectionCardHeader({ icon: Icon, title, pinned, onPin, onClose, closeLabel, children }: HeaderProps) {
  const pinLabel = t(pinned ? 'desktopCompanionAnswerUnpin' : 'desktopCompanionAnswerPin');
  const close = closeLabel ?? t('desktopCompanionAnswerClose');
  return (
    <header className="sel-head">
      <Bars2Icon className="sel-head-grip" aria-hidden="true" />
      {Icon ? <Icon className="sel-head-icon" aria-hidden="true" /> : (
        <span className="sel-head-brand" role="img" aria-label={t('desktopCompanionSkinLobster')}>
          <LobsterMark size={20} />
        </span>
      )}
      <span className="sel-head-title">{title}</span>
      <span className="sel-head-fill" />
      {children}
      <button type="button" className="sel-icon" data-on={pinned} title={pinLabel} aria-label={pinLabel} aria-pressed={pinned} onClick={onPin}>
        <PinIcon pinned={pinned} />
      </button>
      <button type="button" className="sel-icon" title={close} aria-label={close} onClick={onClose}>
        <XMarkIcon />
      </button>
    </header>
  );
}

/** The selected text, expandable only when the collapsed quote is truncated. */
export function SourceQuote({ text, lines = 2 }: { text: string; lines?: number }) {
  const [expanded, setExpanded] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const quoteRef = useRef<HTMLQuoteElement>(null);

  useLayoutEffect(() => {
    const quote = quoteRef.current;
    if (!quote || expanded) return;
    const measure = () => setTruncated(quote.scrollHeight > quote.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(quote);
    return () => observer.disconnect();
  }, [text, lines, expanded]);

  const canToggle = expanded || truncated;
  // Selecting part of the quote to copy it should not also toggle it.
  const toggle = () => { if (window.getSelection()?.isCollapsed !== false) setExpanded(value => !value); };
  return (
    <blockquote
      ref={quoteRef}
      className="sel-quote"
      data-expanded={expanded}
      data-expandable={canToggle}
      style={{ WebkitLineClamp: expanded ? 'unset' : lines }}
      title={!expanded && truncated ? t('desktopCompanionSelectionShowSource') : undefined}
      onClick={canToggle ? toggle : undefined}
    >
      {text}
    </blockquote>
  );
}

export function SelectionAnswer({ streaming = false, ...markdown }: CompanionMarkdownProps & { streaming?: boolean }) {
  return <div className="sel-markdown" data-streaming={streaming || undefined}><CompanionMarkdown {...markdown} /></div>;
}

export function SelectionThinking({ label }: { label: string }) {
  return <p className="sel-thinking"><span className="sel-dots" aria-hidden="true"><i /><i /><i /></span>{label}</p>;
}

export function SelectionError({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div className="sel-error" role="alert">
      <ExclamationCircleIcon />
      <span>{message}</span>
      {action}
    </div>
  );
}

interface ComposerProps {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** Shown as a stop button while an answer streams. */
  onStop?: () => void;
  disabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  onPointerDown?: () => void;
}

/** One-line follow-up input with a round send button. */
export function SelectionComposer({ value, placeholder, onChange, onSubmit, onStop, disabled = false, inputRef, onPointerDown }: ComposerProps) {
  return (
    <form className="sel-composer" onSubmit={event => { event.preventDefault(); onSubmit(); }}>
      <div className="sel-field" data-disabled={disabled}>
        <input
          ref={inputRef}
          value={value}
          placeholder={placeholder}
          aria-label={placeholder}
          disabled={disabled}
          maxLength={4_000}
          onChange={event => onChange(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }}
          onMouseDown={onPointerDown}
        />
        {onStop ? (
          <button type="button" className="sel-send" data-stop="true" title={t('desktopCompanionAnswerStop')} aria-label={t('desktopCompanionAnswerStop')} onClick={onStop}>
            <StopGlyph />
          </button>
        ) : (
          <button type="submit" className="sel-send" disabled={disabled || !value.trim()} aria-label={t('desktopCompanionSend')}>
            <ArrowUpIcon />
          </button>
        )}
      </div>
    </form>
  );
}
