import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import XMarkIcon from '../icons/XMarkIcon';
import {
  CONTEXT_CHIP_CLASS,
  CONTEXT_CHIP_HEIGHT_VAR,
  CONTEXT_CHIP_ICON_TONE_CLASS,
  CONTEXT_CHIP_TONE_CLASS,
  ContextChipTone,
} from './ContextChip';
import {
  computeInlineContextChipLayout,
  EMPTY_INLINE_CONTEXT_CHIP_LAYOUT,
  type InlineContextChipLayout,
  isSameInlineContextChipLayout,
  resolveInlineContextChipHeight,
} from './inlineContextChipLayout';

export interface InlineContextChipItem {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Tooltip and accessible name prefix for the remove action. */
  removeLabel: string;
  tone: ContextChipTone;
  onRemove: () => void;
}

interface InlineContextChipFrame {
  left: number;
  top: number;
  width: number;
  /** The textarea's font size; chips match it so they read as part of the text. */
  fontSize: number;
  chipHeight: number;
}

interface InlineContextChipMeasurement {
  frame: InlineContextChipFrame;
  layout: InlineContextChipLayout;
}

// Narrower than this beside the last chip, typing starts on the next row.
const MIN_TEXT_WIDTH_PX = 64;

const isSameFrame = (a: InlineContextChipFrame, b: InlineContextChipFrame): boolean =>
  a.left === b.left
  && a.top === b.top
  && a.width === b.width
  && a.fontSize === b.fontSize
  && a.chipHeight === b.chipHeight;

/** Reads the textarea's class padding, without the chip offset this hook applies inline. */
const readBasePaddingTop = (textarea: HTMLTextAreaElement): number => {
  const inlinePaddingTop = textarea.style.paddingTop;
  textarea.style.paddingTop = '';
  const paddingTop = parseFloat(getComputedStyle(textarea).paddingTop) || 0;
  textarea.style.paddingTop = inlinePaddingTop;
  return paddingTop;
};

export interface InlineContextChipsState {
  items: InlineContextChipItem[];
  active: boolean;
  layerRef: React.RefObject<HTMLDivElement>;
  measurement: InlineContextChipMeasurement | null;
  armedChipId: string | null;
  /** Inline style that makes the textarea (and its mirrors) flow text after the chips. */
  textStyle: React.CSSProperties | undefined;
  /** Returns true when the key press was consumed by the chips. */
  handleKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>, isComposing: boolean) => boolean;
}

export function useInlineContextChips({
  textareaRef,
  items,
  enabled,
}: {
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  items: InlineContextChipItem[];
  enabled: boolean;
}): InlineContextChipsState {
  const layerRef = useRef<HTMLDivElement>(null);
  const [measurement, setMeasurement] = useState<InlineContextChipMeasurement | null>(null);
  const [armedId, setArmedId] = useState<string | null>(null);
  const active = enabled && items.length > 0;
  const itemsKey = items.map(item => `${item.id}\u0000${item.label}`).join('\u0001');
  const armedChipId = active && items.some(item => item.id === armedId) ? armedId : null;

  const measure = useCallback(() => {
    const textarea = textareaRef.current;
    const layer = layerRef.current;
    if (!textarea || !layer) return;
    const textareaStyle = getComputedStyle(textarea);
    const paddingLeft = parseFloat(textareaStyle.paddingLeft) || 0;
    const paddingRight = parseFloat(textareaStyle.paddingRight) || 0;
    const fontSize = parseFloat(textareaStyle.fontSize) || 14;
    const lineHeight = parseFloat(textareaStyle.lineHeight) || fontSize * 1.5;
    const width = Math.max(0, Math.floor(textarea.clientWidth - paddingLeft - paddingRight));
    const layerStyle = getComputedStyle(layer);
    const lastChip = layer.lastElementChild instanceof HTMLElement ? layer.lastElementChild : null;
    const next: InlineContextChipMeasurement = {
      frame: {
        left: paddingLeft,
        top: readBasePaddingTop(textarea),
        width,
        fontSize,
        chipHeight: resolveInlineContextChipHeight(fontSize),
      },
      layout: computeInlineContextChipLayout({
        lastChip: lastChip
          ? {
            top: lastChip.offsetTop,
            right: lastChip.offsetLeft + lastChip.offsetWidth,
            height: lastChip.offsetHeight,
          }
          : null,
        contentWidth: width,
        lineHeight,
        columnGap: parseFloat(layerStyle.columnGap) || 0,
        rowGap: parseFloat(layerStyle.rowGap) || 0,
        minTextWidth: MIN_TEXT_WIDTH_PX,
      }),
    };
    setMeasurement(prev => (
      prev && isSameFrame(prev.frame, next.frame) && isSameInlineContextChipLayout(prev.layout, next.layout)
        ? prev
        : next
    ));
  }, [textareaRef]);

  const frameWidth = measurement?.frame.width;
  const frameFontSize = measurement?.frame.fontSize;
  // Re-measures synchronously after the layer takes the measured width and
  // font size, so chips wrap correctly before the first paint.
  useLayoutEffect(() => {
    if (!active) {
      setMeasurement(null);
      return;
    }
    measure();
  }, [active, itemsKey, frameWidth, frameFontSize, measure]);

  useEffect(() => {
    if (!active || typeof ResizeObserver === 'undefined') return;
    const textarea = textareaRef.current;
    const layer = layerRef.current;
    if (!textarea || !layer) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(textarea);
    observer.observe(layer);
    return () => observer.disconnect();
  }, [active, measure, textareaRef]);

  useEffect(() => {
    if (!armedChipId) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    const disarm = () => setArmedId(null);
    textarea.addEventListener('blur', disarm);
    textarea.addEventListener('mousedown', disarm);
    textarea.addEventListener('input', disarm);
    return () => {
      textarea.removeEventListener('blur', disarm);
      textarea.removeEventListener('mousedown', disarm);
      textarea.removeEventListener('input', disarm);
    };
  }, [armedChipId, textareaRef]);

  // Backspace at the very start of the text works like deleting a token: the
  // first press highlights the last chip, the second removes it.
  const handleKeyDown = useCallback((
    event: React.KeyboardEvent<HTMLTextAreaElement>,
    isComposing: boolean,
  ): boolean => {
    if (!active) return false;
    const textarea = event.currentTarget;
    const isPlainBackspace = event.key === 'Backspace'
      && !isComposing
      && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    if (!isPlainBackspace || textarea.selectionStart !== 0 || textarea.selectionEnd !== 0) {
      if (armedChipId && event.key !== 'Shift') setArmedId(null);
      return false;
    }
    event.preventDefault();
    const lastItem = items[items.length - 1];
    if (armedChipId === lastItem.id) {
      setArmedId(null);
      lastItem.onRemove();
    } else {
      setArmedId(lastItem.id);
    }
    return true;
  }, [active, armedChipId, items]);

  const textStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (!active || !measurement) return undefined;
    const { frame, layout } = measurement;
    return {
      paddingTop: `${frame.top + layout.textOffsetTop}px`,
      textIndent: `${layout.textIndent}px`,
    };
  }, [active, measurement]);

  return {
    items,
    active,
    layerRef,
    measurement,
    armedChipId,
    textStyle,
    handleKeyDown,
  };
}

