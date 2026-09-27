import { ChevronDownIcon, ChevronRightIcon, ChevronUpIcon, FolderIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { classifyErrorKey, CoworkErrorI18nKey } from '../../../common/coworkErrorClassify';
import { ContextCompactionStatus } from '../../../common/coworkSystemMessages';
import { getScheduledReminderDisplayText } from '../../../scheduledTask/reminderText';
import {
  type CoworkErrorDetail,
  CoworkErrorModelSource,
  formatCoworkErrorDetailText,
  parseCoworkErrorDetail,
} from '../../../shared/cowork/errorDetail';
import type { CoworkGoal } from '../../../shared/cowork/goal';
import purchaseOfferFirstBadge from '../../assets/purchase-offer-first.svg';
import purchaseOfferLimitedBadge from '../../assets/purchase-offer-limited.svg';
import { dedupeArtifactsForDisplay } from '../../services/artifactParser';
import { getPortalPricingUrl } from '../../services/endpoints';
import { i18nService } from '../../services/i18n';
import { type LogEventAction, LogReporterAction } from '../../services/logReporter';
import { LowCreditOfferVariant, reportLowCreditPurchaseEvent } from '../../services/lowCreditPurchaseAnalytics';
import {
  formatPurchaseOfferDiscount,
  getPurchaseOfferDiscountRate,
  getPurchaseOfferPortalTab,
  getPurchaseOfferRemainingMs,
  isPurchaseOfferActive,
} from '../../services/lowCreditPurchaseOffer';
import type { RootState } from '../../store';
import type { LowCreditPurchaseOffer } from '../../store/slices/authSlice';
import type { Artifact } from '../../types/artifact';
import type { CoworkMessage, CoworkMessageMetadata } from '../../types/cowork';
import { revealLocalPathWithToast } from '../../utils/localFileActions';
import { ArtifactPreviewCard } from '../artifacts';
import AbnormalIcon from '../icons/AbnormalIcon';
import ExclamationTriangleIcon from '../icons/ExclamationTriangleIcon';
import InformationCircleIcon from '../icons/InformationCircleIcon';
import MarkdownContent from '../MarkdownContent';
import PurchaseOfferCountdown from '../PurchaseOfferCountdown';
import { useLowCreditOfferExposure } from '../useLowCreditOfferExposure';
import ActivityGroupBlock from './ActivityGroupBlock';
import { ActivityStepLine } from './ActivityStepLine';
import AssistantMessageItem from './AssistantMessageItem';
import { ActivityEntryVariant } from './constants';
import { reportConversationBlockAction } from './conversationAnalytics';
import MediaPollingIndicator from './MediaPollingIndicator';
import { MessageCopyButton } from './MessageActionButton';
import {
  canFoldTurnProcess,
  chunkConsolidatedItemsForDisplay,
  collectMediaPollCounts,
  type ConsolidatedItem,
  consolidateMediaPolling,
  type ConversationTurn,
  countTurnCompletedSteps,
  countTurnFailedSteps,
  COWORK_DETAIL_CONTENT_CLASS,
  COWORK_DETAIL_GUTTER_CLASS,
  formatElapsedDuration,
  formatTurnDuration,
  getActivityIndicatorStatusText,
  getActivityLiveStatusText,
  getConsolidatedItemKey,
  getContextCompactionMessageLabel,
  getMediaCompletionDisplayText,
  getRetainedMediaPollCount,
  getStreamingTextSignature,
  getThinkingPhaseLabels,
  getToolResultDisplay,
  getToolResultLineCount,
  getToolResultLineCountSummary,
  getTurnActivityFingerprint,
  getTurnAnswerStartIndex,
  getTurnEndTimestamp,
  getTurnStartTimestamp,
  getVideoPathArtifacts,
  getVisibleAssistantItems,
  hasText,
  isAbandonedToolPlaceholder,
  isActivityConsolidatedItem,
  isActivityItemLive,
  isContextCompactionMessage,
  isDuplicateGeneratedVideoAssistantMessage,
  type ToolGroupItem,
} from './messageDisplayUtils';
import ThinkingBlock from './ThinkingBlock';
import ToolCallGroup from './ToolCallGroup';
import { useStreamStall } from './useStreamStall';

const encodeLocalPathForUrl = (filePath: string): string => {
  return filePath
    .replace(/\\/g, '/')
    .split('/')
    .map((segment, index) => {
      if (index === 0 && segment === '') return '';
      if (/^[A-Za-z]:$/.test(segment)) return segment;
      return encodeURIComponent(segment);
    })
    .join('/');
};

const toLocalFileSrc = (filePath: string): string => {
  const normalized = filePath.trim().replace(/^file:\/\//i, '').replace(/^localfile:\/\//i, '');
  const withoutLeadingDriveSlash = /^\/[A-Za-z]:/.test(normalized) ? normalized.slice(1) : normalized;
  const encoded = encodeLocalPathForUrl(withoutLeadingDriveSlash);
  if (/^[A-Za-z]:/.test(withoutLeadingDriveSlash)) {
    return `localfile:///${encoded}`;
  }
  if (encoded.startsWith('/')) {
    return `localfile://${encoded}`;
  }
  return `localfile:///${encoded}`;
};

// ── ContextCompressionIcon ───────────────────────────────────────────────────

const ContextCompressionIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 34 34" fill="none" aria-hidden="true" {...props}>
    <path
      d="M6 5V24C6 26.2091 7.79086 28 10 28H22.5M28 29V10C28 7.79086 26.2091 6 24 6H11.5"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
    />
    <path
      d="M11.5 13.5H21"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M11.5 19H17"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="6" cy="5" r="2" fill="currentColor" />
    <circle cx="28" cy="29" r="2" fill="currentColor" />
  </svg>
);

// ── ContextCompactionDivider ─────────────────────────────────────────────────

const ContextCompactionDivider: React.FC<{ label: string; active?: boolean }> = ({
  label,
  active = false,
}) => (
  <div
    className="flex w-full items-center gap-3 py-3 text-secondary"
    role={active ? 'status' : undefined}
    aria-live={active ? 'polite' : undefined}
  >
    <div className="h-px min-w-0 flex-1 bg-border" />
    <div className="flex max-w-[min(100%,360px)] flex-col items-center gap-1.5 bg-background px-2">
      <div className="inline-flex max-w-full items-center gap-2 text-sm font-normal leading-[var(--lobster-leading-promptLarge)] text-foreground/95">
        <ContextCompressionIcon className={`h-3.5 w-3.5 flex-shrink-0 text-foreground/70 ${active ? 'animate-pulse' : ''}`} />
        <span className="truncate">{label}</span>
      </div>
      {active && (
        <div className="context-compaction-progress w-44 max-w-full" aria-hidden="true" />
      )}
    </div>
    <div className="h-px min-w-0 flex-1 bg-border" />
  </div>
);

// ── ActivityIndicator ────────────────────────────────────────────────────────
// Persistent busy-state line at the insertion point of the last turn
// (Codex / ChatGPT style): breathing dot + shimmering status text + elapsed
// time, visible for the whole run. The label follows what is happening:
// the running step's phrase ("Running a command") while a step is live,
// rotating thinking words while waiting for the model's first output, and
// "working" in the silent gaps after that — a thought that has stopped
// growing must not keep saying "thinking", or the run reads as frozen.

// One tick: the first value the user sees is "1s", counting up naturally.
const ACTIVITY_TIMER_APPEAR_DELAY_MS = 1000;
const ACTIVITY_LONG_WAIT_HINT_DELAY_MS = 30_000;

// Rotate the phase word while the model is still silent, so the row visibly keeps moving.
const ACTIVITY_PHASE_INTERVAL_MS = 2200;

// Updates reach the renderer every ~200ms while text streams; a streaming
// thought or reply that has not grown for this long is no longer being written.
const STREAM_STALL_MS = 3000;

export const ActivityIndicator: React.FC<{
  fingerprint: string;
  startTimestamp: number | null;
  /** Session-level override (e.g. context maintenance); wins over everything else. */
  statusTextOverride?: string | null;
  /** What the running step is doing right now; null while the model is silent. */
  liveStatusText?: string | null;
  /** Whether the turn has shown anything yet; silent gaps after that read as "working". */
  hasContent?: boolean;
}> = ({ fingerprint, startTimestamp, statusTextOverride, liveStatusText = null, hasContent = false }) => {
  const [isLongWaiting, setIsLongWaiting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [phaseIndex, setPhaseIndex] = useState(0);
  // Waiting for the model's first output: nothing overrides the label, no
  // step is running, and the turn has shown nothing yet.
  const thinking = !statusTextOverride && !liveStatusText && !isLongWaiting && !hasContent;

  useEffect(() => {
    if (!thinking) {
      setPhaseIndex(0);
      return undefined;
    }
    const intervalId = window.setInterval(
      () => setPhaseIndex(index => (index + 1) % getThinkingPhaseLabels().length),
      ACTIVITY_PHASE_INTERVAL_MS,
    );
    return () => window.clearInterval(intervalId);
  }, [thinking, fingerprint]);

  // The long-wait hint resets whenever streamed content grows, so it only
  // appears after the model has been silent for a while.
  useEffect(() => {
    setIsLongWaiting(false);
    const timeoutId = window.setTimeout(
      () => setIsLongWaiting(true),
      ACTIVITY_LONG_WAIT_HINT_DELAY_MS,
    );
    return () => window.clearTimeout(timeoutId);
  }, [fingerprint]);

  useEffect(() => {
    setNow(Date.now());
    const intervalId = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  // Elapsed time is anchored to message timestamps so it survives remounts
  // (switching sessions/views); until the turn has a timestamp, show no
  // counter rather than one restarted from zero.
  const elapsedMs = startTimestamp != null ? Math.max(0, now - startTimestamp) : null;
  const phases = getThinkingPhaseLabels();
  // A running step always names itself; the long-wait hint only applies to a
  // silent model, never to a command that is simply taking its time.
  const statusText = statusTextOverride
    ?? liveStatusText
    ?? (thinking
      ? phases[phaseIndex % phases.length]
      : getActivityIndicatorStatusText(false, isLongWaiting, hasContent));

  return (
    <div className="flex items-center gap-2 py-1 animate-fade-in">
      <span className="activity-indicator-dot h-2 w-2 rounded-full bg-primary flex-shrink-0" aria-hidden="true" />
      <span
        className="shimmer-text text-sm text-secondary min-w-0 truncate"
        role="status"
        aria-live="polite"
      >
        {statusText}
      </span>
      {elapsedMs != null && elapsedMs >= ACTIVITY_TIMER_APPEAR_DELAY_MS && (
        <span
          className="text-xs text-muted tabular-nums flex-shrink-0 animate-fade-in"
          aria-hidden="true"
        >
          {formatElapsedDuration(elapsedMs)}
        </span>
      )}
    </div>
  );
};

const getSystemMessageDisplayContent = (message: CoworkMessage, content: string): string => {
  const errorText = typeof message.metadata?.error === 'string' ? message.metadata.error : null;
  if (!errorText) return content;

  const key = classifyErrorKey(errorText) ?? classifyErrorKey(content);
  return key ? i18nService.t(key) : content;
};

const getSystemMessageErrorKey = (message: CoworkMessage, content: string): string | null => {
  const errorText = typeof message.metadata?.error === 'string' ? message.metadata.error : null;
  if (!errorText) return classifyErrorKey(content);
  return classifyErrorKey(errorText) ?? classifyErrorKey(content);
};

const isCreditQuotaExhaustedKey = (key: string | null): boolean => (
  key === CoworkErrorI18nKey.QuotaExhausted
  || key === CoworkErrorI18nKey.FreeQuotaExhausted
);

const logCreditQuotaBannerEvent = (
  level: 'debug' | 'warn',
  message: string,
  error?: unknown,
): void => {
  if (level === 'warn') {
    if (error === undefined) {
      console.warn(`[CreditQuotaBanner] ${message}`);
    } else {
      console.warn(`[CreditQuotaBanner] ${message}`, error);
    }
  } else {
    console.debug(`[CreditQuotaBanner] ${message}`);
  }

  try {
    const errorSuffix = error instanceof Error ? `: ${error.message}` : '';
    window.electron?.log?.fromRenderer?.(
      level,
      'CreditQuotaBanner',
      `${message}${errorSuffix}`.slice(0, 500),
    );
  } catch {
    // Renderer diagnostics must never interrupt the conversation UI.
  }
};

const CreditQuotaExhaustedBanner: React.FC<{ offer: LowCreditPurchaseOffer | null; creditsRemaining: number }> = ({ offer, creditsRemaining }) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const currentTime = Date.now();
    setNow(currentTime);
    if (!offer?.expiresAtEpochMs) return undefined;
    const remainingMs = getPurchaseOfferRemainingMs(offer, currentTime);
    if (remainingMs <= 0) return undefined;
    const timer = window.setTimeout(() => setNow(Date.now()), remainingMs + 1);
    return () => window.clearTimeout(timer);
  }, [offer]);
  const portalTab = offer ? getPurchaseOfferPortalTab(offer) : 'subscription';
  const rate = offer
    ? getPurchaseOfferDiscountRate(offer, portalTab === 'boost' ? 'boost_pack' : 'subscription')
    : null;
  const hasOffer = isPurchaseOfferActive(offer, now) && rate !== null;
  const isFirstPurchase = hasOffer && offer?.offerType === 'first_purchase';
  const displayVariant = !hasOffer
    ? LowCreditOfferVariant.NoDiscount
    : isFirstPurchase
      ? LowCreditOfferVariant.FirstPurchase
      : LowCreditOfferVariant.LimitedDiscount;
  const exposureKey = [
    displayVariant,
    displayVariant === LowCreditOfferVariant.NoDiscount ? '' : offer?.campaignCode,
    displayVariant === LowCreditOfferVariant.NoDiscount ? '' : offer?.offerToken,
    displayVariant === LowCreditOfferVariant.NoDiscount ? '' : offer?.windowCount,
  ].join(':');
  const report = (action: LogEventAction, offerTokenAttached?: boolean): void => {
    reportLowCreditPurchaseEvent(action, {
      offer,
      variant: displayVariant,
      creditsRemaining,
      boostDiscountRate: hasOffer && portalTab === 'boost' ? rate : undefined,
      subscriptionDiscountRate: hasOffer && portalTab === 'subscription' ? rate : undefined,
      portalTab,
      offerTokenAttached,
    });
  };
  const { elementRef, ensureExposure } = useLowCreditOfferExposure(exposureKey, () => {
    report(LogReporterAction.LowCreditTaskOfferExposure);
  });
  const handlePurchase = async () => {
    const active = isPurchaseOfferActive(offer) && rate !== null;
    const pricingUrl = getPortalPricingUrl(undefined, {
      offerToken: active ? offer?.offerToken ?? undefined : undefined,
      tab: portalTab,
    });
    ensureExposure();
    report(LogReporterAction.LowCreditTaskPurchaseClick, active);
    logCreditQuotaBannerEvent('debug', 'purchase action clicked');
    try {
      const result = await window.electron?.shell?.openExternal(pricingUrl);
      if (!result?.success) {
        logCreditQuotaBannerEvent(
          'warn',
          `pricing page open failed: ${result?.error ?? 'unknown error'}`,
        );
      }
    } catch (error) {
      logCreditQuotaBannerEvent('warn', 'pricing page open threw an error', error);
    }
  };

  return (
    <div ref={elementRef} className="rounded-xl bg-surface px-4 py-3 shadow-sm">
      <div className="flex items-center gap-3">
        {hasOffer ? (
          <div className="relative h-14 w-14 shrink-0">
            <img
              src={isFirstPurchase ? purchaseOfferFirstBadge : purchaseOfferLimitedBadge}
              alt=""
              className="h-full w-full object-contain"
            />
            <div className="absolute inset-0 flex flex-col items-center justify-center pt-0.5 text-[10px] font-semibold leading-3 text-white">
              <span>{i18nService.t(isFirstPurchase ? 'lowCreditOfferBadgeFirstTop' : 'lowCreditOfferBadgeLimitedTop')}</span>
              <span>{i18nService.t(isFirstPurchase ? 'lowCreditOfferBadgeFirstBottom' : 'lowCreditOfferBadgeLimitedBottom')}</span>
            </div>
          </div>
        ) : (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-surface-raised text-secondary">
            <AbnormalIcon className="h-6 w-6" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <div className="text-sm font-semibold leading-5 text-foreground">
              {hasOffer && rate !== null
                ? i18nService.t(isFirstPurchase ? 'lowCreditOfferTaskFirstTitle' : 'lowCreditOfferTaskReturningTitle')
                  .replace('{discount}', formatPurchaseOfferDiscount(rate))
                : i18nService.t('coworkCreditQuotaBannerTitle')}
            </div>
            {hasOffer && !isFirstPurchase && offer && (
              <PurchaseOfferCountdown offer={offer} />
            )}
          </div>
          <div className="mt-1 text-xs leading-5 text-secondary">
            {i18nService.t('coworkCreditQuotaBannerDescription')}
          </div>
        </div>
        <button
          type="button"
          onClick={handlePurchase}
          className="ml-2 inline-flex h-8 shrink-0 items-center justify-center rounded-full bg-foreground px-5 text-xs font-medium text-background transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          {i18nService.t('coworkCreditQuotaBannerAction')}
        </button>
      </div>
    </div>
  );
};

// ── SystemErrorTechnicalDetail ───────────────────────────────────────────────

/**
 * User-facing model source label. Users only need two buckets — the LobsterAI
 * plan vs. a model they configured themselves; finer detail (provider name,
 * Coding Plan, OAuth) goes into the parenthesized qualifier.
 */
const buildErrorModelSourceLabel = (detail: CoworkErrorDetail): string | null => {
  if (!detail.modelSource) return null;
  if (detail.modelSource === CoworkErrorModelSource.LobsterAIPlan) {
    return i18nService.t('coworkErrorModelSourceLobsterAIPlan');
  }

  const qualifiers: string[] = [];
  if (detail.providerDisplayName) qualifiers.push(detail.providerDisplayName);
  if (detail.modelSource === CoworkErrorModelSource.CodingPlan) qualifiers.push('Coding Plan');
  if (detail.modelSource === CoworkErrorModelSource.BuiltinOAuth) qualifiers.push('OAuth');

  const base = i18nService.t('coworkErrorModelSourceCustomModel');
  return qualifiers.length > 0 ? `${base} (${qualifiers.join(' · ')})` : base;
};

/** "Model: glm-5 · Custom model (Zhipu · Coding Plan)" line shown without expanding details. */
const buildErrorModelLine = (detail: CoworkErrorDetail): string | null => {
  const sourceLabel = buildErrorModelSourceLabel(detail);
  if (!detail.model && !sourceLabel) return null;

  const parts: string[] = [];
  if (detail.model) {
    parts.push(`${i18nService.t('coworkErrorModelLabel')}: ${detail.model}`);
  }
  if (sourceLabel) {
    parts.push(sourceLabel);
  }
  return parts.join(' · ');
};

const SystemErrorTechnicalDetail: React.FC<{ detail: CoworkErrorDetail }> = ({ detail }) => {
  const [expanded, setExpanded] = useState(false);
  const detailText = useMemo(() => formatCoworkErrorDetailText(detail), [detail]);
  if (!detailText) return null;

  return (
    <div className="mt-1.5 pl-6">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex items-center gap-1 text-xs text-muted transition-colors hover:text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
        aria-expanded={expanded}
      >
        {expanded
          ? <ChevronUpIcon className="h-3 w-3 flex-shrink-0" />
          : <ChevronDownIcon className="h-3 w-3 flex-shrink-0" />
        }
        <span>{i18nService.t('coworkErrorTechnicalDetails')}</span>
      </button>
      {expanded && (
        <div className="relative mt-1.5 rounded-md bg-surface-raised px-3 py-2">
          <div className="absolute right-1 top-1">
            <MessageCopyButton content={detailText} />
          </div>
          <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words pr-8 font-mono text-code text-secondary">
            {detailText}
          </pre>
        </div>
      )}
    </div>
  );
};

// ── VideoArtifactPathList ────────────────────────────────────────────────────

const VideoArtifactPathList: React.FC<{ artifacts: Artifact[] }> = ({ artifacts }) => {
  if (artifacts.length === 0) return null;

  const getDisplayPath = (filePath: string): string => {
    const lastSlash = filePath.lastIndexOf('/');
    return lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
  };

  return (
    <div className="space-y-1">
      {artifacts.map(artifact => (
        <div
          key={artifact.id}
          className="flex items-center gap-2 text-xs text-secondary"
        >
          <span className="truncate">{getDisplayPath(artifact.filePath!)}</span>
          <button
            className="flex items-center gap-1 text-primary hover:underline flex-shrink-0"
            onClick={() => void revealLocalPathWithToast(artifact.filePath!)}
          >
            <FolderIcon className="h-3.5 w-3.5" />
            <span>{i18nService.t('showInFolder')}</span>
          </button>
        </div>
      ))}
    </div>
  );
};

// ── MediaImageInline ────────────────────────────────────────────────────────

const MediaImageInline: React.FC<{ artifacts: Artifact[] }> = ({ artifacts }) => {
  if (artifacts.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {artifacts.map(artifact => {
        const src = artifact.filePath
          ? toLocalFileSrc(artifact.filePath)
          : artifact.content;
        if (!src) return null;
        return (
          <img
            key={artifact.id}
            src={src}
            alt={artifact.title || ''}
            className="max-w-[320px] max-h-[240px] rounded-lg border border-border object-contain"
          />
        );
      })}
    </div>
  );
};

// ── AssistantTurnBlock ───────────────────────────────────────────────────────

const AssistantTurnBlock: React.FC<{
  turn: ConversationTurn;
  artifacts?: Artifact[];
  resolveLocalFilePath?: (href: string, text: string) => string | null;
  mapDisplayText?: (value: string) => string;
  localServiceDirectory?: string;
  onOpenLocalService?: (artifact: Artifact) => void;
  onDeployLocalService?: (artifact: Artifact) => void;
  onOpenHtmlFile?: (artifact: Artifact) => void;
  onOpenArtifactPreview?: (artifact: Artifact) => void;
  onForkMessage?: (messageId: string) => void;
  planConfirmationMessageId?: string | null;
  onConfirmPlan?: (messageId: string) => void;
  onAdjustPlan?: (messageId: string) => void;
  /** Replaces a tool_group's rendering entirely (e.g. subagent spawn cards). */
  renderToolGroupOverride?: (group: ToolGroupItem) => React.ReactNode;
  showActivityIndicator?: boolean;
  activityStatusOverride?: string | null;
  showCopyButtons?: boolean;
  completedGoal?: CoworkGoal | null;
  hiddenSystemMessageId?: string | null;
  searchTargetMessageId?: string | null;
  /** True when this turn is the one currently streaming; keeps the latest activity step visible. */
  isStreamingTurn?: boolean;
  /** True while subagents spawned in this turn are still running; keeps the process unfolded. */
  hasRunningSubagents?: boolean;
}> = ({
  turn,
  artifacts,
  resolveLocalFilePath,
  mapDisplayText,
  localServiceDirectory,
  onOpenLocalService,
  onDeployLocalService,
  onOpenHtmlFile,
  onOpenArtifactPreview,
  onForkMessage,
  planConfirmationMessageId,
  onConfirmPlan,
  onAdjustPlan,
  renderToolGroupOverride,
  showActivityIndicator = false,
  activityStatusOverride = null,
  showCopyButtons = true,
  completedGoal,
  hiddenSystemMessageId,
  searchTargetMessageId,
  isStreamingTurn = false,
  hasRunningSubagents = false,
}) => {
  const creditQuotaSnapshot = useSelector((state: RootState) => state.auth.creditQuotaSnapshot);
  const hideCreditQuotaBanner = !creditQuotaSnapshot || creditQuotaSnapshot.creditsRemaining > 0;
  const [artifactCardsExpanded, setArtifactCardsExpanded] = useState(false);
  const [processExpanded, setProcessExpanded] = useState(false);
  const visibleAssistantItems = useMemo(
    () => getVisibleAssistantItems(turn.assistantItems).filter(item => {
      if (!isStreamingTurn && isAbandonedToolPlaceholder(item)) return false;
      if (!hideCreditQuotaBanner || item.type !== 'system') return true;
      return !isCreditQuotaExhaustedKey(getSystemMessageErrorKey(item.message, item.message.content));
    }),
    [turn.assistantItems, hideCreditQuotaBanner, isStreamingTurn],
  );
  const consolidatedItems = useMemo(
    () => consolidateMediaPolling(visibleAssistantItems),
    [visibleAssistantItems],
  );
  const toolGroupOverrides = useMemo(() => {
    const overrides = new Map<string, React.ReactNode>();
    if (!renderToolGroupOverride) return overrides;
    for (const item of consolidatedItems) {
      if (item.type !== 'tool_group') continue;
      const override = renderToolGroupOverride(item.group);
      if (override) overrides.set(item.group.toolUse.id, override);
    }
    return overrides;
  }, [consolidatedItems, renderToolGroupOverride]);
  const videoPathArtifacts = useMemo(
    () => getVideoPathArtifacts(artifacts),
    [artifacts],
  );
  const artifactCards = useMemo(
    () => artifacts
      ? dedupeArtifactsForDisplay(
          artifacts,
          { defaultProjectDirectory: localServiceDirectory },
        )
      : [],
    [artifacts, localServiceDirectory],
  );
  const visibleArtifactCards = useMemo(() => {
    return artifactCardsExpanded ? artifactCards : artifactCards.slice(0, 3);
  }, [artifactCards, artifactCardsExpanded]);
  const hiddenArtifactCardCount = Math.max(0, artifactCards.length - visibleArtifactCards.length);
  const retainedMediaPollCountsRef = useRef<Map<string, number>>(new Map());
  const currentMediaPollCounts = useMemo(
    () => collectMediaPollCounts(consolidatedItems),
    [consolidatedItems],
  );
  const retainedMediaPollCounts = useMemo(() => {
    const next = new Map(retainedMediaPollCountsRef.current);
    for (const [key, pollCount] of currentMediaPollCounts) {
      next.set(key, Math.max(next.get(key) ?? 0, pollCount));
    }
    return next;
  }, [currentMediaPollCounts]);

  useEffect(() => {
    retainedMediaPollCountsRef.current = retainedMediaPollCounts;
  }, [retainedMediaPollCounts]);

  useEffect(() => {
    setArtifactCardsExpanded(false);
    setProcessExpanded(false);
  }, [turn.id]);

  const renderSystemMessage = (message: CoworkMessage) => {
    if (message.id === hiddenSystemMessageId) {
      return null;
    }
    const isError = !hasText(message.content) && typeof message.metadata?.error === 'string';
    const rawContent = hasText(message.content)
      ? message.content
      : (typeof message.metadata?.error === 'string' ? message.metadata.error : '');
    if (getMediaCompletionDisplayText(message, rawContent)) {
      return null;
    }
    const normalizedContent = getScheduledReminderDisplayText(rawContent) ?? rawContent;
    const errorKey = getSystemMessageErrorKey(message, normalizedContent);
    if (isCreditQuotaExhaustedKey(errorKey)) {
      return hideCreditQuotaBanner
        ? null
        : <CreditQuotaExhaustedBanner offer={creditQuotaSnapshot.purchaseOffer} creditsRemaining={creditQuotaSnapshot.creditsRemaining} />;
    }
    const displayContent = getSystemMessageDisplayContent(message, normalizedContent);
    const content = mapDisplayText ? mapDisplayText(displayContent) : displayContent;
    if (!content.trim() && !isContextCompactionMessage(message)) return null;

    if (isContextCompactionMessage(message)) {
      const status = message.metadata?.status;
      return (
        <ContextCompactionDivider
          label={getContextCompactionMessageLabel(message, content)}
          active={status === ContextCompactionStatus.Running}
        />
      );
    }

    const errorDetail = parseCoworkErrorDetail(message.metadata?.errorDetail);
    const errorModelLine = errorDetail ? buildErrorModelLine(errorDetail) : null;

    return (
      <div className="rounded-lg border border-border bg-background px-3 py-2">
        <div className="flex items-center gap-2">
          {isError
            ? <ExclamationTriangleIcon className="h-4 w-4 text-secondary flex-shrink-0" />
            : <InformationCircleIcon className="h-4 w-4 text-secondary flex-shrink-0" />
          }
          <div className="min-w-0 text-xs text-secondary">
            <MarkdownContent
              content={content}
              className="!text-xs !leading-5 [&_a]:!text-primary [&_p]:!my-0 [&_p]:!text-secondary [&_p]:!leading-5"
            />
          </div>
        </div>
        {errorModelLine && (
          <div className="mt-1 pl-6 text-xs text-muted">{errorModelLine}</div>
        )}
        {errorDetail && <SystemErrorTechnicalDetail detail={errorDetail} />}
      </div>
    );
  };

  const renderOrphanToolResult = (message: CoworkMessage) => {
    const toolResultDisplayRaw = getToolResultDisplay(message);
    const toolResultDisplay = mapDisplayText ? mapDisplayText(toolResultDisplayRaw) : toolResultDisplayRaw;
    const isToolError = Boolean(message.metadata?.isError || message.metadata?.error);
    const hasToolResultText = hasText(toolResultDisplay);
    const resultLineCount = hasToolResultText ? getToolResultLineCount(toolResultDisplay) : 0;
    const showNoDetailError = isToolError && !hasToolResultText;
    const fallbackText = showNoDetailError ? i18nService.t('coworkToolNoErrorDetail') : '';
    const displayText = hasToolResultText ? toolResultDisplay : fallbackText;
    return (
      <div className="py-1">
        <div className="flex items-start gap-2">
          <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${
            isToolError ? 'bg-red-500' : 'bg-surface-raised'
          }`} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-secondary">
              {i18nService.t('coworkToolResult')}
            </div>
            {resultLineCount > 0 && (
              <div className="text-xs text-muted mt-0.5">
                {getToolResultLineCountSummary(resultLineCount)}
              </div>
            )}
            {resultLineCount === 0 && showNoDetailError && (
              <div className={`text-xs mt-0.5 ${
                isToolError
                  ? 'text-red-500/80'
                  : 'text-muted'
              }`}>
                {fallbackText}
              </div>
            )}
            {(hasToolResultText || showNoDetailError) && (
              <div className="mt-2 px-3 py-2 rounded-lg bg-surface-raised max-h-64 overflow-y-auto">
                <pre className={`text-code whitespace-pre-wrap break-words font-mono ${
                  isToolError
                    ? 'text-red-500'
                    : hasToolResultText
                      ? 'text-foreground'
                      : 'text-secondary italic'
                }`}>
                  {displayText}
                </pre>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  // Consecutive work items between pieces of text form one activity run
  // (WorkBuddy style): a finished run folds into a single summary line,
  // while the running turn's tail run lists every step on its own line.
  // Tool groups with an override (e.g. subagent cards) stay visible on
  // their own.
  const renderChunks = chunkConsolidatedItemsForDisplay(
    consolidatedItems,
    (item) => isActivityConsolidatedItem(item)
      && !(item.type === 'tool_group' && toolGroupOverrides.has(item.group.toolUse.id)),
  );

  // Indices that render as standalone timeline rows; the timeline connector
  // only draws between two consecutive ones (collapsed groups broke the old
  // next-item heuristic).
  const timelineToolIndices = new Set(
    renderChunks
      .filter((chunk): chunk is Extract<typeof renderChunks[number], { kind: 'item' }> => chunk.kind === 'item')
      .filter((chunk) => chunk.item.type === 'tool_group' || chunk.item.type === 'media_polling_group')
      .map((chunk) => chunk.index),
  );

  const renderConsolidatedItem = (
    item: ConsolidatedItem,
    index: number,
    displayVariant: 'timeline' | ActivityEntryVariant = 'timeline',
    isLive?: boolean,
  ): React.ReactNode => {
    // A step line inside an activity run has no timeline connector to draw.
    const isGroupEntry = displayVariant !== 'timeline';
    if (item.type === 'media_polling_group') {
      const isLastInSequence = isGroupEntry || !timelineToolIndices.has(index + 1);
      const retainedPollCount = getRetainedMediaPollCount(
        { taskId: item.group.taskId, upstreamTaskId: item.group.upstreamTaskId },
        retainedMediaPollCounts,
      );
      const indicator = (
        <MediaPollingIndicator
          key={`media-poll-${item.group.taskId}`}
          group={{
            ...item.group,
            pollCount: retainedPollCount ?? item.group.pollCount,
          }}
          isLastInSequence={isLastInSequence}
        />
      );
      return indicator;
    }

    if (item.type === 'assistant') {
      if (item.message.metadata?.isThinking) {
        return (
          <ThinkingBlock
            key={item.message.id}
            message={item.message}
            mapDisplayText={mapDisplayText}
            variant={isGroupEntry ? displayVariant : 'default'}
            isLive={isLive}
          />
        );
      }

      if (isDuplicateGeneratedVideoAssistantMessage(item.message, videoPathArtifacts)) {
        return null;
      }

      // Check if there are image artifacts for this message (inline MEDIA display)
      const imageArtifacts = artifacts?.filter(a =>
        a.type === 'image' && a.messageId === item.message.id,
      );
      if (imageArtifacts && imageArtifacts.length > 0 && !item.message.content.replace(/\s*MEDIA\s*/gi, '').trim()) {
        return (
          <MediaImageInline key={item.message.id} artifacts={imageArtifacts} />
        );
      }

      const hasToolGroupAfter = consolidatedItems
        .slice(index + 1)
        .some(laterItem => laterItem.type === 'tool_group' || laterItem.type === 'media_polling_group');
      const isLastAssistant = showCopyButtons && !hasToolGroupAfter;
      const hasAssistantAfter = consolidatedItems
        .slice(index + 1)
        .some(laterItem => laterItem.type === 'assistant');

      return (
        <AssistantMessageItem
          key={item.message.id}
          message={item.message}
          resolveLocalFilePath={resolveLocalFilePath}
          mapDisplayText={mapDisplayText}
          showCopyButton={isLastAssistant}
          onFork={isLastAssistant ? onForkMessage : undefined}
          turnMetadata={isLastAssistant ? (item.message.metadata as CoworkMessageMetadata) : undefined}
          completedGoal={isLastAssistant && !hasAssistantAfter ? completedGoal : null}
          planConfirmationMessageId={planConfirmationMessageId}
          onConfirmPlan={onConfirmPlan}
          onAdjustPlan={onAdjustPlan}
          forceSearchExpanded={searchTargetMessageId === item.message.id}
        />
      );
    }

    if (item.type === 'tool_group') {
      const override = toolGroupOverrides.get(item.group.toolUse.id);
      if (override) {
        return (
          <div key={`tool-${item.group.toolUse.id}`}>
            {override}
          </div>
        );
      }
      const isLastInSequence = isGroupEntry || !timelineToolIndices.has(index + 1);
      return (
        <ToolCallGroup
          key={`tool-${item.group.toolUse.id}`}
          group={item.group}
          isLastInSequence={isLastInSequence}
          mapDisplayText={mapDisplayText}
          retainedMediaPollCounts={retainedMediaPollCounts}
          variant={displayVariant}
          isLive={isLive}
        />
      );
    }

    if (item.type === 'system') {
      const systemMessage = renderSystemMessage(item.message);
      if (!systemMessage) {
        return null;
      }
      return (
        <div key={item.message.id}>
          {systemMessage}
        </div>
      );
    }

    return (
      <div key={item.message.id}>
        {renderOrphanToolResult(item.message)}
      </div>
    );
  };

  // The turn's last work item while it runs; the status line and the tail
  // step describe what it is doing right now.
  const liveTailItem = isStreamingTurn && consolidatedItems.length > 0
    ? consolidatedItems[consolidatedItems.length - 1]
    : null;
  // The runtime closes a thought (or reply segment) only when the next tool
  // starts, and a tool call's arguments do not stream here, so a tail text
  // that stopped growing means the model has moved on. It then stops reading
  // as "thinking": the status line says "working" and the step settles.
  const isTailTextStalled = useStreamStall(getStreamingTextSignature(liveTailItem), STREAM_STALL_MS);

  const renderChunk = (chunk: (typeof renderChunks)[number], chunkIndex: number): React.ReactNode => {
    if (chunk.kind === 'item') {
      return renderConsolidatedItem(chunk.item, chunk.index);
    }
    return (
      <ActivityGroupBlock
        key={`activity-${getConsolidatedItemKey(chunk.entries[0].item)}`}
        entries={chunk.entries}
        isLiveRun={isStreamingTurn && chunkIndex === renderChunks.length - 1}
        isTailStalled={isTailTextStalled}
        renderEntry={(entry, isLive) => renderConsolidatedItem(
          entry.item,
          entry.index,
          ActivityEntryVariant.Row,
          isLive,
        )}
      />
    );
  };

  // Once the turn completes, everything before the final answer folds behind
  // a single duration line so the user reads input → answer, expanding only
  // when they want the process. A turn with subagents still running is not
  // complete — their working cards must stay visible. Neither is a turn with
  // no trailing answer yet (it ended waiting for subagents, or sits in the
  // gap before the parent run resumes after they hand back): folding then
  // would hide everything behind an empty duration line.
  const answerStartIndex = getTurnAnswerStartIndex(renderChunks);
  const processChunks = renderChunks.slice(0, answerStartIndex);
  const answerChunks = renderChunks.slice(answerStartIndex);
  const shouldFoldProcess = !isStreamingTurn
    && !hasRunningSubagents
    && canFoldTurnProcess(renderChunks, answerStartIndex);
  const processContainsSearchTarget = Boolean(searchTargetMessageId) && processChunks.some(
    (chunk) => chunk.kind === 'item'
      && chunk.item.type === 'assistant'
      && chunk.item.message.id === searchTargetMessageId,
  );
  // Tool errors stay on their own step row (Codex app behavior); they do not
  // color this duration line or force the fold open.
  const isProcessExpanded = processExpanded || processContainsSearchTarget;
  const turnStartTimestamp = getTurnStartTimestamp(turn);
  const turnEndTimestamp = getTurnEndTimestamp(turn);
  const processDurationMs = turnStartTimestamp != null && turnEndTimestamp != null
    ? turnEndTimestamp - turnStartTimestamp
    : null;
  const processBaseLabel = processDurationMs != null && processDurationMs >= 1000
    ? i18nService.t('coworkTurnProcessDuration').replace('{duration}', formatTurnDuration(processDurationMs))
    : i18nService.t('coworkTurnProcess');
  // The folded line is just the duration. Step and failure counts only feed
  // analytics: a turn that reached an answer worked around any failed step
  // on its own, and the expanded rows still mark each one.
  const processStepCount = countTurnCompletedSteps(turn);
  const failedStepCount = countTurnFailedSteps(turn);
  const processLabel = processBaseLabel;
  // What the running step is doing right now, for the status line: the last
  // work item while it is still live; null in the silent gaps between steps.
  const liveStatusText = liveTailItem && isActivityItemLive(liveTailItem) && !isTailTextStalled
    ? getActivityLiveStatusText(liveTailItem)
    : null;

  const handleProcessToggle = () => {
    const nextExpanded = !isProcessExpanded;
    reportConversationBlockAction({
      actionType: nextExpanded ? 'turn_process_expand' : 'turn_process_collapse',
      blockType: 'turn_process',
      params: {
        processChunkCount: processChunks.length,
        stepCount: processStepCount,
        failedStepCount,
        durationMs: processDurationMs ?? undefined,
      },
    });
    setProcessExpanded(nextExpanded);
  };

  if (renderChunks.length === 0 && !showActivityIndicator && !artifacts?.length) {
    return null;
  }

  return (
    <div className={`py-2 ${COWORK_DETAIL_GUTTER_CLASS}`}>
      <div className={COWORK_DETAIL_CONTENT_CLASS}>
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0 py-3 space-y-3">
            {shouldFoldProcess ? (
              <>
                {/* Unlike step lines, the duration line keeps its arrow: it is
                    the only way back into a finished turn's whole process. */}
                <ActivityStepLine
                  label={processLabel}
                  isExpanded={isProcessExpanded}
                  onToggle={handleProcessToggle}
                  trailing={(
                    <ChevronRightIcon
                      className={`h-[0.9em] w-[0.9em] flex-shrink-0 transition-transform duration-200 ${
                        isProcessExpanded ? 'rotate-90' : ''
                      }`}
                      aria-hidden="true"
                    />
                  )}
                />
                {isProcessExpanded && processChunks.map((chunk, index) => renderChunk(chunk, index))}
                {answerChunks.map((chunk, index) => renderChunk(chunk, answerStartIndex + index))}
              </>
            ) : (
              renderChunks.map((chunk, chunkIndex) => renderChunk(chunk, chunkIndex))
            )}
            {showActivityIndicator && (
              <ActivityIndicator
                fingerprint={getTurnActivityFingerprint(turn)}
                startTimestamp={getTurnStartTimestamp(turn)}
                statusTextOverride={activityStatusOverride}
                liveStatusText={liveStatusText}
                hasContent={visibleAssistantItems.length > 0}
              />
            )}
            {artifacts && artifacts.length > 0 && (
              <div className="space-y-2 pt-1">
                <VideoArtifactPathList artifacts={videoPathArtifacts} />
                <div className="artifact-preview-card-group w-full overflow-hidden rounded-lg border border-border">
                  <div className="divide-y divide-border">
                    {visibleArtifactCards.map(artifact => (
                      <ArtifactPreviewCard
                        key={artifact.id}
                        artifact={artifact}
                        localServiceDirectory={localServiceDirectory}
                        onOpenLocalService={onOpenLocalService}
                        onDeployLocalService={onDeployLocalService}
                        onOpenHtmlFile={onOpenHtmlFile}
                        onOpenPreview={onOpenArtifactPreview}
                      />
                    ))}
                  </div>
                  {(hiddenArtifactCardCount > 0 || (artifactCardsExpanded && artifactCards.length > 3)) && (
                    <div className="border-t border-border px-4 py-2 text-center">
                      {hiddenArtifactCardCount > 0 ? (
                        <button
                          type="button"
                          onClick={() => setArtifactCardsExpanded(true)}
                          className="inline-flex items-center justify-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-secondary hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/[0.035] transition-colors"
                        >
                          <span>{i18nService.t('artifactPreviewCardShowMore').replace('{count}', String(hiddenArtifactCardCount))}</span>
                          <ChevronDownIcon className="h-4 w-4" />
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setArtifactCardsExpanded(false)}
                          className="inline-flex items-center justify-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-secondary hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/[0.035] transition-colors"
                        >
                          <span>{i18nService.t('artifactPreviewCardShowLess')}</span>
                          <ChevronUpIcon className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export { ContextCompactionDivider };

export default AssistantTurnBlock;
