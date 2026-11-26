import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '../../services/i18n';
import {
  buildVisualRailTicks,
  computeVisualRailMaxTicks,
  type ConversationRailItem,
  getRailTooltipGeometry,
  getVisualRailLineWidth,
  RAIL_LINE_HEIGHT,
  RAIL_MAX_VISUAL_TICKS,
  type RailTooltipGeometry,
} from './conversationRailDisplay';
import {
  buildRailTooltipContent,
  formatRailTurnPosition,
} from './conversationRailTooltip';

export interface ConversationTurnRailProps {
  sessionId?: string;
  railItems: ConversationRailItem[];
  currentRailIndex: number;
  hasPlaceholderItems: boolean;
  onNavigateToRailItem: (
    railIndex: number,
    actionType: 'rail_item_click' | 'rail_prev_click' | 'rail_next_click',
  ) => void;
}

const ConversationTurnRail: React.FC<ConversationTurnRailProps> = ({
  sessionId,
  railItems,
  currentRailIndex,
  hasPlaceholderItems,
  onNavigateToRailItem,
}) => {
  const railContainerRef = useRef<HTMLDivElement>(null);
  const tickButtonRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  const [isRailHovered, setIsRailHovered] = useState(false);
  const [hoveredSlotIndex, setHoveredSlotIndex] = useState<number | null>(null);
  const [tooltipGeometry, setTooltipGeometry] = useState<RailTooltipGeometry | null>(null);
  const [maxVisualTicks, setMaxVisualTicks] = useState(RAIL_MAX_VISUAL_TICKS);

  const totalCount = railItems.length;
  const resolvedRailIndex = currentRailIndex < 0 || currentRailIndex >= totalCount
    ? Math.max(0, totalCount - 1)
    : currentRailIndex;

  // Adapt visual tick cap to the parent container height so ticks and arrows
  // never clip or require nested scrolling even in compact windows.
  useEffect(() => {
    const parentEl = railContainerRef.current?.parentElement;
    if (!parentEl) return undefined;

    const updateMaxTicks = () => {
      const next = computeVisualRailMaxTicks(parentEl.clientHeight);
      setMaxVisualTicks(prev => (prev === next ? prev : next));
    };

    updateMaxTicks();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateMaxTicks);
      return () => window.removeEventListener('resize', updateMaxTicks);
    }

    const observer = new ResizeObserver(updateMaxTicks);
    observer.observe(parentEl);
    return () => observer.disconnect();
  }, []);

  const visualTicks = useMemo(
    () => buildVisualRailTicks(totalCount, resolvedRailIndex, maxVisualTicks),
    [maxVisualTicks, resolvedRailIndex, totalCount],
  );
  const activeSlotIndex = useMemo(() => {
    const idx = visualTicks.findIndex(tick => tick.isActive);
    return idx >= 0 ? idx : Math.max(0, visualTicks.length - 1);
  }, [visualTicks]);

  const tooltipLabels = useMemo(() => ({
    unloadedTitle: i18nService.t('coworkRailUnloadedMessageTitle'),
    unloadedHint: i18nService.t('coworkRailUnloadedMessageHint'),
    turnPositionTemplate: i18nService.t('coworkRailTurnPosition'),
  }), []);

  const clearHoverTooltip = useCallback(() => {
    setHoveredSlotIndex(null);
    setTooltipGeometry(null);
  }, []);

  const updateTooltipForSlot = useCallback((slotIndex: number, buttonEl?: HTMLButtonElement | null) => {
    const targetEl = buttonEl ?? tickButtonRefs.current.get(slotIndex);
    if (!targetEl) {
      setTooltipGeometry(null);
      return;
    }
    const rect = targetEl.getBoundingClientRect();
    setTooltipGeometry(getRailTooltipGeometry(rect, {
      width: window.innerWidth,
      height: window.innerHeight,
    }));
  }, []);

  // Reset hover and tooltip cleanly when switching sessions.
  useEffect(() => {
    setIsRailHovered(false);
    clearHoverTooltip();
  }, [clearHoverTooltip, sessionId]);

  // Keep tooltip anchored if the viewport resizes while a tick is hovered.
  useEffect(() => {
    if (hoveredSlotIndex === null) return undefined;
    const handleResize = () => updateTooltipForSlot(hoveredSlotIndex);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [hoveredSlotIndex, updateTooltipForSlot]);

  const hoveredTick = hoveredSlotIndex !== null ? visualTicks[hoveredSlotIndex] : undefined;
  const hoveredItem = hoveredTick ? railItems[hoveredTick.targetRailIndex] : undefined;
  const tooltipContent = hoveredTick && hoveredItem
    ? buildRailTooltipContent({
      item: hoveredItem,
      railIndex: hoveredTick.targetRailIndex,
      totalCount,
      hasPlaceholderItems,
      labels: tooltipLabels,
    })
    : null;

  return (
    <>
      <div
        ref={railContainerRef}
        className="absolute right-[18px] top-1/2 -translate-y-1/2 w-5 flex flex-col items-end z-10"
        style={{ maxHeight: 'calc(100% - 40px)' }}
        onMouseEnter={() => setIsRailHovered(true)}
        onMouseLeave={() => {
          setIsRailHovered(false);
          clearHoverTooltip();
        }}
        onBlur={(event) => {
          const nextTarget = event.relatedTarget;
          if (nextTarget instanceof Node && railContainerRef.current?.contains(nextTarget)) {
            return;
          }
          setIsRailHovered(false);
          clearHoverTooltip();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            clearHoverTooltip();
          }
        }}
      >
        {/* Up Arrow */}
        <button
          type="button"
          onClick={() => {
            if (resolvedRailIndex <= 0) return;
            onNavigateToRailItem(resolvedRailIndex - 1, 'rail_prev_click');
          }}
          onMouseEnter={clearHoverTooltip}
          onFocus={() => {
            setIsRailHovered(true);
            clearHoverTooltip();
          }}
          aria-label={i18nService.t('coworkRailPrevTurn')}
          title={i18nService.t('coworkRailPrevTurn')}
          className={`shrink-0 flex items-center justify-center w-5 h-5 mb-2 -mr-[5px] rounded-full transition-all text-neutral-600 dark:text-neutral-400
            ${!isRailHovered
              ? 'opacity-0 pointer-events-none'
              : resolvedRailIndex <= 0
                ? 'opacity-30 cursor-default'
                : 'cursor-pointer hover:text-neutral-800 dark:hover:text-neutral-200 hover:bg-neutral-200/60 dark:hover:bg-neutral-700/60'}`}
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-3.5 h-3.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
          </svg>
        </button>

        {/* Capped Visual Tick Lines (no nested scrollbar) */}
        <div
          className="flex flex-col items-end"
          onMouseLeave={clearHoverTooltip}
        >
          {visualTicks.map((tick) => {
            const isHighlighted = hoveredSlotIndex === null
              ? tick.isActive
              : tick.slotIndex === hoveredSlotIndex;
            const lineWidth = getVisualRailLineWidth(tick.slotIndex, activeSlotIndex, hoveredSlotIndex);
            return (
              <button
                key={`rail-slot-${tick.slotIndex}`}
                ref={(el) => {
                  if (el) {
                    tickButtonRefs.current.set(tick.slotIndex, el);
                  } else {
                    tickButtonRefs.current.delete(tick.slotIndex);
                  }
                }}
                type="button"
                onClick={() => {
                  onNavigateToRailItem(tick.targetRailIndex, 'rail_item_click');
                }}
                onMouseEnter={(event) => {
                  setHoveredSlotIndex(tick.slotIndex);
                  updateTooltipForSlot(tick.slotIndex, event.currentTarget);
                }}
                onFocus={(event) => {
                  setIsRailHovered(true);
                  setHoveredSlotIndex(tick.slotIndex);
                  updateTooltipForSlot(tick.slotIndex, event.currentTarget);
                }}
                aria-label={formatRailTurnPosition(
                  tick.targetRailIndex,
                  totalCount,
                  tooltipLabels.turnPositionTemplate,
                )}
                className="flex items-center justify-end cursor-pointer w-5 py-[5px]"
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
          onMouseEnter={clearHoverTooltip}
          onFocus={() => {
            setIsRailHovered(true);
            clearHoverTooltip();
          }}
          aria-label={i18nService.t('coworkRailNextTurn')}
          title={i18nService.t('coworkRailNextTurn')}
          className={`shrink-0 flex items-center justify-center w-5 h-5 mt-2 -mr-[5px] rounded-full transition-all text-neutral-600 dark:text-neutral-400
            ${!isRailHovered
              ? 'opacity-0 pointer-events-none'
              : resolvedRailIndex >= totalCount - 1
                ? 'opacity-30 cursor-default'
                : 'cursor-pointer hover:text-neutral-800 dark:hover:text-neutral-200 hover:bg-neutral-200/60 dark:hover:bg-neutral-700/60'}`}
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-3.5 h-3.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
          </svg>
        </button>
      </div>

      {/* Single-Turn Preview Tooltip */}
      {tooltipGeometry && tooltipContent && createPortal(
        <div
          role="tooltip"
          className="fixed z-[100] pointer-events-none overflow-hidden rounded-xl border border-neutral-200/85 bg-neutral-50/95 px-3.5 py-2.5 text-[13px] leading-snug shadow-[0_4px_18px_rgba(15,23,42,0.12)] backdrop-blur-md dark:border-neutral-700/90 dark:bg-neutral-800/95 dark:shadow-[0_6px_22px_rgba(0,0,0,0.45)]"
          style={{
            top: tooltipGeometry.top,
            right: tooltipGeometry.right,
            width: tooltipGeometry.width,
            transform: 'translateY(-50%)',
          }}
        >
          <div className="line-clamp-2 break-words text-[13.5px] font-semibold leading-snug text-neutral-900 dark:text-neutral-100">
            {tooltipContent.title}
          </div>
          {tooltipContent.summary && (
            <div className="mt-1.5 line-clamp-3 break-words text-[12.5px] leading-relaxed text-neutral-600 dark:text-neutral-300">
              {tooltipContent.summary}
            </div>
          )}
          {(tooltipContent.turnPosition || tooltipContent.timestampText) && (
            <div className="mt-2 flex items-center justify-between gap-3 text-[12px] text-neutral-500 tabular-nums dark:text-neutral-400">
              {tooltipContent.turnPosition && (
                <span className="shrink-0">{tooltipContent.turnPosition}</span>
              )}
              {tooltipContent.timestampText && (
                <span className="ml-auto shrink-0">{tooltipContent.timestampText}</span>
              )}
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
};

export default ConversationTurnRail;
