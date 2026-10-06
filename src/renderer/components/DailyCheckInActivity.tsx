import {
  CheckCircleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import {
  ActivityServerErrorCode,
  type DailyCheckInDescriptor,
} from '@shared/activity/constants';
import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useSelector } from 'react-redux';

import dailyCheckInGiftUrl from '../assets/daily-check-in-gift.png';
import { authService } from '../services/auth';
import { i18nService } from '../services/i18n';
import type { RootState } from '../store';
import { ACCOUNT_MENU_COMPACT_CTA_CLASS_NAME } from './accountMenuStyles';
import {
  formatDailyCheckInCredits,
  shouldShowDailyCheckInAccountMenuEntry,
  shouldShowDailyCheckInEntry,
} from './dailyCheckInActivityState';
import {
  DailyCheckInAnalyticsActionType,
  DailyCheckInAnalyticsResult,
  DailyCheckInAnalyticsSource,
  getDailyCheckInAnalyticsContext,
  getDailyCheckInAnalyticsErrorCode,
  reportDailyCheckInAction,
} from './dailyCheckInAnalytics';
import {
  DailyCheckInRequestError,
  type DailyCheckInSnapshot,
  DailyCheckInStaleRequestError,
  useDailyCheckInActivity,
} from './useDailyCheckInActivity';

const CLAIM_SUCCESS_DURATION_MS = 2200;
const CJK_TEXT_PATTERN = /[\u3400-\u9fff]/;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

const showToast = (message: string): void => {
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
};

export const getLocalizedDailyCheckInText = (
  serverText: string | null | undefined,
  fallback: string,
): string => {
  const trimmedText = serverText?.trim();
  if (!trimmedText) return fallback;
  if (i18nService.getLanguage() === 'en' && CJK_TEXT_PATTERN.test(trimmedText)) {
    return fallback;
  }
  return trimmedText;
};

const getRewardValidityDays = (
  claimedAt: string,
  expiresAt: string,
): number | null => {
  const claimedAtMs = Date.parse(claimedAt);
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(claimedAtMs)
      || !Number.isFinite(expiresAtMs)
      || expiresAtMs <= claimedAtMs) {
    return null;
  }
  return Math.max(1, Math.round(
    (expiresAtMs - claimedAtMs) / MILLISECONDS_PER_DAY,
  ));
};

interface DailyCheckInLoginModalProps {
  descriptor: DailyCheckInDescriptor;
  onClose: () => void;
}

export const DailyCheckInLoginModal: React.FC<DailyCheckInLoginModalProps> = ({
  descriptor,
  onClose,
}) => {
  const [startingLogin, setStartingLogin] = useState(false);
  const modalTitle = getLocalizedDailyCheckInText(
    descriptor.guestModalTitle,
    i18nService.t('dailyCheckInGuestModalTitle'),
  );
  const modalDescription = getLocalizedDailyCheckInText(
    descriptor.guestModalDescription,
    i18nService.t('dailyCheckInGuestModalDescription'),
  );
  const modalActionText = getLocalizedDailyCheckInText(
    descriptor.guestModalActionText,
    i18nService.t('dailyCheckInGuestModalAction'),
  );

  const startLogin = async () => {
    if (startingLogin) return;
    setStartingLogin(true);
    try {
      const result = await authService.login();
      if (!result.success) {
        throw new Error(result.error || i18nService.t('dailyCheckInLoginFailed'));
      }
      onClose();
    } catch (error) {
      showToast(error instanceof Error
        ? error.message
        : i18nService.t('dailyCheckInLoginFailed'));
    } finally {
      setStartingLogin(false);
    }
  };

  return createPortal(
    <div
      className="non-draggable fixed inset-0 z-[110] flex items-center justify-center bg-black/30 p-6 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-label={modalTitle}
    >
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        aria-label={i18nService.t('close')}
        onClick={onClose}
      />
      <section className="relative z-10 w-[320px] overflow-hidden rounded-2xl border border-black/10 bg-white px-5 pb-4 pt-5 text-center shadow-2xl dark:border-white/10 dark:bg-[#202124]">
        <button
          type="button"
          className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-full text-secondary transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
          aria-label={i18nService.t('close')}
          onClick={onClose}
        >
          <XMarkIcon className="h-4 w-4" />
        </button>
        <img
          src={dailyCheckInGiftUrl}
          alt=""
          aria-hidden="true"
          className="mx-auto -mt-1 mb-3 h-[78px] w-[92px] object-contain drop-shadow-lg"
        />
        <h2 className="text-base font-semibold text-foreground">
          {modalTitle}
        </h2>
        <p className="mx-auto mt-2 max-w-[260px] text-xs leading-5 text-secondary">
          {modalDescription}
        </p>
        <button
          type="button"
          disabled={startingLogin}
          onClick={() => void startLogin()}
          className="mt-5 flex h-10 w-full items-center justify-center rounded-lg bg-[#4D73E8] text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {startingLogin
            ? i18nService.t('dailyCheckInStartingLogin')
            : modalActionText}
        </button>
        <p className="mt-2 text-[10px] leading-4 text-secondary/80">
          {i18nService.t('dailyCheckInLoginHint')}
        </p>
      </section>
    </div>,
    document.body,
  );
};

