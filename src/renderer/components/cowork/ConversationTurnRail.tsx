import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '../../services/i18n';
import {
  buildVisualRailTicks,
  type ConversationRailItem,
  filterRailOutlineItems,
  getRailOutlinePopoverGeometry,
  getVisualRailLineWidth,
  RAIL_LINE_HEIGHT,
  RAIL_OUTLINE_FILTER_THRESHOLD,
  type RailOutlinePopoverGeometry,
} from './conversationRailDisplay';
import {
  buildRailTooltipContent,
  formatRailTurnPosition,
} from './conversationRailTooltip';

const OUTLINE_OPEN_DELAY_MS = 80;
const OUTLINE_CLOSE_DELAY_MS = 180;

export interface ConversationTurnRailProps {
  sessionId?: string;
  railItems: ConversationRailItem[];
  currentRailIndex: number;
  hasPlaceholderItems: boolean;
  onNavigateToRailItem: (
    railIndex: number,
    actionType: 'rail_item_click' | 'rail_prev_click' | 'rail_next_click',
  ) => void;
  onScrollToBottom?: () => void;
}

const ConversationTurnRail: React.FC<ConversationTurnRailProps> = ({
  sessionId,
  railItems,
  currentRailIndex,
  hasPlaceholderItems,
  onNavigateToRailItem,
  onScrollToBottom,
}) => {
  const railContainerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const listContainerRef = useRef<HTMLDivElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [isRailHovered, setIsRailHovered] = useState(false);
  const [hoveredSlotIndex, setHoveredSlotIndex] = useState<number | null>(null);
  const [isOutlineOpen, setIsOutlineOpen] = useState(false);
  const [isOutlinePinned, setIsOutlinePinned] = useState(false);
  const [isPopoverHovered, setIsPopoverHovered] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const [popoverGeometry, setPopoverGeometry] = useState<RailOutlinePopoverGeometry | null>(null);

  const totalCount = railItems.length;
  const resolvedRailIndex = currentRailIndex < 0 || currentRailIndex >= totalCount
    ? Math.max(0, totalCount - 1)
    : currentRailIndex;

  const visualTicks = useMemo(
    () => buildVisualRailTicks(totalCount, resolvedRailIndex),
    [resolvedRailIndex, totalCount],
  );
  const activeSlotIndex = useMemo(() => {
    const idx = visualTicks.findIndex(tick => tick.isActive);
    return idx >= 0 ? idx : Math.max(0, visualTicks.length - 1);
  }, [visualTicks]);

  const previewRailIndex = hoveredSlotIndex !== null
    ? (visualTicks[hoveredSlotIndex]?.targetRailIndex ?? null)
    : null;

  const showFilterInput = totalCount >= RAIL_OUTLINE_FILTER_THRESHOLD && !hasPlaceholderItems;
  const filteredEntries = useMemo(
    () => (showFilterInput ? filterRailOutlineItems(railItems, filterQuery) : railItems.map((item, railIndex) => ({ item, railIndex }))),
    [filterQuery, railItems, showFilterInput],
  );

  const tooltipLabels = useMemo(() => ({
    unloadedTitle: i18nService.t('coworkRailUnloadedMessageTitle'),
    unloadedHint: i18nService.t('coworkRailUnloadedMessageHint'),
    turnPositionTemplate: i18nService.t('coworkRailTurnPosition'),
  }), []);

  const headerPositionText = hasPlaceholderItems
    ? ''
    : formatRailTurnPosition(
      previewRailIndex ?? resolvedRailIndex,
      totalCount,
      tooltipLabels.turnPositionTemplate,
    );

  const clearTimers = useCallback(() => {
    if (openTimerRef.current !== null) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const updatePopoverGeometry = useCallback(() => {
    const railEl = railContainerRef.current;
    if (!railEl) return;
    const rect = railEl.getBoundingClientRect();
    setPopoverGeometry(getRailOutlinePopoverGeometry(rect, {
      width: window.innerWidth,
      height: window.innerHeight,
    }));
  }, []);

  const closeOutline = useCallback(() => {
    clearTimers();
    setIsOutlineOpen(false);
    setIsOutlinePinned(false);
    setIsPopoverHovered(false);
    setHoveredSlotIndex(null);
    setFilterQuery('');
  }, [clearTimers]);

  const scheduleOpenOutline = useCallback(() => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (isOutlineOpen) {
      updatePopoverGeometry();
      return;
    }
    if (openTimerRef.current !== null) return;
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = null;
      updatePopoverGeometry();
      setIsOutlineOpen(true);
    }, OUTLINE_OPEN_DELAY_MS);
  }, [isOutlineOpen, updatePopoverGeometry]);

  const scheduleCloseOutline = useCallback(() => {
    if (openTimerRef.current !== null) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (isOutlinePinned) return;
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
    }
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setIsOutlineOpen(false);
      setHoveredSlotIndex(null);
      setFilterQuery('');
    }, OUTLINE_CLOSE_DELAY_MS);
  }, [isOutlinePinned]);

  useEffect(() => clearTimers, [clearTimers]);

  // Close any open or pinned outline when switching sessions.
  useEffect(() => {
    closeOutline();
  }, [closeOutline, sessionId]);

  // Keep popover anchored if the window resizes while open.
  useEffect(() => {
    if (!isOutlineOpen) return undefined;
    updatePopoverGeometry();
    const handleResize = () => updatePopoverGeometry();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [isOutlineOpen, updatePopoverGeometry]);

  // Dismiss pinned or open outline on Escape or outside click.
  useEffect(() => {
    if (!isOutlineOpen) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeOutline();
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (railContainerRef.current?.contains(target) || popoverRef.current?.contains(target)) {
        return;
      }
      closeOutline();
    };
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [closeOutline, isOutlineOpen]);

  // Scroll the target turn row into view inside the outline when opening or scrubbing ticks.
  const targetRowIndex = isPopoverHovered
    ? null
    : (previewRailIndex ?? resolvedRailIndex);

  useEffect(() => {
    if (!isOutlineOpen || targetRowIndex === null || filterQuery.trim()) return;
    const listEl = listContainerRef.current;
    if (!listEl) return;
    const rowEl = listEl.querySelector<HTMLElement>(`[data-rail-outline-index="${targetRowIndex}"]`);
    if (!rowEl) return;

    const listRect = listEl.getBoundingClientRect();
    const rowRect = rowEl.getBoundingClientRect();
    const desiredTop = rowEl.offsetTop - (listEl.clientHeight - rowEl.offsetHeight) / 2;
    const isRowOutsideViewport = rowRect.top < listRect.top + 8 || rowRect.bottom > listRect.bottom - 8;
    if (isRowOutsideViewport) {
      listEl.scrollTop = Math.max(0, desiredTop);
    }
  }, [filterQuery, isOutlineOpen, targetRowIndex]);

  const handleTogglePinOutline = useCallback(() => {
    clearTimers();
    if (isOutlineOpen && isOutlinePinned) {
      closeOutline();
      return;
    }
    updatePopoverGeometry();
    setIsOutlineOpen(true);
    setIsOutlinePinned(true);
  }, [clearTimers, closeOutline, isOutlineOpen, isOutlinePinned, updatePopoverGeometry]);

  const handleSelectOutlineTurn = useCallback((railIndex: number) => {
    onNavigateToRailItem(railIndex, 'rail_item_click');
    closeOutline();
  }, [closeOutline, onNavigateToRailItem]);

  const handleJumpFirst = useCallback(() => {
    if (totalCount <= 0) return;
    onNavigateToRailItem(0, 'rail_item_click');
    closeOutline();
  }, [closeOutline, onNavigateToRailItem, totalCount]);

  const handleJumpLatest = useCallback(() => {
    if (totalCount <= 0) return;
    if (onScrollToBottom) {
      onScrollToBottom();
    } else {
      onNavigateToRailItem(totalCount - 1, 'rail_item_click');
    }
    closeOutline();
  }, [closeOutline, onNavigateToRailItem, onScrollToBottom, totalCount]);

  const isRailActive = isRailHovered || isOutlineOpen;

  return (
    <>
      <div
        ref={railContainerRef}
        className="absolute right-[18px] top-1/2 -translate-y-1/2 w-5 flex flex-col items-end z-10"
        style={{ maxHeight: 'calc(100% - 40px)' }}
        onMouseEnter={() => {
          setIsRailHovered(true);
          scheduleOpenOutline();
        }}
        onMouseLeave={() => {
          setIsRailHovered(false);
          setHoveredSlotIndex(null);
          scheduleCloseOutline();
        }}
      >
        {/* Up Arrow */}
        <button
          type="button"
          onClick={() => {
            if (resolvedRailIndex <= 0) return;
            onNavigateToRailItem(resolvedRailIndex - 1, 'rail_prev_click');
          }}
          onMouseEnter={() => { setHoveredSlotIndex(null); }}
          aria-label={i18nService.t('coworkRailPrevTurn')}
          title={i18nService.t('coworkRailPrevTurn')}
          className={`shrink-0 flex items-center justify-center w-5 h-5 mb-1.5 -mr-[5px] rounded-full transition-all text-neutral-600 dark:text-neutral-400
            ${!isRailActive
              ? 'opacity-0 pointer-events-none'
              : resolvedRailIndex <= 0
                ? 'opacity-30 cursor-default'
                : 'cursor-pointer hover:text-neutral-800 dark:hover:text-neutral-200 hover:bg-neutral-200/60 dark:hover:bg-neutral-700/60'}`}
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-3.5 h-3.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
          </svg>
        </button>

        {/* Capped Visual Tick Lines (at most RAIL_MAX_VISUAL_TICKS) */}
        <div className="flex flex-col items-end">
          {visualTicks.map((tick) => {
            const isHighlighted = hoveredSlotIndex === null
              ? tick.isActive
              : tick.slotIndex === hoveredSlotIndex;
            const lineWidth = getVisualRailLineWidth(tick.slotIndex, activeSlotIndex, hoveredSlotIndex);
            return (
              <button
                key={`rail-slot-${tick.slotIndex}`}
                type="button"
                onClick={() => {
                  onNavigateToRailItem(tick.targetRailIndex, 'rail_item_click');
                }}
                onMouseEnter={() => {
                  setHoveredSlotIndex(tick.slotIndex);
                  scheduleOpenOutline();
                }}
                aria-label={formatRailTurnPosition(
                  tick.targetRailIndex,
                  totalCount,
                  tooltipLabels.turnPositionTemplate,
                )}
                className="flex items-center justify-end cursor-pointer w-5 py-[4.5px]"
              >
                <span
                  className={`block shrink-0 border-solid transition-[width,border-color] ${
                    isHighlighted
                      ? 'border-neutral-800 dark:border-neutral-200'
                      : 'border-neutral-300 dark:border-neutral-600'
                  }`}
                  style={{
                    width: lineWidth,
                    height: 0,
                    borderTopWidth: RAIL_LINE_HEIGHT,
                  }}
                />
              </button>
            );
          })}
        </div>

        {/* Down Arrow */}
        <button
          type="button"
          onClick={() => {
            if (resolvedRailIndex >= totalCount - 1) return;
            onNavigateToRailItem(resolvedRailIndex + 1, 'rail_next_click');
          }}
          onMouseEnter={() => { setHoveredSlotIndex(null); }}
          aria-label={i18nService.t('coworkRailNextTurn')}
          title={i18nService.t('coworkRailNextTurn')}
          className={`shrink-0 flex items-center justify-center w-5 h-5 mt-1.5 -mr-[5px] rounded-full transition-all text-neutral-600 dark:text-neutral-400
            ${!isRailActive
              ? 'opacity-0 pointer-events-none'
              : resolvedRailIndex >= totalCount - 1
                ? 'opacity-30 cursor-default'
                : 'cursor-pointer hover:text-neutral-800 dark:hover:text-neutral-200 hover:bg-neutral-200/60 dark:hover:bg-neutral-700/60'}`}
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-3.5 h-3.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
          </svg>
        </button>

        {/* Outline Pin Trigger */}
        <button
          type="button"
          onClick={handleTogglePinOutline}
          onMouseEnter={() => { setHoveredSlotIndex(null); }}
          aria-label={i18nService.t('coworkRailOutlineTitle')}
          title={i18nService.t('coworkRailOutlineTitle')}
          aria-expanded={isOutlineOpen}
          className={`shrink-0 flex items-center justify-center w-5 h-5 mt-1 -mr-[5px] rounded-full transition-all
            ${!isRailActive
              ? 'opacity-0 pointer-events-none'
              : isOutlinePinned
                ? 'cursor-pointer text-primary bg-primary/10'
                : 'cursor-pointer text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200 hover:bg-neutral-200/60 dark:hover:bg-neutral-700/60'}`}
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-3.5 h-3.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
          </svg>
        </button>
      </div>

      {/* Scrollable Turn Outline Popover */}
      {isOutlineOpen && popoverGeometry && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={i18nService.t('coworkRailOutlineTitle')}
          onMouseEnter={() => {
            setIsPopoverHovered(true);
            clearTimers();
          }}
          onMouseLeave={() => {
            setIsPopoverHovered(false);
            scheduleCloseOutline();
          }}
          className="fixed z-[100] flex flex-col overflow-hidden rounded-xl border border-neutral-200/85 bg-neutral-50/95 shadow-[0_6px_24px_rgba(15,23,42,0.14)] backdrop-blur-md dark:border-neutral-700/90 dark:bg-neutral-800/95 dark:shadow-[0_8px_28px_rgba(0,0,0,0.45)]"
          style={{
            top: popoverGeometry.top,
            right: popoverGeometry.right,
            width: popoverGeometry.width,
            maxHeight: popoverGeometry.maxHeight,
            transform: 'translateY(-50%)',
          }}
        >
          {/* Popover Header */}
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-neutral-200/75 px-3 py-2 dark:border-neutral-700/75">
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-xs font-semibold text-neutral-800 dark:text-neutral-100">
                {i18nService.t('coworkRailOutlineTitle')}
              </span>
              {headerPositionText && (
                <span className="truncate text-[11px] text-neutral-500 tabular-nums dark:text-neutral-400">
                  {headerPositionText}
                </span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                onClick={handleJumpFirst}
                disabled={resolvedRailIndex <= 0}
                aria-label={i18nService.t('coworkRailJumpFirst')}
                title={i18nService.t('coworkRailJumpFirst')}
                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-200/70 hover:text-neutral-900 disabled:cursor-default disabled:opacity-30 dark:text-neutral-400 dark:hover:bg-neutral-700/70 dark:hover:text-neutral-100"
              >
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="h-3.5 w-3.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 18.75l7.5-7.5 7.5 7.5M4.5 12.75l7.5-7.5 7.5 7.5" />
                </svg>
              </button>
              <button
                type="button"
                onClick={handleJumpLatest}
                aria-label={i18nService.t('coworkRailJumpLatest')}
                title={i18nService.t('coworkRailJumpLatest')}
                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-200/70 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-700/70 dark:hover:text-neutral-100"
              >
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="h-3.5 w-3.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 5.25l-7.5 7.5-7.5-7.5M19.5 11.25l-7.5 7.5-7.5-7.5" />
                </svg>
              </button>
            </div>
          </div>

          {/* Filter Input for Longer Conversations */}
          {showFilterInput && (
            <div className="shrink-0 border-b border-neutral-200/60 px-2.5 py-1.5 dark:border-neutral-700/60">
              <div className="relative flex items-center">
                <input
                  ref={filterInputRef}
                  type="text"
                  value={filterQuery}
                  onFocus={() => setIsOutlinePinned(true)}
                  onChange={(event) => setFilterQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && filteredEntries.length > 0) {
                      event.preventDefault();
                      handleSelectOutlineTurn(filteredEntries[0].railIndex);
                    } else if (event.key === 'Escape') {
                      event.stopPropagation();
                      if (filterQuery) {
                        setFilterQuery('');
                      } else {
                        closeOutline();
                      }
                    }
                  }}
                  placeholder={i18nService.t('coworkRailOutlineFilterPlaceholder')}
                  className="w-full rounded-lg border border-neutral-200/80 bg-white/80 py-1 pl-2.5 pr-6 text-xs text-neutral-800 outline-none transition-colors placeholder:text-neutral-400 focus:border-primary/60 dark:border-neutral-700 dark:bg-neutral-900/60 dark:text-neutral-100 dark:placeholder:text-neutral-500"
                />
                {filterQuery && (
                  <button
                    type="button"
                    onClick={() => {
                      setFilterQuery('');
                      filterInputRef.current?.focus();
                    }}
                    aria-label={i18nService.t('clear')}
                    className="absolute right-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full text-neutral-400 hover:bg-neutral-200/70 hover:text-neutral-700 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3 w-3">
                      <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Turn List */}
          <div
            ref={listContainerRef}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5"
          >
            {filteredEntries.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-neutral-500 dark:text-neutral-400">
                {i18nService.t('coworkRailOutlineEmpty')}
              </div>
            ) : (
              filteredEntries.map(({ item, railIndex }) => {
                const content = buildRailTooltipContent({
                  item,
                  railIndex,
                  totalCount,
                  hasPlaceholderItems,
                  labels: tooltipLabels,
                });
                const isActive = railIndex === resolvedRailIndex;
                const isPreviewTarget = !isPopoverHovered && previewRailIndex === railIndex;

                return (
                  <button
                    key={item.key}
                    type="button"
                    data-rail-outline-index={railIndex}
                    onClick={() => handleSelectOutlineTurn(railIndex)}
                    className={`group flex w-full flex-col rounded-lg px-2 py-1.5 text-left transition-colors ${
                      isActive
                        ? 'bg-neutral-200/80 text-neutral-900 dark:bg-neutral-700/80 dark:text-neutral-50'
                        : isPreviewTarget
                          ? 'bg-neutral-200/45 text-neutral-900 dark:bg-neutral-700/45 dark:text-neutral-100'
                          : 'text-neutral-700 hover:bg-neutral-200/55 dark:text-neutral-200 dark:hover:bg-neutral-700/50'
                    }`}
                  >
                    <div className="flex w-full items-center gap-1.5">
                      <span
                        className={`inline-flex min-w-[24px] shrink-0 items-center justify-center rounded px-1 py-0.5 text-[10.5px] font-medium tabular-nums ${
                          isActive
                            ? 'bg-neutral-800 text-white dark:bg-neutral-200 dark:text-neutral-900'
                            : 'bg-neutral-200/75 text-neutral-500 dark:bg-neutral-700/75 dark:text-neutral-400'
                        }`}
                      >
                        {railIndex + 1}
                      </span>
                      <span className={`min-w-0 flex-1 truncate text-[12.5px] leading-snug ${isActive ? 'font-semibold' : 'font-medium'}`}>
                        {content.title}
                      </span>
                      {content.timestampText && (
                        <span className="shrink-0 text-[10.5px] text-neutral-400 tabular-nums dark:text-neutral-500">
                          {content.timestampText}
                        </span>
                      )}
                    </div>
                    {content.summary && (
                      <div className="mt-0.5 line-clamp-1 pl-[30px] text-[11.5px] leading-snug text-neutral-500 dark:text-neutral-400">
                        {content.summary}
                      </div>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
};

export default ConversationTurnRail;
