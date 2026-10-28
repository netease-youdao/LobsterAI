import {
  ArrowTopRightOnSquareIcon,
  CheckIcon,
  ClockIcon,
  DocumentDuplicateIcon,
  InformationCircleIcon,
} from '@heroicons/react/24/outline';
import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSelector } from 'react-redux';

import {
  type CoworkTurnUsage,
  CoworkTurnUsageBillingScope,
  CoworkTurnUsageStatus,
  type TurnModelUsage,
  TurnUsageModelType,
  TurnUsagePricingPeriod,
} from '../../../shared/cowork/llmTurnUsage';
import { selectEnterpriseAccountContext } from '../../features/enterpriseAccount/selectors';
import { copyTextToClipboard } from '../../services/clipboard';
import { coworkService } from '../../services/cowork';
import { getEnterpriseMemberProfileUrl, getPortalTurnUsageUrl } from '../../services/endpoints';
import { i18nService } from '../../services/i18n';
import type { RootState } from '../../store';
import { formatModelDisplayName } from '../../utils/modelDisplayName';
import CreditsIcon from '../icons/CreditsIcon';
import {
  buildTurnModelTokenRows,
  formatTurnCredits,
  formatTurnTokenAmount,
  formatTurnUsageCredits,
  getTurnCreditsLabelKey,
  getTurnModelUsage,
  getTurnUsageChipState,
  TurnUsageChipState,
  turnUsageModelColors,
} from './turnUsageDisplay';

interface TurnUsageChipProps {
  userMessageId: string;
  turnUsage: CoworkTurnUsage;
  durationMs: number | null;
}

const POPOVER_WIDTH_PX = 260;
const POPOVER_ESTIMATED_HEIGHT_PX = 320;
const COPIED_RESET_MS = 2000;
const POPOVER_GAP_PX = 8;