interface DailyCheckInHeaderEntryProps {
  enabled?: boolean;
  suppressed?: boolean;
}

interface DailyCheckInAccountMenuEntryProps {
  enabled?: boolean;
  initialSnapshot?: DailyCheckInSnapshot | null;
  loadOnMount?: boolean;
  suppressed?: boolean;
}

interface DailyCheckInSuccessState {
  credits: number;
  validityDays: number | null;
}

interface DailyCheckInSuccessPopoverProps {
  success: DailyCheckInSuccessState;
  className: string;
}

interface DailyCheckInEntryControllerOptions {
  enabled?: boolean;
  initialSnapshot?: DailyCheckInSnapshot | null;
  loadOnMount?: boolean;
  suppressed?: boolean;
  showClaimedToday?: boolean;
  source: DailyCheckInAnalyticsSource;
  successDurationMs?: number | null;
}

const DailyCheckInSuccessPopover: React.FC<DailyCheckInSuccessPopoverProps> = ({
  success,
  className,
}) => (
  <section
    role="status"
    aria-live="polite"
    className={`flex items-center gap-3 rounded-xl border border-[#F1D3C0] bg-[#FFF9F5] p-3 text-[#59321F] shadow-popover dark:border-[#704530] dark:bg-[#302621] dark:text-[#F7D5C1] ${className}`}
  >
    <img
      src={dailyCheckInGiftUrl}
      alt=""
      aria-hidden="true"
      className="h-12 w-12 shrink-0 object-contain"
    />
    <div className="min-w-0">
      <div className="text-sm font-semibold">
        {i18nService.t('dailyCheckInRewardReceived')}
      </div>
      <div className="mt-0.5 text-base font-bold text-[#E36E32]">
        {i18nService.t('dailyCheckInRewardCredits').replace(
          '{credits}',
          formatDailyCheckInCredits(success.credits),
        )}
      </div>
      {success.validityDays !== null && (
        <div className="mt-0.5 text-[10px] text-[#8A6756] dark:text-[#C6A28E]">
          {i18nService.t('dailyCheckInValidityDays').replace(
            '{days}',
            String(success.validityDays),
          )}
        </div>
      )}
    </div>
  </section>
);

