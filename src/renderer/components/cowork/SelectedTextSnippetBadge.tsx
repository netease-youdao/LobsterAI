import React, { useEffect, useRef, useState } from 'react';

import {
  type CoworkSelectedTextSnippet,
  CoworkSelectedTextSource,
} from '../../../shared/cowork/selectedText';
import { i18nService } from '../../services/i18n';
import SelectedTextIcon from '../icons/SelectedTextIcon';
import XMarkIcon from '../icons/XMarkIcon';

interface SelectedTextSnippetBadgeProps {
  snippets: CoworkSelectedTextSnippet[];
  align?: 'left' | 'right';
  onClear?: () => void;
  onRemove?: (snippetId: string) => void;
  onLocate?: (sourceMessageId: string) => void;
}

const SELECTED_TEXT_POPOVER_MIN_WIDTH_UNITS = 14;
const SELECTED_TEXT_POPOVER_MAX_WIDTH_UNITS = 34;
const SELECTED_TEXT_POPOVER_CHROME_WIDTH_UNITS = 7;

const getApproximateTextWidthUnits = (value: string): number => (
  Array.from(value).reduce((total, character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return total + (codePoint > 0xff ? 2 : 1);
  }, 0)
);

const clampSelectedTextPopoverWidth = (widthUnits: number): number => (
  Math.min(
    SELECTED_TEXT_POPOVER_MAX_WIDTH_UNITS,
    Math.max(SELECTED_TEXT_POPOVER_MIN_WIDTH_UNITS, widthUnits),
  )
);

const SelectedTextSnippetBadge: React.FC<SelectedTextSnippetBadgeProps> = ({
  snippets,
  align = 'left',
  onClear,
  onRemove,
  onLocate,
}) => {
  const [expanded, setExpanded] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!expanded) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      setExpanded(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [expanded]);

  const getSourceLabel = (snippet: CoworkSelectedTextSnippet): string => {
    const sourceType = snippet.sourceType ?? snippet.sourceMessageType;
    if (snippet.sourceTitle?.trim()) return snippet.sourceTitle.trim();
    if (sourceType === CoworkSelectedTextSource.ArtifactMarkdown) {
      return i18nService.t('coworkSelectedTextArtifactMarkdownSource');
    }
    if (sourceType === CoworkSelectedTextSource.ArtifactText) {
      return i18nService.t('coworkSelectedTextArtifactTextSource');
    }
    return '';
  };

  if (snippets.length === 0) return null;
  const canRemove = Boolean(onClear || onRemove);
  const popoverAlignmentClass = align === 'right' ? 'right-0' : 'left-0';
  const popoverOriginClass = align === 'right' ? 'origin-bottom-right' : 'origin-bottom-left';
  const pillSurfaceClass = expanded
    ? 'bg-surface-raised/70'
    : 'bg-surface hover:bg-surface-raised/50';
  const popoverWidthUnits = clampSelectedTextPopoverWidth(
    snippets.reduce((longestWidth, snippet) => {
      const sourceLabelWidth = getApproximateTextWidthUnits(getSourceLabel(snippet));
      const snippetTextWidth = getApproximateTextWidthUnits(snippet.text);
      return Math.max(longestWidth, sourceLabelWidth, snippetTextWidth);
    }, 0) + SELECTED_TEXT_POPOVER_CHROME_WIDTH_UNITS,
  );
  const popoverStyle: React.CSSProperties = {
    width: `min(calc(100vw - 48px), ${popoverWidthUnits}ch)`,
  };
  const handleClear = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setExpanded(false);
    if (onClear) {
      onClear();
      return;
    }
    snippets.forEach(snippet => onRemove?.(snippet.id));
  };

  return (
    <div ref={rootRef} className="group relative inline-flex max-w-full">
      <div className={`inline-flex h-7 max-w-full items-center rounded-full border border-border text-xs text-foreground shadow-subtle transition-colors ${pillSurfaceClass}`}>
        <button
          type="button"
          onClick={() => setExpanded(value => !value)}
          aria-expanded={expanded}
          className="inline-flex h-full min-w-0 items-center gap-1.5 rounded-full pl-2.5 pr-2 text-left"
        >
          <SelectedTextIcon className="h-4 w-4 shrink-0 text-secondary" />
          <span className="min-w-0 truncate">
            {i18nService.t('coworkSelectedTextSnippetCount').replace('{count}', String(snippets.length))}
          </span>
        </button>
        {canRemove && (
          <button
            type="button"
            onClick={handleClear}
            className="pointer-events-none mr-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted opacity-0 transition-all hover:bg-surface-raised hover:text-foreground group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
            title={i18nService.t('coworkSelectedTextRemove')}
            aria-label={i18nService.t('coworkSelectedTextRemove')}
          >
            <XMarkIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {expanded && (
        <div
          className={`absolute bottom-full ${popoverAlignmentClass} z-50 mb-1.5 max-w-[calc(100vw-48px)] ${popoverOriginClass} animate-scale-in rounded-xl border border-border bg-surface p-1.5 shadow-popover`}
          style={popoverStyle}
        >
          <div className="flex max-h-56 max-w-full flex-col items-stretch gap-1 overflow-y-auto">
            {snippets.map(snippet => (
              <div key={snippet.id} className="group/snippet relative flex w-full items-start gap-1 rounded-lg bg-surface-raised/40 py-1.5 pl-3.5 pr-1.5 text-xs text-secondary transition-colors hover:bg-surface-raised/80">
                <span aria-hidden="true" className="absolute inset-y-1.5 left-1.5 w-0.5 rounded-full bg-primary/40 transition-colors group-hover/snippet:bg-primary/60" />
                <button
                  type="button"
                  onClick={() => {
                    if (snippet.sourceMessageId) {
                      onLocate?.(snippet.sourceMessageId);
                    }
                  }}
                  disabled={!onLocate || !snippet.sourceMessageId}
                  className="min-w-0 flex-1 text-left disabled:cursor-default"
                  title={[getSourceLabel(snippet), snippet.text].filter(Boolean).join('\n')}
                >
                  {getSourceLabel(snippet) && (
                    <div className="mb-0.5 truncate text-[11px] font-medium text-foreground">
                      {getSourceLabel(snippet)}
                    </div>
                  )}
                  <div className="truncate">{snippet.text}</div>
                </button>
                {onRemove && (
                  <button
                    type="button"
                    onClick={() => onRemove(snippet.id)}
                    className="pointer-events-none shrink-0 rounded-md p-0.5 text-muted opacity-0 transition-all hover:bg-surface hover:text-foreground focus-visible:opacity-100 group-hover/snippet:pointer-events-auto group-hover/snippet:opacity-100 group-focus-within/snippet:pointer-events-auto group-focus-within/snippet:opacity-100"
                    title={i18nService.t('coworkSelectedTextRemove')}
                  >
                    <XMarkIcon className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default SelectedTextSnippetBadge;
