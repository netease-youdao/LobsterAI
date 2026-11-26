import {
  ArrowPathIcon,
  ChevronRightIcon,
} from '@heroicons/react/24/outline';
import { EnterpriseMemberRole } from '@shared/enterpriseAccount/constants';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useSelector } from 'react-redux';

import { selectEnterpriseAccountContext } from '../features/enterpriseAccount/selectors';
import { authService } from '../services/auth';
import { CreditsRefreshReason } from '../services/creditsRefreshScheduler';
import {
  getEnterpriseMemberProfileUrl,
  getPortalCreditsDetailUrl,
  getPortalPricingUrl,
  getPortalProfileUrl,
  getPortalRechargeUrl,
} from '../services/endpoints';
import { i18nService } from '../services/i18n';
import type { RootState } from '../store';
import { getAccountConnectionState } from './accountConnectionState';
import { getAccountPlanPresentation } from './accountMenuState';
import { ACCOUNT_MENU_COMPACT_CTA_CLASS_NAME } from './accountMenuStyles';
import {
  formatCreditExpiryDate,
  formatExactCredits,
  HomeCreditsDisplayStatus,
  HomeCreditsMode,
  resolveHomeCreditsViewModel,
} from './homeCreditsBadgeState';

const POPOVER_CLOSE_DELAY_MS = 140;