const useDailyCheckInEntryController = ({
  enabled = true,
  initialSnapshot = null,
  loadOnMount = true,
  suppressed = false,
  showClaimedToday = false,
  source,
  successDurationMs = CLAIM_SUCCESS_DURATION_MS,
}: DailyCheckInEntryControllerOptions) => {
  const isLoggedIn = useSelector((state: RootState) => state.auth.isLoggedIn);
  const activityEnabled = enabled && (loadOnMount || initialSnapshot !== null);
  const {
    snapshot,
    claiming,
    claim,
  } = useDailyCheckInActivity({
    autoRefresh: loadOnMount,
    enabled: activityEnabled,
    initialSnapshot,
    loadOnMount,
  });
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [success, setSuccess] = useState<DailyCheckInSuccessState | null>(null);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSuccessTimer = useCallback(() => {
    if (!successTimerRef.current) return;
    clearTimeout(successTimerRef.current);
    successTimerRef.current = null;
  }, []);

  const showSuccess = useCallback((next: DailyCheckInSuccessState) => {
    clearSuccessTimer();
    setSuccess(next);
    if (successDurationMs === null) return;
    successTimerRef.current = setTimeout(() => {
      setSuccess(null);
      successTimerRef.current = null;
    }, successDurationMs);
  }, [clearSuccessTimer, successDurationMs]);

  useEffect(() => () => clearSuccessTimer(), [clearSuccessTimer]);

  useEffect(() => {
    if (!enabled || suppressed) {
      setLoginModalOpen(false);
      clearSuccessTimer();
      setSuccess(null);
    }
  }, [clearSuccessTimer, enabled, suppressed]);

  useEffect(() => {
    if (isLoggedIn) setLoginModalOpen(false);
  }, [isLoggedIn]);

  const handleClaim = useCallback(async () => {
    if (!snapshot || claiming || success) return;
    const analyticsContext = getDailyCheckInAnalyticsContext({
      context: snapshot.context,
      descriptor: snapshot.descriptor,
      isLoggedIn,
      source,
    });
    reportDailyCheckInAction(analyticsContext, {
      actionType: DailyCheckInAnalyticsActionType.ClaimClick,
    });
    console.debug('[DailyCheckInActivity] claim requested', {
      source,
      activityCode: snapshot.descriptor.activityCode,
      configRevision: snapshot.descriptor.configRevision,
    });
    if (!isLoggedIn || !snapshot.context.authenticated) {
      reportDailyCheckInAction(analyticsContext, {
        actionType: DailyCheckInAnalyticsActionType.LoginRequired,
        result: DailyCheckInAnalyticsResult.Failed,
        errorCode: 'login_required',
      });
      console.debug('[DailyCheckInActivity] login required before claim', {
        source,
        activityCode: snapshot.descriptor.activityCode,
      });
      setLoginModalOpen(true);
      return;
    }

    try {
      const response = await claim();
      showSuccess({
        credits: response.result.creditsGranted,
        validityDays: getRewardValidityDays(
          response.result.claimedAt,
          response.result.expiresAt,
        ),
      });
      console.debug('[DailyCheckInActivity] claim succeeded', {
        source,
        activityCode: response.result.activityCode,
        creditsGranted: response.result.creditsGranted,
      });
      reportDailyCheckInAction(analyticsContext, {
        actionType: DailyCheckInAnalyticsActionType.ClaimSuccess,
        result: DailyCheckInAnalyticsResult.Success,
      });
    } catch (error) {
      if (error instanceof DailyCheckInStaleRequestError) return;
      if (error instanceof DailyCheckInRequestError) {
        if (error.code === ActivityServerErrorCode.AlreadyClaimed) {
          showSuccess({
            credits: snapshot.context.state.rewardCredits,
            validityDays: null,
          });
          reportDailyCheckInAction(analyticsContext, {
            actionType: DailyCheckInAnalyticsActionType.ClaimAlreadyClaimed,
            result: DailyCheckInAnalyticsResult.Success,
            errorCode: getDailyCheckInAnalyticsErrorCode(error.code),
          });
          return;
        }
        if (error.code === ActivityServerErrorCode.LoginRequired) {
          console.debug('[DailyCheckInActivity] server requested login before claim', {
            source,
            activityCode: snapshot.descriptor.activityCode,
          });
          reportDailyCheckInAction(analyticsContext, {
            actionType: DailyCheckInAnalyticsActionType.LoginRequired,
            result: DailyCheckInAnalyticsResult.Failed,
            errorCode: getDailyCheckInAnalyticsErrorCode(error.code),
          });
          setLoginModalOpen(true);
          return;
        }
        if (error.code === ActivityServerErrorCode.NotActive
            || error.code === ActivityServerErrorCode.NotFound) {
          reportDailyCheckInAction(analyticsContext, {
            actionType: DailyCheckInAnalyticsActionType.ClaimUnavailable,
            result: DailyCheckInAnalyticsResult.Failed,
            errorCode: getDailyCheckInAnalyticsErrorCode(error.code),
          });
          return;
        }
      }
      console.warn('[DailyCheckInActivity] claim failed', {
        source,
        activityCode: snapshot.descriptor.activityCode,
      }, error);
      reportDailyCheckInAction(analyticsContext, {
        actionType: DailyCheckInAnalyticsActionType.ClaimFailed,
        result: DailyCheckInAnalyticsResult.Failed,
        errorCode: error instanceof DailyCheckInRequestError
          ? getDailyCheckInAnalyticsErrorCode(error.code)
          : 'unknown',
      });
      showToast(i18nService.t('dailyCheckInClaimFailed'));
    }
  }, [claim, claiming, isLoggedIn, showSuccess, snapshot, source, success]);

  const stateAllowsEntry = snapshot
    ? showClaimedToday
      ? shouldShowDailyCheckInAccountMenuEntry(snapshot.context)
      : shouldShowDailyCheckInEntry(snapshot.context)
    : false;

  const entryLabel = getLocalizedDailyCheckInText(
    snapshot?.descriptor.cardTitle,
    i18nService.t('dailyCheckInEntry'),
  );
  const buttonLabel = success
    ? i18nService.t('dailyCheckInTodayClaimed')
    : claiming
      ? i18nService.t('dailyCheckInClaiming')
      : entryLabel;

  return {
    buttonLabel,
    claiming,
    entryLabel,
    handleClaim,
    isVisible: enabled && !suppressed && (stateAllowsEntry || success !== null),
    loginModalOpen,
    setLoginModalOpen,
    snapshot,
    success,
  };
};

