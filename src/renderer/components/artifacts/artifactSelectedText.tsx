import React, { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

import {
  type CoworkSelectedTextSnippet,
  CoworkSelectedTextSource,
} from '../../../shared/cowork/selectedText';
import { i18nService } from '../../services/i18n';
import type { Artifact } from '../../types/artifact';

export interface ArtifactSelectedTextContext {
  enabled: boolean;
  onAddSelectedText: (snippet: CoworkSelectedTextSnippet) => void;
}

/** A chat excerpt from an artifact; `title` names where in it the text is (default: the file). */
export function artifactSnippet(artifact: Artifact, sourceType: CoworkSelectedTextSource, text: string, title?: string): CoworkSelectedTextSnippet {
  const fileTitle = artifact.fileName || artifact.title;
  return {
    id: `selected-text-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text,
    sourceId: artifact.id,
    sourceType,
    artifactId: artifact.id,
    sourceTitle: title ? `${fileTitle} · ${title}` : fileTitle,
    ...(artifact.filePath ? { sourcePath: artifact.filePath } : {}),
    createdAt: Date.now(),
  };
}

const SELECTED_TEXT_ACTION_HALF_WIDTH = 72;
const SELECTED_TEXT_ACTION_SUPPRESS_MS = 250;

const nodeToElement = (node: Node): Element | null => (
  node instanceof Element ? node : node.parentElement
);

const getSelectionAnchorRect = (range: Range): DOMRect => {
  const lineRects = Array.from(range.getClientRects())
    .filter(rect => rect.width > 0 && rect.height > 0);
  return lineRects[0] ?? range.getBoundingClientRect();
};

const getSelectedTextActionLeft = (rect: DOMRect, container: HTMLDivElement): number => {
  const containerRect = container.getBoundingClientRect();
  const selectionCenterX = rect.left - containerRect.left + rect.width / 2;
  return Math.min(
    container.clientWidth - SELECTED_TEXT_ACTION_HALF_WIDTH,
    Math.max(SELECTED_TEXT_ACTION_HALF_WIDTH, selectionCenterX),
  );
};

const getSelectedTextActionTop = (
  rect: DOMRect,
  container: HTMLDivElement,
): number => {
  const containerRect = container.getBoundingClientRect();
  const rawTop = container.scrollTop + rect.top - containerRect.top - 42;
  const minTop = container.scrollTop + 8;
  const maxTop = container.scrollTop + container.clientHeight - 48;
  return Math.min(maxTop, Math.max(minTop, rawTop));
};

const logArtifactSelectedTextDiagnostic = (message: string): void => {
  console.debug(`[ArtifactSelectedText] ${message}`);
  window.electron?.log?.fromRenderer?.('debug', 'ArtifactSelectedText', message);
};

export function useArtifactSelectedTextAction(options: {
  artifact: Artifact;
  sourceType: typeof CoworkSelectedTextSource.ArtifactMarkdown | typeof CoworkSelectedTextSource.ArtifactText;
  selectedTextContext?: ArtifactSelectedTextContext;
}) {
  const { artifact, selectedTextContext, sourceType } = options;
  const containerRef = useRef<HTMLDivElement>(null);
  const suppressSelectedTextActionUntilRef = useRef(0);
  const [selectedTextAction, setSelectedTextAction] = useState<{
    text: string;
    left: number;
    top: number;
  } | null>(null);

  const closeSelectedTextAction = useCallback((closeOptions: {
    clearSelection?: boolean;
    suppressNextMouseUp?: boolean;
  } = {}) => {
    if (closeOptions.suppressNextMouseUp) {
      suppressSelectedTextActionUntilRef.current = Date.now() + SELECTED_TEXT_ACTION_SUPPRESS_MS;
    }
    if (closeOptions.clearSelection) {
      window.getSelection()?.removeAllRanges();
    }
    setSelectedTextAction(null);
  }, []);

  const handleMouseUp = useCallback(() => {
    if (!selectedTextContext?.enabled) return;
    if (Date.now() < suppressSelectedTextActionUntilRef.current) return;
    suppressSelectedTextActionUntilRef.current = 0;

    const container = containerRef.current;
    const selection = window.getSelection();
    if (!container || !selection || selection.isCollapsed || selection.rangeCount === 0) {
      closeSelectedTextAction();
      return;
    }

    const range = selection.getRangeAt(0);
    const startElement = nodeToElement(range.startContainer);
    const endElement = nodeToElement(range.endContainer);
    const text = selection.toString().trim();
    if (!text || !startElement || !endElement || !container.contains(startElement) || !container.contains(endElement)) {
      closeSelectedTextAction();
      return;
    }

    const rect = getSelectionAnchorRect(range);
    setSelectedTextAction({
      text,
      left: getSelectedTextActionLeft(rect, container),
      top: getSelectedTextActionTop(rect, container),
    });
    logArtifactSelectedTextDiagnostic(
      `prepared an add-to-chat action for ${sourceType} artifact ${artifact.id}; selected ${text.length} characters`,
    );
  }, [artifact.id, closeSelectedTextAction, selectedTextContext?.enabled, sourceType]);

  const handleAddSelectedText = useCallback(() => {
    if (!selectedTextAction || !selectedTextContext?.enabled) return;
    selectedTextContext.onAddSelectedText(artifactSnippet(artifact, sourceType, selectedTextAction.text));
    closeSelectedTextAction({ clearSelection: true });
  }, [artifact, closeSelectedTextAction, selectedTextAction, selectedTextContext, sourceType]);

  useEffect(() => {
    closeSelectedTextAction({ clearSelection: true });
  }, [artifact.id, closeSelectedTextAction]);

  useEffect(() => {
    if (!selectedTextContext?.enabled) {
      closeSelectedTextAction({ clearSelection: true });
    }
  }, [closeSelectedTextAction, selectedTextContext?.enabled]);

  useEffect(() => {
    if (!selectedTextAction) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-cowork-selected-text-action]')) {
        return;
      }
      closeSelectedTextAction({ clearSelection: true, suppressNextMouseUp: true });
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeSelectedTextAction({ clearSelection: true });
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeSelectedTextAction, selectedTextAction]);

  const actionButton = selectedTextAction ? (
    <button
      type="button"
      data-cowork-selected-text-action
      onClick={handleAddSelectedText}
      className="absolute z-40 -translate-x-1/2 rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground shadow-popover transition-colors hover:bg-surface-raised"
      style={{ left: selectedTextAction.left, top: selectedTextAction.top }}
    >
      {i18nService.t('coworkSelectedTextAddToChat')}
    </button>
  ) : null;

  return {
    actionButton,
    containerRef,
    handleMouseUp,
  };
}

/**
 * "Add to chat" for text selected in an editor that owns its scrolling DOM (the Word editor),
 * where the button cannot live inside the scrolled content: it floats in `frame` (positioned)
 * above the selection and goes away on scrolling, typing or a press elsewhere. Such editors cancel
 * pointerdown, so no mouse events follow: the selection is read on pointerup.
 */
export function useEditorSelectionChat(options: {
  frame: RefObject<HTMLElement>;
  content: RefObject<HTMLElement>;
  /** The editor's own reading of the selection, when it has one. */
  selectedText?: () => string | undefined;
  onAdd?: (text: string) => void;
}) {
  const { frame, content, selectedText, onAdd } = options;
  const [action, setAction] = useState<{ text: string; left: number; top: number } | null>(null);

  const handlePointerUp = useCallback((event: React.PointerEvent) => {
    if (event.target instanceof Element && event.target.closest('[data-cowork-selected-text-action]')) return;
    const box = frame.current;
    const selection = window.getSelection();
    if (!onAdd || !box || !selection || selection.isCollapsed || selection.rangeCount === 0) {
      setAction(null);
      return;
    }
    const range = selection.getRangeAt(0);
    if (!content.current?.contains(range.commonAncestorContainer)) {
      setAction(null);
      return;
    }
    const text = (selectedText?.() ?? selection.toString()).trim();
    if (!text) {
      setAction(null);
      return;
    }
    const rect = getSelectionAnchorRect(range);
    const frameRect = box.getBoundingClientRect();
    setAction({
      text,
      left: Math.min(box.clientWidth - SELECTED_TEXT_ACTION_HALF_WIDTH, Math.max(SELECTED_TEXT_ACTION_HALF_WIDTH, rect.left - frameRect.left + rect.width / 2)),
      top: Math.max(8, rect.top - frameRect.top - 42),
    });
  }, [content, frame, onAdd, selectedText]);

  useEffect(() => {
    if (!action) return undefined;
    const close = () => setAction(null);
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-cowork-selected-text-action]')) return;
      close();
    };
    const scroller = content.current;
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', close);
    scroller?.addEventListener('scroll', close, { passive: true });
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', close);
      scroller?.removeEventListener('scroll', close);
    };
  }, [action, content]);

  useEffect(() => { if (!onAdd) setAction(null); }, [onAdd]);

  const button = action && onAdd ? (
    <button
      type="button"
      data-cowork-selected-text-action
      onMouseDown={event => event.preventDefault()}
      onClick={() => { onAdd(action.text); setAction(null); }}
      className="absolute z-40 -translate-x-1/2 rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground shadow-popover transition-colors hover:bg-surface-raised"
      style={{ left: action.left, top: action.top }}
    >
      {i18nService.t('coworkSelectedTextAddToChat')}
    </button>
  ) : null;

  return { handlePointerUp, button };
}
