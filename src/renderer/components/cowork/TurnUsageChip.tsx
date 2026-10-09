import React, { useEffect, useId, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { type CoworkTurnUsage, CoworkTurnUsageStatus } from '../../../shared/cowork/llmTurnUsage';
import { copyTextToClipboard } from '../../services/clipboard';
import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import type { RootState } from '../../store';
import CreditsIcon from '../icons/CreditsIcon';
import { formatTurnDuration } from './messageDisplayUtils';
import { type PopoverPlacement, resolvePopoverPlacement } from './popoverPlacement';
import {
  buildTurnUsageTokenRows,
  formatTurnCacheHitRate,
  formatTurnTokens,
  formatTurnUsageCredits,
  getTurnCacheHitRate,
  getTurnCreditsLabelKey,
  getTurnUsageChipState,
  shortenTraceId,
  TurnUsageChipState,
  TurnUsageTokenRowKey,
} from './turnUsageDisplay';

interface TurnUsageChipProps {
  /** The turn's user message, which stores the usage. */
  userMessageId: string;
  turnUsage: CoworkTurnUsage;
  /** Same measurement as the turn's duration line. */
  durationMs: number | null;
}

const POPOVER_WIDTH_PX = 300;
const POPOVER_ESTIMATED_HEIGHT_PX = 340;
const COPIED_RESET_MS = 2000;

const TurnUsageChip: React.FC<TurnUsageChipProps> = ({ userMessageId, turnUsage, durationMs }) => {
  const sessionId = useSelector((state: RootState) => state.cowork.currentSession?.id ?? null);
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [placement, setPlacement] = useState<PopoverPlacement>({
    direction: 'up',
    alignSide: 'left',
    maxWidth: null,
  });
  const rootRef = useRef<HTMLSpanElement>(null);
  const copiedTimerRef = useRef<number | null>(null);
  const popoverId = useId();
  const chipState = getTurnUsageChipState(turnUsage);
  const durationLabel = durationMs !== null && durationMs >= 1000 ? formatTurnDuration(durationMs) : null;

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  useEffect(() => () => {
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
  }, []);

  if (chipState === TurnUsageChipState.Pending) {
    return (
      <span className="inline-flex h-7 items-center gap-1 whitespace-nowrap px-1 text-secondary" role="status">
        <CreditsIcon className="h-4 w-4 shrink-0 animate-pulse" />
        <span>{i18nService.t('coworkTurnUsagePending')}</span>
      </span>
    );
  }

  const creditsLabel = i18nService.t(getTurnCreditsLabelKey(turnUsage))
    .replace('{credits}', formatTurnUsageCredits(turnUsage));
  const chipLabel = chipState === TurnUsageChipState.Failed
    ? i18nService.t('coworkTurnUsageLabel')
    : creditsLabel;

  const togglePopover = () => {
    if (!open && rootRef.current) {
      setPlacement(resolvePopoverPlacement(rootRef.current, {
        preferredAlign: 'left',
        estimatedHeight: POPOVER_ESTIMATED_HEIGHT_PX,
        desiredWidth: POPOVER_WIDTH_PX,
      }));
    }
    setOpen(value => !value);
  };

  const handleRefresh = async () => {
    if (!sessionId || refreshing) return;
    setRefreshing(true);
    try {
      await coworkService.refreshTurnUsage(sessionId, userMessageId);
    } finally {
      setRefreshing(false);
    }
  };

  const handleCopyTraceId = async () => {
    if (!await copyTextToClipboard(turnUsage.traceId)) return;
    setCopied(true);
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => setCopied(false), COPIED_RESET_MS);
  };

  const popoverPositionClass = [
    placement.direction === 'down' ? 'top-full mt-1.5' : 'bottom-full mb-1.5',
    placement.alignSide === 'right' ? 'right-0' : 'left-0',
    placement.direction === 'down'
      ? (placement.alignSide === 'right' ? 'origin-top-right' : 'origin-top-left')
      : (placement.alignSide === 'right' ? 'origin-bottom-right' : 'origin-bottom-left'),
  ].join(' ');
  const popoverStyle: React.CSSProperties = { width: POPOVER_WIDTH_PX };
  if (placement.maxWidth !== null) popoverStyle.maxWidth = placement.maxWidth;

  const refreshButton = sessionId ? (
    <button
      type="button"
      onClick={() => void handleRefresh()}
      disabled={refreshing}
      className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-surface-raised disabled:cursor-default disabled:opacity-60"
    >
      {chipState === TurnUsageChipState.Failed
        ? i18nService.t('coworkTurnUsageRetry')
        : i18nService.t('coworkTurnUsageRefresh')}
    </button>
  ) : null;

  const renderSummary = () => {
    const cacheHitRate = formatTurnCacheHitRate(getTurnCacheHitRate(turnUsage));
    return (
      <>
        <div className="px-3 pb-2 text-secondary">
          <div>
            {i18nService.t('coworkTurnUsageRequests').replace('{count}', String(turnUsage.requestCount))}
            {turnUsage.failedRequestCount > 0 && (
              <span className="text-warning">
                {' · '}
                {i18nService.t('coworkTurnUsageFailedRequests').replace('{count}', String(turnUsage.failedRequestCount))}
              </span>
            )}
          </div>
          {turnUsage.models.length > 0 && (
            <div className="break-words">{turnUsage.models.join(', ')}</div>
          )}
        </div>
        <div className="border-t border-border px-3 py-2">
          <div className="flex items-center justify-between gap-3 py-0.5">
            <span className="text-secondary">{i18nService.t('coworkTurnUsageCacheHitRate')}</span>
            <span className="font-medium tabular-nums text-foreground">{cacheHitRate}</span>
          </div>
          {buildTurnUsageTokenRows(turnUsage).map(row => {
            const isTotal = row.key === TurnUsageTokenRowKey.Total;
            return (
              <div
                key={row.key}
                className={`flex items-center justify-between gap-3 py-0.5 ${
                  isTotal ? 'mt-1 border-t border-dashed border-border pt-1.5' : ''
                }`}
              >
                <span className={isTotal ? 'font-medium text-foreground' : 'text-secondary'}>
                  {i18nService.t(row.labelKey)}
                </span>
                <span className={`tabular-nums ${isTotal ? 'font-medium text-foreground' : 'text-foreground'}`}>
                  {formatTurnTokens(row.tokens)}
                </span>
              </div>
            );
          })}
        </div>
      </>
    );
  };

  return (
    <span ref={rootRef} className="relative inline-flex">
        <button
          type="button"
          onClick={togglePopover}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-controls={open ? popoverId : undefined}
          title={i18nService.t('coworkTurnUsageViewDetails')}
          className={`inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-md px-1 [font:inherit] transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
            open ? 'bg-surface-raised text-foreground' : 'text-secondary'
          }`}
        >
          <CreditsIcon className="h-4 w-4 shrink-0" />
          <span className="tabular-nums">{chipLabel}</span>
        </button>
        {open && (
          <div
            id={popoverId}
            role="dialog"
            aria-label={i18nService.t('coworkTurnUsageTitle')}
            className={`absolute ${popoverPositionClass} z-50 max-w-[calc(100vw-48px)] animate-scale-in select-text rounded-xl border border-border bg-surface text-xs text-foreground shadow-popover`}
            style={popoverStyle}
          >
            <div className="flex items-center justify-between gap-3 px-3 pb-1 pt-2.5">
              <span className="inline-flex items-center gap-1.5 font-medium">
                <CreditsIcon className="h-4 w-4 text-secondary" />
                {i18nService.t('coworkTurnUsageTitle')}
              </span>
              {chipState === TurnUsageChipState.Ready && (
                <span className="text-sm font-semibold tabular-nums">{creditsLabel}</span>
              )}
            </div>
            {chipState === TurnUsageChipState.Failed ? (
              <div className="flex items-center justify-between gap-3 px-3 pb-2 text-secondary">
                <span>{i18nService.t('coworkTurnUsageFailed')}</span>
                {refreshButton}
              </div>
            ) : renderSummary()}
            {turnUsage.status === CoworkTurnUsageStatus.Partial && (
              <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2 text-warning">
                <span>{i18nService.t('coworkTurnUsagePartial')}</span>
                {refreshButton}
              </div>
            )}
            <div className="border-t border-border px-3 py-2">
              {durationLabel && (
                <div className="flex items-center justify-between gap-3 py-0.5">
                  <span className="text-secondary">{i18nService.t('coworkTurnUsageDuration')}</span>
                  <span className="tabular-nums text-foreground">{durationLabel}</span>
                </div>
              )}
              <div className="flex items-center justify-between gap-3 py-0.5">
                <span className="text-secondary" title={i18nService.t('coworkTurnUsageTraceHint')}>
                  {i18nService.t('coworkTurnUsageTraceId')}
                </span>
                <span className="inline-flex min-w-0 items-center gap-1">
                  <span className="truncate font-mono text-[11px] text-foreground" title={turnUsage.traceId}>
                    {shortenTraceId(turnUsage.traceId)}
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleCopyTraceId()}
                    className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-surface-raised"
                    aria-label={i18nService.t('coworkTurnUsageCopyTraceId')}
                  >
                    {copied ? i18nService.t('coworkTurnUsageCopied') : i18nService.t('coworkTurnUsageCopy')}
                  </button>
                </span>
              </div>
            </div>
          </div>
        )}
    </span>
  );
};

export default TurnUsageChip;