const CreditsStackIcon: React.FC<{ className?: string }> = ({
  className = 'h-4 w-4 shrink-0',
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="3 3 18 18"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <ellipse cx="12" cy="7.75" rx="5.75" ry="2.5" />
    <path d="M6.25 7.75V12.25C6.25 13.63 8.82 14.75 12 14.75C15.18 14.75 17.75 13.63 17.75 12.25V7.75" />
    <path d="M6.25 12.25V16.25C6.25 17.63 8.82 18.75 12 18.75C15.18 18.75 17.75 17.63 17.75 16.25V12.25" />
  </svg>
);

const HomeCreditsBadge: React.FC = () => {
  const isLoggedIn = useSelector((state: RootState) => state.auth.isLoggedIn);
  const isAuthLoading = useSelector((state: RootState) => state.auth.isLoading);
  const ownerAccountKey = useSelector((state: RootState) => state.auth.ownerAccountKey);
  const profileSummary = useSelector((state: RootState) => state.auth.profileSummary);
  const creditQuotaSnapshot = useSelector((state: RootState) => state.auth.creditQuotaSnapshot);
  const connectionState = useSelector((state: RootState) => getAccountConnectionState(state.auth));
  const enterpriseContext = useSelector(selectEnterpriseAccountContext);

  const [isRefreshing, setIsRefreshing] = useState(() => authService.isCreditsRefreshing());
  const [popoverOpen, setPopoverOpen] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasPopoverOpenRef = useRef(false);

  useEffect(() => {
    setIsRefreshing(authService.isCreditsRefreshing());
    return authService.subscribeCreditsRefreshing(setIsRefreshing);
  }, []);

  const viewModel = useMemo(
    () => resolveHomeCreditsViewModel({
      isLoggedIn,
      isAuthLoading,
      connectionState,
      profileSummary,
      creditQuotaSnapshot,
      enterpriseContext,
      isRefreshing,
    }),
    [
      connectionState,
      creditQuotaSnapshot,
      enterpriseContext,
      isAuthLoading,
      isLoggedIn,
      isRefreshing,
      profileSummary,
    ],
  );

  const needsInitialLoadRef = useRef(false);
  needsInitialLoadRef.current = viewModel?.needsInitialLoad ?? false;

  useEffect(() => {
    if (!isLoggedIn || !ownerAccountKey) return undefined;
    return authService.acquireCreditsDisplaySurface({
      needsInitialLoad: needsInitialLoadRef.current,
    });
  }, [enterpriseContext?.enterpriseId, isLoggedIn, ownerAccountKey]);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const openPopover = useCallback(() => {
    clearCloseTimer();
    setPopoverOpen(true);
  }, [clearCloseTimer]);

  const closePopoverImmediately = useCallback(() => {
    clearCloseTimer();
    setPopoverOpen(false);
  }, [clearCloseTimer]);

  const schedulePopoverClose = useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setPopoverOpen(false);
    }, POPOVER_CLOSE_DELAY_MS);
  }, [clearCloseTimer]);

  useEffect(() => () => clearCloseTimer(), [clearCloseTimer]);

  // Calibrate balance on popover open with the 2s hover throttle (Manus pattern).
  useEffect(() => {
    if (popoverOpen && !wasPopoverOpenRef.current) {
      void authService.requestCreditsRefresh(CreditsRefreshReason.Hover);
    }
    wasPopoverOpenRef.current = popoverOpen;
  }, [popoverOpen]);

  useEffect(() => {
    if (!popoverOpen) return undefined;
    const handlePointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        closePopoverImmediately();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closePopoverImmediately();
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closePopoverImmediately, popoverOpen]);

  const openExternalUrl = useCallback(async (url: string) => {
    try {
      await window.electron.shell.openExternal(url);
      closePopoverImmediately();
    } catch (error) {
      console.warn('[HomeCreditsBadge] failed to open portal link:', error);
    }
  }, [closePopoverImmediately]);

  const handleManualRefresh = useCallback(() => {
    void authService.requestCreditsRefresh(CreditsRefreshReason.Manual);
  }, []);

  if (!viewModel) return null;

  const isEn = i18nService.getLanguage() === 'en';
  const personalPlan = viewModel.mode === HomeCreditsMode.Personal
    ? getAccountPlanPresentation(viewModel.creditItems, isEn)
    : null;
  const planLabel = personalPlan?.label ?? i18nService.t('planFree');
  const planExpiryDate = personalPlan?.expiresAt
    ? formatCreditExpiryDate(personalPlan.expiresAt)
    : null;
  const canUpgradePlan = viewModel.mode === HomeCreditsMode.Personal
    && (personalPlan ? personalPlan.canUpgrade : true);
  const isEnterpriseSuperAdmin = enterpriseContext?.role === EnterpriseMemberRole.SuperAdmin;

  const pillTitle = viewModel.status === HomeCreditsDisplayStatus.Unavailable
    ? i18nService.t('authCreditsUnavailableRetry')
    : `${i18nService.t(
      viewModel.mode === HomeCreditsMode.Enterprise
        ? 'enterpriseAccountQuota'
        : 'authCreditsRemaining',
    )}: ${viewModel.exactText}`;

  const handlePillClick = () => {
    if (viewModel.status === HomeCreditsDisplayStatus.Unavailable) {
      handleManualRefresh();
      openPopover();
      return;
    }
    if (popoverOpen) {
      closePopoverImmediately();
    } else {
      openPopover();
    }
  };

  return (
    <div
      ref={containerRef}
      className="relative"
      onMouseEnter={openPopover}
      onMouseLeave={schedulePopoverClose}
    >
      <button
        type="button"
        onClick={handlePillClick}
        aria-haspopup="dialog"
        aria-expanded={popoverOpen}
        aria-label={pillTitle}
        title={pillTitle}
        className={`inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-surface px-3 text-[13px] font-medium leading-none text-foreground shadow-subtle transition-colors hover:bg-surface-raised tabular-nums ${
          popoverOpen ? 'bg-surface-raised' : ''
        }`}
      >
        <CreditsStackIcon className="h-4 w-4 shrink-0 text-foreground/85" />
        {viewModel.status === HomeCreditsDisplayStatus.Loading ? (
          <ArrowPathIcon className="h-3.5 w-3.5 animate-spin text-secondary" aria-hidden="true" />
        ) : (
          <span className="whitespace-nowrap">{viewModel.compactText}</span>
        )}
      </button>

      {popoverOpen && (
        <div
          role="dialog"
          aria-label={i18nService.t(
            viewModel.mode === HomeCreditsMode.Enterprise
              ? 'enterpriseAccountQuota'
              : 'authCreditsRemaining',
          )}
          className="absolute right-0 top-10 z-50 w-[17.5rem] rounded-xl border border-border bg-surface p-3.5 shadow-popover popover-enter"
        >
          {viewModel.mode === HomeCreditsMode.Enterprise && enterpriseContext ? (
            <>
              <div className="flex items-start justify-between gap-2 border-b border-border pb-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-foreground">
                    {enterpriseContext.enterpriseName}
                  </div>
                  <span
                    className={`mt-1 inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      isEnterpriseSuperAdmin
                        ? 'bg-primary/10 text-primary'
                        : 'bg-surface-raised text-secondary'
                    }`}
                  >
                    {i18nService.t(
                      isEnterpriseSuperAdmin
                        ? 'enterpriseAccountRoleSuperAdmin'
                        : 'enterpriseAccountRoleMember',
                    )}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleManualRefresh}
                  title={i18nService.t('homeCreditsRefresh')}
                  aria-label={i18nService.t('homeCreditsRefresh')}
                  className="inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
                >
                  <ArrowPathIcon
                    className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`}
                    aria-hidden="true"
                  />
                </button>
              </div>

              <div className="py-3">
                <div className="flex items-center justify-between text-xs text-secondary">
                  <span>{i18nService.t('enterpriseAccountQuota')}</span>
                  {viewModel.periodEndDate && (
                    <span>
                      {i18nService.t('homeCreditsPeriodResetsAt').replace(
                        '{date}',
                        viewModel.periodEndDate,
                      )}
                    </span>
                  )}
                </div>
                <div className="mt-1.5 flex items-baseline gap-1 tabular-nums">
                  <span className="text-xl font-semibold text-foreground">
                    {viewModel.exactText}
                  </span>
                  <span className="text-xs text-secondary">
                    / {viewModel.limitText} {i18nService.t('authCreditsUnit')}
                  </span>
                </div>
                <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-raised">
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-300"
                    style={{ width: `${Math.round((1 - viewModel.usageRatio) * 100)}%` }}
                  />
                </div>
              </div>

              <div className="border-t border-border pt-2.5">
                <button
                  type="button"
                  onClick={() => void openExternalUrl(
                    getEnterpriseMemberProfileUrl(enterpriseContext.enterpriseId),
                  )}
                  className="flex w-full cursor-pointer items-center justify-between rounded-lg px-1.5 py-1 text-xs font-medium text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
                >
                  <span>{i18nService.t('authUsageOverview')}</span>
                  <ChevronRightIcon className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2 border-b border-border pb-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-foreground">
                    {planLabel}
                  </div>
                  {planExpiryDate && (
                    <div className="mt-0.5 text-[11px] text-secondary">
                      {i18nService.t('authPlanExpiresAt').replace('{date}', planExpiryDate)}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void openExternalUrl(
                    canUpgradePlan ? getPortalPricingUrl() : getPortalRechargeUrl(),
                  )}
                  className={`${ACCOUNT_MENU_COMPACT_CTA_CLASS_NAME} cursor-pointer bg-action text-action-foreground transition-colors hover:bg-action-hover`}
                >
                  {i18nService.t(canUpgradePlan ? 'authUpgradePlan' : 'authGoRecharge')}
                </button>
              </div>

              <div className="py-3">
                <div className="flex items-center justify-between text-xs text-secondary">
                  <span>{i18nService.t('authCreditsRemaining')}</span>
                  <button
                    type="button"
                    onClick={handleManualRefresh}
                    title={i18nService.t('homeCreditsRefresh')}
                    aria-label={i18nService.t('homeCreditsRefresh')}
                    className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
                  >
                    <ArrowPathIcon
                      className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`}
                      aria-hidden="true"
                    />
                  </button>
                </div>

                {viewModel.status === HomeCreditsDisplayStatus.Unavailable ? (
                  <button
                    type="button"
                    onClick={handleManualRefresh}
                    className="mt-1.5 inline-flex cursor-pointer items-center gap-1.5 text-xs font-medium text-secondary transition-colors hover:text-foreground"
                  >
                    <span>{i18nService.t('authCreditsUnavailableRetry')}</span>
                  </button>
                ) : (
                  <div className="mt-1 flex items-baseline gap-1 tabular-nums">
                    <span className="text-xl font-semibold text-foreground">
                      {viewModel.exactText}
                    </span>
                    <span className="text-xs text-secondary">
                      {i18nService.t('authCreditsUnit')}
                    </span>
                  </div>
                )}

                {viewModel.mode === HomeCreditsMode.Personal && viewModel.creditItems.length > 0 && (
                  <div className="mt-3 space-y-2 border-t border-dashed border-border pt-2.5">
                    {viewModel.creditItems.map((item, index) => {
                      const label = (isEn ? item.labelEn : item.label) || item.label || item.labelEn;
                      const expiry = formatCreditExpiryDate(item.expiresAt);
                      return (
                        <div
                          key={`${item.type}:${label}:${item.expiresAt ?? index}`}
                          className="flex items-start justify-between gap-3 text-xs"
                        >
                          <div className="min-w-0">
                            <div className="truncate text-foreground/90">{label}</div>
                            {expiry && (
                              <div className="text-[10px] text-secondary">
                                {i18nService.t('authExpiresAt')} {expiry}
                              </div>
                            )}
                          </div>
                          <span className="shrink-0 font-medium text-foreground tabular-nums">
                            {formatExactCredits(item.creditsRemaining)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between gap-2 border-t border-border pt-2.5">
                <button
                  type="button"
                  onClick={() => void openExternalUrl(getPortalCreditsDetailUrl())}
                  className="inline-flex cursor-pointer items-center gap-0.5 rounded-md px-1.5 py-1 text-xs font-medium text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
                >
                  <span>{i18nService.t('homeCreditsViewDetails')}</span>
                  <ChevronRightIcon className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => void openExternalUrl(
                    canUpgradePlan ? getPortalRechargeUrl() : getPortalProfileUrl(),
                  )}
                  className="inline-flex cursor-pointer items-center gap-0.5 rounded-md px-1.5 py-1 text-xs font-medium text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
                >
                  <span>
                    {i18nService.t(canUpgradePlan ? 'authGoRecharge' : 'authUsageOverview')}
                  </span>
                  <ChevronRightIcon className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default HomeCreditsBadge;
