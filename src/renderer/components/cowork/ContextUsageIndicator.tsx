import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { ContextCleanupApplyResult, ContextCleanupScanResult } from '../../../shared/contextCleanup/types';
import { contextCleanupService } from '../../services/contextCleanup';
import { i18nService } from '../../services/i18n';
import type { CoworkContextUsage } from '../../types/cowork';
import { formatTokenCount } from '../../utils/tokenFormat';
import ContextCleanupModal from './ContextCleanupModal';
import { showContextCleanupUndoToast } from './contextCleanupToast';
import {
  buildContextUsagePopoverViewModel,
  ContextBarSegmentKind,
  ContextBreakdownSegmentKey,
} from './contextUsagePopover';
import {
  type FixedPopoverPlacement,
  resolveFixedPopoverPlacement,
  resolvePopoverBoundaryBounds,
} from './popoverPlacement';

interface ContextUsageIndicatorProps {
  sessionId?: string;
  usage?: CoworkContextUsage;
  compacting?: boolean;
  showCompactAction?: boolean;
  compactDisabled?: boolean;
  compactBlockedReason?: string;
  onCompact?: () => void;
  onPopoverOpenChange?: (open: boolean) => void;
  className?: string;
  showTooltip?: boolean;
}

const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const POPOVER_DESIRED_WIDTH = 268;
const POPOVER_ESTIMATED_HEIGHT = 224;
const POPOVER_GAP_PX = 8;

const SEGMENT_BAR_CLASS: Record<ContextBarSegmentKind, string> = {
  [ContextBarSegmentKind.System]: 'bg-sky-500 dark:bg-sky-400',
  [ContextBarSegmentKind.Tools]: 'bg-amber-500 dark:bg-amber-400',
  [ContextBarSegmentKind.Messages]: 'bg-violet-500 dark:bg-violet-400',
  [ContextBarSegmentKind.Total]: 'bg-foreground/55',
};

const ROW_SWATCH_CLASS: Record<ContextBreakdownSegmentKey, string> = {
  [ContextBreakdownSegmentKey.System]: 'bg-sky-500 dark:bg-sky-400',
  [ContextBreakdownSegmentKey.Tools]: 'bg-amber-500 dark:bg-amber-400',
  [ContextBreakdownSegmentKey.Messages]: 'bg-violet-500 dark:bg-violet-400',
};

const formatTooltip = (
  usage: CoworkContextUsage | undefined,
  showCompactAction: boolean,
): string => {
  if (!usage || typeof usage.percent !== 'number') {
    return i18nService.t('coworkContextUsageUnknown');
  }
  const lines = [
    i18nService.t('coworkContextUsagePercent').replace('{percent}', String(usage.percent)),
  ];
  if (typeof usage.usedTokens === 'number' && typeof usage.contextTokens === 'number') {
    lines.push(
      i18nService.t('coworkContextUsageTokens')
        .replace('{used}', formatTokenCount(usage.usedTokens))
        .replace('{total}', formatTokenCount(usage.contextTokens)),
    );
  }
  lines.push(
    i18nService.t(showCompactAction ? 'coworkContextUsageDetailsHint' : 'coworkContextUsageReadOnlyHint'),
  );
  return lines.join('\n');
};

