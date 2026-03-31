import { useState, useEffect, useCallback } from 'react';
import type { RefObject } from 'react';
import type { ToolbarPosition, UseTextSelectionReturn } from './types';

const TOOLBAR_HEIGHT = 40;
const GAP = 8;

/**
 * Custom hook for detecting text selection within a container and computing
 * toolbar position. Returns the selected text, toolbar position, and a
 * function to programmatically clear the selection.
 *
 * Key design decisions:
 * - mouseup + setTimeout(0) ensures the browser has finalized the selection
 * - position: fixed coordinates are computed from Range.getBoundingClientRect()
 * - Toolbar is hidden on scroll, outside click, or Escape key
 */
export function useTextSelection(
  containerRef: RefObject<HTMLElement | null>,
  scrollContainerRef: RefObject<HTMLElement | null>,
): UseTextSelectionReturn {
  const [selectedText, setSelectedText] = useState('');
  const [position, setPosition] = useState<ToolbarPosition>({
    x: 0,
    y: 0,
    visible: false,
  });

  const hideToolbar = useCallback(() => {
    setPosition(prev => {
      // Avoid unnecessary state updates when already hidden
      if (!prev.visible) return prev;
      return { ...prev, visible: false };
    });
    setSelectedText('');
  }, []);

  // Core: mouseup handler with setTimeout(0) to wait for browser selection finalization
  const handleMouseUp = useCallback(() => {
    setTimeout(() => {
      const sel = window.getSelection();

      // Selection must be non-collapsed and contain non-whitespace text
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        hideToolbar();
        return;
      }

      // Verify the selection is within the target container
      const range = sel.getRangeAt(0);
      const container = containerRef.current;
      if (container && !container.contains(range.commonAncestorContainer)) {
        return;
      }

      // Compute toolbar position from selection rect (viewport coordinates)
      const rect = range.getBoundingClientRect();

      // Horizontal: centered on the selection
      const x = rect.left + rect.width / 2;

      // Vertical: prefer above the selection; flip below if insufficient space
      const spaceAbove = rect.top;
      const spaceBelow = window.innerHeight - rect.bottom;
      let y: number;
      if (spaceAbove >= TOOLBAR_HEIGHT + GAP) {
        y = rect.top - TOOLBAR_HEIGHT - GAP;
      } else if (spaceBelow >= TOOLBAR_HEIGHT + GAP) {
        y = rect.bottom + GAP;
      } else {
        y = Math.max(GAP, rect.top - TOOLBAR_HEIGHT - GAP);
      }

      setSelectedText(sel.toString());
      setPosition({ x, y, visible: true });
    }, 0);
  }, [containerRef, hideToolbar]);

  // Listen for mouseup on the message container (scoped, not document-wide)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.addEventListener('mouseup', handleMouseUp);
    return () => container.removeEventListener('mouseup', handleMouseUp);
  }, [containerRef, handleMouseUp]);

  // Hide toolbar on scroll to prevent position drift
  useEffect(() => {
    const scrollEl = scrollContainerRef.current;
    if (!scrollEl) return;
    scrollEl.addEventListener('scroll', hideToolbar, { passive: true });
    return () => scrollEl.removeEventListener('scroll', hideToolbar);
  }, [scrollContainerRef, hideToolbar]);

  // Hide toolbar when clicking outside it
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Element;
      if (!target.closest('[data-selection-toolbar]')) {
        hideToolbar();
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [hideToolbar]);

  // Hide toolbar on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hideToolbar();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [hideToolbar]);

  const clearSelection = useCallback(() => {
    hideToolbar();
    window.getSelection()?.removeAllRanges();
  }, [hideToolbar]);

  return { selectedText, position, clearSelection };
}