const TurnUsageChip: React.FC<TurnUsageChipProps> = ({ userMessageId, turnUsage, durationMs }) => {
  const sessionId = useSelector((state: RootState) => state.cowork.currentSession?.id ?? null);
  const enterpriseContext = useSelector(selectEnterpriseAccountContext);
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [detailsFailed, setDetailsFailed] = useState(false);
  const [position, setPosition] = useState<React.CSSProperties>({});
  const rootRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const copiedTimerRef = useRef<number | null>(null);
  const popoverId = useId();
  const chipState = getTurnUsageChipState(turnUsage);
  const models = getTurnModelUsage(turnUsage);
  const textModels = models.filter(model => model.type === TurnUsageModelType.Text);
  const hasCompleteEstimates = textModels.length > 0 && textModels.every(model => model.tokenCreditEstimate);
  const cacheSavings = hasCompleteEstimates && turnUsage.status === CoworkTurnUsageStatus.Settled
    ? Math.max(0, textModels.reduce((sum, model) => sum + (model.tokenCreditEstimate?.cacheSavings ?? 0), 0)) : 0;
  const periods = new Set(textModels.map(model => model.tokenCreditEstimate?.pricingPeriod));
  const period = hasCompleteEstimates && [...periods].some(Boolean)
    ? periods.size === 1 ? [...periods][0] : TurnUsagePricingPeriod.Mixed : undefined;
  const periodLabelKey = period === TurnUsagePricingPeriod.Peak ? 'coworkTurnUsagePeak'
    : period === TurnUsagePricingPeriod.OffPeak ? 'coworkTurnUsageOffPeak' : 'coworkTurnUsageMixedPricing';
  const language = i18nService.getLanguage();
  const totalCredits = models.reduce((sum, model) => sum + model.creditsUsed, 0);
  const isEnterprise = turnUsage.billingScope === CoworkTurnUsageBillingScope.Enterprise;
  const canOpenDetails = !isEnterprise || enterpriseContext !== null;

  useEffect(() => {
    if (!open) return undefined;
    popoverRef.current?.focus({ preventScroll: true });
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && (rootRef.current?.contains(target) || popoverRef.current?.contains(target))) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      rootRef.current?.focus();
    };
    const closeOnViewportChange = (event: Event) => {
      if (event.target instanceof Node && popoverRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', closeOnViewportChange);
    window.addEventListener('scroll', closeOnViewportChange, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', closeOnViewportChange);
      window.removeEventListener('scroll', closeOnViewportChange, true);
    };
  }, [open]);

  useEffect(() => () => {
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
  }, []);

  const handleRefresh = async () => {
    if (!sessionId || refreshing) return;
    setRefreshing(true);
    try {
      await coworkService.refreshTurnUsage(sessionId, userMessageId);
    } finally {
      setRefreshing(false);
    }
  };

  const togglePopover = () => {
    if (!open && rootRef.current) {
      const rect = rootRef.current.getBoundingClientRect();
      const width = Math.min(POPOVER_WIDTH_PX, window.innerWidth - 2 * POPOVER_GAP_PX);
      const above = rect.top - 2 * POPOVER_GAP_PX;
      const below = window.innerHeight - rect.bottom - 2 * POPOVER_GAP_PX;
      const upwards = above >= POPOVER_ESTIMATED_HEIGHT_PX || above > below;
      setPosition({
        width,
        left: Math.max(POPOVER_GAP_PX, Math.min(rect.left, window.innerWidth - width - POPOVER_GAP_PX)),
        ...(upwards ? { bottom: window.innerHeight - rect.top + POPOVER_GAP_PX }
          : { top: rect.bottom + POPOVER_GAP_PX }),
        maxHeight: Math.max(0, upwards ? above : below),
      });
      setDetailsFailed(false);
      // Settled details live with the local conversation, independently of login.
      // Retry empty legacy snapshots so they can recover under the original account.
      if (turnUsage.status !== CoworkTurnUsageStatus.Settled
        || (turnUsage.requestCount === 0 && !turnUsage.modelUsage?.length)) {
        void handleRefresh();
      }
    }
    setOpen(value => !value);
  };

  const handleCopyDiagnostics = async () => {
    const diagnostics = JSON.stringify({
      sessionId,
      userMessageId,
      durationMs,
      ...turnUsage,
    }, null, 2);
    if (!await copyTextToClipboard(diagnostics)) return;
    setCopied(true);
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => setCopied(false), COPIED_RESET_MS);
  };

  const handleOpenDetails = async () => {
    if (!canOpenDetails) return;
    const url = isEnterprise && enterpriseContext
      ? getEnterpriseMemberProfileUrl(enterpriseContext.enterpriseId) : getPortalTurnUsageUrl(turnUsage.traceId);
    try {
      await window.electron.shell.openExternal(url);
      setOpen(false);
    } catch {
      setDetailsFailed(true);
    }
  };

  const modelLabel = (model: TurnModelUsage) => {
    if (model.type === TurnUsageModelType.Text) return i18nService.t('coworkTurnUsageTextModel');
    const key = model.type === TurnUsageModelType.Image
      ? model.count > 0 ? 'coworkTurnUsageImageModel' : 'coworkTurnUsageImageLabel'
      : model.count > 0 ? 'coworkTurnUsageVideoModel' : 'coworkTurnUsageVideoLabel';
    return i18nService.t(key).replace('{count}', String(model.count));
  };

  if (chipState === TurnUsageChipState.Pending) {
    return (
      <span className="inline-flex h-7 items-center gap-1 whitespace-nowrap px-1 text-secondary" role="status">
        <CreditsIcon className="h-4 w-4 shrink-0 animate-pulse" />
        <span>{i18nService.t('coworkTurnUsagePending')}</span>
      </span>
    );
  }

  const chipLabel = chipState === TurnUsageChipState.Failed ? i18nService.t('coworkTurnUsageLabel')
    : i18nService.t(getTurnCreditsLabelKey(turnUsage)).replace('{credits}', formatTurnUsageCredits(turnUsage));
  const refreshButton = sessionId ? (
    <button
      type="button"
      onClick={() => void handleRefresh()}
      disabled={refreshing}
      className="shrink-0 rounded-md px-1.5 py-0.5 font-medium text-primary hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
    >
      {i18nService.t(chipState === TurnUsageChipState.Failed ? 'coworkTurnUsageRetry' : 'coworkTurnUsageRefresh')}
    </button>
  ) : null;

  return (
    <>
      <button
        ref={rootRef}
        type="button"
        onClick={togglePopover}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? popoverId : undefined}
        title={i18nService.t('coworkTurnUsageViewDetails')}
        className={`inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-lg px-2 [font:inherit] transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
          open ? 'bg-surface-raised text-foreground' : 'text-secondary'
        }`}
      >
        <CreditsIcon className="h-4 w-4 shrink-0" />
        <span className="tabular-nums">{chipLabel}</span>
      </button>
      {open && createPortal(
        <div
          ref={popoverRef}
          id={popoverId}
          role="dialog"
          tabIndex={-1}
          aria-labelledby={`${popoverId}-title`}
          className="fixed z-[100] flex animate-scale-in flex-col overflow-hidden rounded-xl border border-border bg-surface text-[12px] font-normal leading-5 text-foreground shadow-popover focus:outline-none"
          style={position}
        >
          <div className="min-h-0 overflow-y-auto overscroll-contain p-3">
            <div className="flex items-center justify-between gap-2 text-secondary">
              <span id={`${popoverId}-title`} className="font-medium">{i18nService.t('coworkTurnUsageTitle')}</span>
              {period && (
                <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-surface-raised px-2 py-0.5 text-[11px]">
                  <ClockIcon className="h-3 w-3" />
                  {i18nService.t(periodLabelKey)}
                </span>
              )}
            </div>
            {chipState === TurnUsageChipState.Failed ? (
              <div className="mt-3 flex items-center justify-between gap-3 text-secondary">
                <span>{i18nService.t('coworkTurnUsageFailed')}</span>
                {refreshButton}
              </div>
            ) : (
              <>
                <div className="mb-2 mt-1 flex items-baseline gap-1">
                  <span className="text-[26px] font-semibold leading-tight tracking-tight tabular-nums">{formatTurnUsageCredits(turnUsage, true)}</span>
                  <span className="text-secondary">{i18nService.t(isEnterprise ? 'coworkTurnUsageTeamCreditsUnit' : 'coworkTurnUsageCreditsUnit')}</span>
                </div>
                {totalCredits > 0 && (
                  <div className="mb-2 flex h-[3px] w-full gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
                    {models.filter(model => model.creditsUsed > 0).map(model => (
                      <div
                        key={`${model.type}:${model.model}`}
                        className={`h-full min-w-[3px] rounded-full ${turnUsageModelColors[model.type].dot}`}
                        style={{ flexGrow: model.creditsUsed / totalCredits, flexBasis: 0 }}
                      />
                    ))}
                  </div>
                )}
                <div className="space-y-2">
                  {models.map(model => (
                    <div key={`${model.type}:${model.model}`}>
                      <div className="flex items-baseline gap-1.5">
                        <span className={`h-[6px] w-[6px] shrink-0 self-start rounded-full mt-[8.5px] ${turnUsageModelColors[model.type].dot}`} aria-hidden="true" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="font-medium">{modelLabel(model)}</span>
                            <span className="shrink-0 font-medium tabular-nums" title={String(model.creditsUsed)}>
                              {formatTurnCredits(model.displayCreditsUsed ?? model.creditsUsed, true)}
                            </span>
                          </div>
                          {model.model && (
                            <div className="truncate text-secondary" title={formatModelDisplayName(model.model)}>
                              {formatModelDisplayName(model.model)}
                            </div>
                          )}
                          {model.type === TurnUsageModelType.Text && (
                            <div className="mt-1.5 border-l border-border pl-2 text-secondary">
                              {buildTurnModelTokenRows(model).map(row => (
                                <div key={row.labelKey} className="flex items-baseline justify-between gap-2">
                                  <span>{i18nService.t(row.labelKey)} {formatTurnTokenAmount(row.tokens, language)}</span>
                                  {row.credits !== undefined && (
                                    <span className="shrink-0 tabular-nums" title={String(row.credits)}>
                                      {formatTurnCredits(row.credits, true)}
                                    </span>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                {cacheSavings > 0 && (
                  <div className="mt-2.5 flex items-start gap-1.5 text-secondary">
                    <InformationCircleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span title={i18nService.t('coworkTurnUsageCacheSavingsExplanation')}>
                      {i18nService.t('coworkTurnUsageCacheSavings').replace('{credits}', formatTurnCredits(cacheSavings))}
                    </span>
                  </div>
                )}
                {turnUsage.failedRequestCount > 0 && (
                  <div className="mt-2 text-warning">{i18nService.t('coworkTurnUsageFailedRequests').replace('{count}', String(turnUsage.failedRequestCount))}</div>
                )}
              </>
            )}
            {turnUsage.status === CoworkTurnUsageStatus.Partial && (
              <div className="mt-2.5 flex items-center justify-between gap-2 text-warning" role="status">
                <span>{i18nService.t('coworkTurnUsagePartial')}</span>
                {refreshButton}
              </div>
            )}
            {detailsFailed && <div className="mt-2.5 text-warning" role="alert">{i18nService.t('coworkTurnUsageDetailsFailed')}</div>}
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-1.5">
            <button
              type="button"
              onClick={() => void handleCopyDiagnostics()}
              className="inline-flex items-center gap-1.5 rounded-md py-1 text-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <DocumentDuplicateIcon className="h-3.5 w-3.5" />}
              {i18nService.t(copied ? 'coworkTurnUsageCopied' : 'coworkTurnUsageCopyDiagnostics')}
            </button>
            <button
              type="button"
              onClick={() => void handleOpenDetails()}
              disabled={!canOpenDetails}
              className="inline-flex items-center gap-1.5 rounded-md py-1 font-medium text-primary hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-40"
            >
              {i18nService.t('coworkTurnUsageDetails')}
              <ArrowTopRightOnSquareIcon className="h-3 w-3" />
            </button>
          </div>
        </div>, document.body,
      )}
    </>
  );
};

export default TurnUsageChip;