const REMOVABLE_CHIP_CLASS = `${CONTEXT_CHIP_CLASS} group pointer-events-auto animate-scale-in transition-[background-color,border-color,box-shadow] duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30`;

const REMOVABLE_CHIP_TONE_CLASS: Record<ContextChipTone, string> = {
  [ContextChipTone.Reference]: `${CONTEXT_CHIP_TONE_CLASS[ContextChipTone.Reference]} hover:bg-surface-raised`,
  [ContextChipTone.Mode]: `${CONTEXT_CHIP_TONE_CLASS[ContextChipTone.Mode]} hover:border-primary/30`,
};

// Replaces the tone colors while Backspace has the chip lined up for removal.
const CHIP_ARMED_CLASS = 'border-primary/60 bg-primary-muted ring-2 ring-primary/20';

const InlineContextChip: React.FC<{
  item: InlineContextChipItem;
  armed: boolean;
}> = ({ item, armed }) => {
  const Icon = item.icon;
  return (
    <button
      type="button"
      // Keep focus (and the caret) in the textarea when a chip is removed.
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.stopPropagation();
        item.onRemove();
      }}
      className={`${REMOVABLE_CHIP_CLASS} ${armed ? CHIP_ARMED_CLASS : REMOVABLE_CHIP_TONE_CLASS[item.tone]}`}
      title={item.removeLabel}
      aria-label={`${item.removeLabel}: ${item.label}`}
    >
      <span className="relative flex h-[1em] w-[1em] shrink-0 items-center justify-center">
        <Icon
          className={`h-[1em] w-[1em] transition-opacity group-hover:opacity-0 ${CONTEXT_CHIP_ICON_TONE_CLASS[item.tone]} ${armed ? 'opacity-0' : ''}`}
        />
        <XMarkIcon
          className={`absolute h-[0.8em] w-[0.8em] transition-opacity group-hover:opacity-100 ${CONTEXT_CHIP_ICON_TONE_CLASS[item.tone]} ${armed ? 'opacity-100' : 'opacity-0'}`}
        />
      </span>
      <span className="min-w-0 truncate">{item.label}</span>
    </button>
  );
};

/**
 * Chips drawn over the start of the textarea. Render it inside the textarea's
 * positioned wrapper, before the textarea, so tab order follows reading order.
 */
export const InlineContextChipLayer: React.FC<{
  chips: InlineContextChipsState;
  scrollTop: number;
}> = ({ chips, scrollTop }) => {
  if (!chips.active) return null;
  const frame = chips.measurement?.frame;
  const layout = chips.measurement?.layout ?? EMPTY_INLINE_CONTEXT_CHIP_LAYOUT;
  const layerStyle = {
    left: frame?.left ?? 0,
    top: (frame?.top ?? 0) + layout.layerOffsetTop,
    width: frame?.width,
    fontSize: frame ? `${frame.fontSize}px` : undefined,
    [CONTEXT_CHIP_HEIGHT_VAR]: frame ? `${frame.chipHeight}px` : undefined,
    transform: scrollTop ? `translateY(-${scrollTop}px)` : undefined,
    visibility: frame ? undefined : 'hidden',
  } as React.CSSProperties;
  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      <div
        ref={chips.layerRef}
        className="absolute flex flex-wrap items-start gap-x-1.5 gap-y-1"
        style={layerStyle}
      >
        {chips.items.map(item => (
          <InlineContextChip key={item.id} item={item} armed={chips.armedChipId === item.id} />
        ))}
      </div>
    </div>
  );
};