const ContextUsageIndicator: React.FC<ContextUsageIndicatorProps> = ({
  sessionId,
  usage,
  compacting = false,
  showCompactAction = false,
  compactDisabled = false,
  compactBlockedReason,
  onCompact,
  onPopoverOpenChange,
  className = '',
  showTooltip = true,
}) => {
  const viewModel = useMemo(() => buildContextUsagePopoverViewModel(usage), [usage]);
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<FixedPopoverPlacement | null>(null);
  const [cleanupScan, setCleanupScan] = useState<ContextCleanupScanResult | null>(null);
  const [cleanupModalOpen, setCleanupModalOpen] = useState(false);
  const mountedRef = useRef(true);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const setOpenWithCallback = useCallback((nextOpen: boolean) => {
    setOpen((prev) => {
      if (prev === nextOpen) return prev;
      onPopoverOpenChange?.(nextOpen);
      return nextOpen;
    });
  }, [onPopoverOpenChange]);

  useEffect(() => {
    setOpen(false);
  }, [sessionId]);

  useEffect(() => {
    if (!viewModel && open) {
      setOpenWithCallback(false);
    }
  }, [open, setOpenWithCallback, viewModel]);

  const updatePlacement = useCallback(() => {
    const anchorEl = rootRef.current;
    if (!anchorEl) return;
    const anchorRect = anchorEl.getBoundingClientRect();
    const boundary = resolvePopoverBoundaryBounds(anchorEl);
    setPlacement(resolveFixedPopoverPlacement({
      anchor: {
        top: anchorRect.top,
        bottom: anchorRect.bottom,
        left: anchorRect.left,
        right: anchorRect.right,
      },
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      desiredWidth: POPOVER_DESIRED_WIDTH,
      estimatedHeight: POPOVER_ESTIMATED_HEIGHT,
      gap: POPOVER_GAP_PX,
      boundary,
      preferredAlign: 'right',
    }));
  }, []);

  useLayoutEffect(() => {
    if (!open || !viewModel) {
      setPlacement(null);
      return undefined;
    }
    updatePlacement();
    window.addEventListener('resize', updatePlacement);
    window.addEventListener('scroll', updatePlacement, true);
    return () => {
      window.removeEventListener('resize', updatePlacement);
      window.removeEventListener('scroll', updatePlacement, true);
    };
  }, [open, updatePlacement, viewModel]);

  useEffect(() => {
    if (!open) return undefined;
    let active = true;
    void contextCleanupService.scan().then((result) => {
      if (active) setCleanupScan(result);
    });
    return () => { active = false; };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node
        && (rootRef.current?.contains(target) || popoverRef.current?.contains(target))
      ) {
        return;
      }
      setOpenWithCallback(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenWithCallback(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, setOpenWithCallback]);

  const percent = viewModel?.percent;
  if (!compacting && percent === undefined) {
    return null;
  }

  const offset = percent === undefined
    ? CIRCUMFERENCE
    : CIRCUMFERENCE * (1 - Math.min(Math.max(percent, 0), 100) / 100);
  const canOpenPopover = Boolean(viewModel);
  const isActionButtonDisabled = compactDisabled || compacting || !onCompact;
  const tooltip = compacting
    ? i18nService.t('coworkContextCompacting')
    : formatTooltip(usage, showCompactAction && Boolean(onCompact));
  const tooltipLines = tooltip.split('\n');

  const handleTogglePopover = () => {
    if (!canOpenPopover) return;
    setOpenWithCallback(!open);
  };

  const handleCompactClick = () => {
    if (isActionButtonDisabled) return;
    setOpenWithCallback(false);
    onCompact?.();
  };

  const handleOpenCleanupModal = () => {
    setOpenWithCallback(false);
    setCleanupModalOpen(true);
  };

  const handleCleanupApplied = (result: ContextCleanupApplyResult) => {
    if (result.closedCount > 0 && result.undoToken) {
      showContextCleanupUndoToast(
        {
          closedCount: result.closedCount,
          savedTokens: result.savedTokens,
          undoToken: result.undoToken,
        },
        {
          onUndone: () => {
            if (mountedRef.current) {
              setCleanupScan(null);
            }
          },
        },
      );
    }
    setCleanupScan(null);
  };

  const recommendedCleanupCount = cleanupScan
    ? cleanupScan.candidates.filter(c => c.defaultSelected).length
    : 0;

  const popoverStyle: React.CSSProperties | undefined = placement
    ? {
        position: 'fixed',
        left: `${placement.left}px`,
        width: `${placement.width}px`,
        ...(placement.bottom !== undefined
          ? { bottom: `${placement.bottom}px` }
          : { top: `${placement.top ?? 0}px` }),
        maxHeight: `${Math.max(120, placement.maxHeight)}px`,
      }
    : undefined;

  return (
    <span ref={rootRef} className={`group relative inline-flex flex-shrink-0 ${className}`}>
      <button
        type="button"
        onClick={handleTogglePopover}
        disabled={!canOpenPopover}
        aria-label={tooltip}
        aria-haspopup={canOpenPopover ? 'dialog' : undefined}
        aria-expanded={canOpenPopover ? open : undefined}
        className={`relative flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg transition-colors ${
          !canOpenPopover
            ? 'cursor-default text-secondary/70'
            : open
              ? 'bg-surface-raised text-foreground'
              : 'text-secondary hover:bg-surface-raised hover:text-foreground'
        }`}
      >
        <svg
          viewBox="0 0 20 20"
          className={`h-5 w-5 text-secondary ${compacting ? 'animate-spin' : ''}`}
          shapeRendering="geometricPrecision"
          aria-hidden="true"
        >
          <circle
            cx="10"
            cy="10"
            r={RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            opacity="0.42"
          />
          <circle
            cx="10"
            cy="10"
            r={RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            opacity="1"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={offset}
            transform="rotate(-90 10 10)"
          />
        </svg>
      </button>
      {showTooltip && !open && (
        <span className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 hidden min-w-max max-w-[min(260px,calc(100vw-24px))] -translate-x-1/2 whitespace-nowrap rounded-xl border border-border bg-surface px-3 py-2 text-left text-[12px] leading-5 text-foreground shadow-popover group-hover:block">
          {tooltipLines.map((line, index) => (
            <React.Fragment key={`${line}-${index}`}>
              <span className={index === tooltipLines.length - 1 && canOpenPopover && !compacting ? 'text-secondary' : undefined}>
                {line}
              </span>
              {index < tooltipLines.length - 1 && <br />}
            </React.Fragment>
          ))}
        </span>
      )}
      {open && viewModel && popoverStyle && typeof document !== 'undefined' && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={i18nService.t('coworkContextUsagePercent').replace('{percent}', String(viewModel.percent))}
          style={popoverStyle}
          className="z-[70] overflow-y-auto rounded-2xl border border-border bg-surface p-3.5 text-foreground shadow-popover"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[13px] font-medium text-foreground tabular-nums">
              {i18nService.t('coworkContextUsagePercent').replace('{percent}', String(viewModel.percent))}
            </span>
            {typeof viewModel.usedTokens === 'number' && typeof viewModel.contextTokens === 'number' && (
              <span className="text-[11px] text-secondary tabular-nums">
                {`~${formatTokenCount(viewModel.usedTokens)} / ${formatTokenCount(viewModel.contextTokens)}`}
              </span>
            )}
          </div>

          <div className="mt-2.5 flex h-2 w-full overflow-hidden rounded-full bg-surface-raised">
            {viewModel.barSegments.map((segment) => (
              <div
                key={segment.key}
                className={`h-full transition-[width] duration-200 ${SEGMENT_BAR_CLASS[segment.key]}`}
                style={{ width: `${segment.widthPercent}%` }}
              />
            ))}
          </div>

          {viewModel.rows.length > 0 && (
            <dl className="mt-3 space-y-1.5 text-xs">
              {viewModel.rows.map((row) => (
                <div key={row.key} className="flex items-center justify-between gap-3">
                  <dt className="flex min-w-0 items-center gap-2 text-secondary">
                    <span
                      className={`h-2 w-2 flex-shrink-0 rounded-full ${ROW_SWATCH_CLASS[row.key]}`}
                      aria-hidden="true"
                    />
                    <span className="truncate">{i18nService.t(row.labelKey)}</span>
                  </dt>
                  <dd className="flex-shrink-0 font-medium text-foreground tabular-nums">
                    {`~${formatTokenCount(row.tokens)}`}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          {cleanupScan?.shouldPromptInPopover && recommendedCleanupCount > 0 && (
            <div className="mt-3 flex items-center justify-between gap-2 rounded-xl bg-surface-raised/80 px-2.5 py-2 text-[11px]">
              <span className="leading-4 text-secondary">
                {i18nService.t('contextCleanupPopoverHint')
                  .replace('{count}', String(recommendedCleanupCount))
                  .replace('{tokens}', formatTokenCount(cleanupScan.recommendedSavableTokens))}
              </span>
              <button
                type="button"
                onClick={handleOpenCleanupModal}
                className="flex-shrink-0 font-medium text-primary hover:underline"
              >
                {i18nService.t('contextCleanupPopoverAction')}
              </button>
            </div>
          )}

          {showCompactAction && onCompact && (
            <div className="mt-3 border-t border-border pt-2.5">
              <button
                type="button"
                onClick={handleCompactClick}
                disabled={isActionButtonDisabled}
                className={`flex w-full items-center justify-center rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  isActionButtonDisabled
                    ? 'cursor-not-allowed bg-surface-raised text-secondary'
                    : 'bg-action text-action-foreground hover:bg-action-hover'
                }`}
              >
                {compacting
                  ? i18nService.t('coworkContextCompacting')
                  : i18nService.t('coworkContextCompactAction')}
              </button>
              {compactDisabled && !compacting && compactBlockedReason && (
                <p className="mt-1.5 text-center text-[11px] leading-4 text-secondary">
                  {compactBlockedReason}
                </p>
              )}
            </div>
          )}
        </div>,
        document.body,
      )}
      <ContextCleanupModal
        isOpen={cleanupModalOpen}
        scanResult={cleanupScan}
        onClose={() => setCleanupModalOpen(false)}
        onApplied={handleCleanupApplied}
      />
    </span>
  );
};

export default ContextUsageIndicator;