export const DailyCheckInHeaderEntry: React.FC<
  DailyCheckInHeaderEntryProps
> = ({ enabled = true, suppressed = false }) => {
  const {
    buttonLabel,
    claiming,
    handleClaim,
    isVisible,
    loginModalOpen,
    setLoginModalOpen,
    snapshot,
    success,
  } = useDailyCheckInEntryController({
    enabled,
    suppressed,
    source: DailyCheckInAnalyticsSource.HomeHeader,
  });

  if (!isVisible) return null;

  return (
    <>
      <div className="relative mr-2">
        <button
          type="button"
          disabled={claiming || success !== null}
          onClick={() => void handleClaim()}
          className="inline-flex h-8 max-w-[240px] items-center gap-1.5 rounded-full border border-[#F1D3C0] bg-[#FFF8F3] px-3 text-xs font-medium text-[#7C4328] shadow-subtle transition-colors hover:bg-[#FFF0E6] disabled:cursor-default dark:border-[#704530] dark:bg-[#352A25] dark:text-[#F5C4A5] dark:hover:bg-[#403029]"
        >
          {success ? (
            <CheckCircleIcon className="h-4 w-4 shrink-0 text-[#E36E32]" />
          ) : (
            <img
              src={dailyCheckInGiftUrl}
              alt=""
              aria-hidden="true"
              className="h-4 w-4 shrink-0 object-contain"
            />
          )}
          <span className="truncate">{buttonLabel}</span>
        </button>

        {success && (
          <DailyCheckInSuccessPopover
            success={success}
            className="absolute right-0 top-10 z-50 w-[226px]"
          />
        )}
      </div>

      {loginModalOpen && snapshot && (
        <DailyCheckInLoginModal
          descriptor={snapshot.descriptor}
          onClose={() => setLoginModalOpen(false)}
        />
      )}
    </>
  );
};

export const DailyCheckInAccountMenuEntry: React.FC<
  DailyCheckInAccountMenuEntryProps
> = ({
  enabled = true,
  initialSnapshot = null,
  loadOnMount = true,
  suppressed = false,
}) => {
  const {
    claiming,
    entryLabel,
    handleClaim,
    isVisible,
    loginModalOpen,
    setLoginModalOpen,
    snapshot,
    success,
  } = useDailyCheckInEntryController({
    enabled,
    initialSnapshot,
    loadOnMount,
    suppressed,
    showClaimedToday: true,
    source: DailyCheckInAnalyticsSource.AccountMenu,
  });

  if (!isVisible) return null;

  const actionLabel = success
    ? i18nService.t('dailyCheckInTodayClaimed')
    : snapshot?.context.state.claimedToday
      ? i18nService.t('dailyCheckInClaimedAction')
      : claiming
      ? i18nService.t('dailyCheckInClaiming')
      : i18nService.t('dailyCheckInClaimNow');
  const claimed = success !== null || Boolean(snapshot?.context.state.claimedToday);

  return (
    <>
      <div className="relative px-2 py-1">
        <button
          type="button"
          disabled={claiming || claimed}
          onClick={() => void handleClaim()}
          className="flex h-8 w-full items-center gap-1.5 rounded-lg border border-[#F1D3C0] bg-[#FFF8F3] px-2 text-left text-[13px] font-medium text-[#7C4328] shadow-subtle transition-colors hover:bg-[#FFF0E6] disabled:cursor-default dark:border-[#704530] dark:bg-[#352A25] dark:text-[#F5C4A5] dark:hover:bg-[#403029]"
        >
          {claimed ? (
            <CheckCircleIcon className="h-[18px] w-[18px] shrink-0 text-[#E36E32]" />
          ) : (
            <img
              src={dailyCheckInGiftUrl}
              alt=""
              aria-hidden="true"
              className="h-[18px] w-[18px] shrink-0 object-contain"
            />
          )}
          <span className="min-w-0 flex-1 truncate">{entryLabel}</span>
          <span
            className={`ml-1 ${ACCOUNT_MENU_COMPACT_CTA_CLASS_NAME} ${
              claimed
                ? 'bg-[#F8D8C7] text-white dark:bg-[#704530] dark:text-[#F7D5C1]'
                : 'bg-[#111111] text-white dark:bg-white dark:text-black'
            }`}
          >
            {actionLabel}
          </span>
        </button>

        {success && (
          <DailyCheckInSuccessPopover
            success={success}
            className="absolute left-2 right-2 top-10 z-[60]"
          />
        )}
      </div>

      {loginModalOpen && snapshot && (
        <DailyCheckInLoginModal
          descriptor={snapshot.descriptor}
          onClose={() => setLoginModalOpen(false)}
        />
      )}
    </>
  );
};
