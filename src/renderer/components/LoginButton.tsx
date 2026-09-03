import { ArrowPathIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useSelector } from 'react-redux';

import inviteCreditsIconUrl from '../assets/icons/invite-credits.svg';
import logoutIconUrl from '../assets/icons/logout.svg';
import promoSubscriptionIconUrl from '../assets/icons/promo-subscription.svg';
import rechargeIconUrl from '../assets/icons/recharge.svg';
import soccerBallIconUrl from '../assets/icons/soccer-ball.svg';
import usageOverviewIconUrl from '../assets/icons/usage-overview.svg';
import { EnterpriseAccountMenu } from '../features/enterpriseAccount/components/EnterpriseAccountMenu';
import { selectEnterpriseAccountContext } from '../features/enterpriseAccount/selectors';
import { authService } from '../services/auth';
import {
  getPortalCreditsDetailUrl,
  getPortalCreditsResetActivityUrl,
  getPortalInvitationUrl,
  getPortalPricingUrl,
  getPortalProfileUrl,
  getPortalRechargeUrl,
} from '../services/endpoints';
import { i18nService } from '../services/i18n';
import { LogReporterAction, reportYdAnalyzer } from '../services/logReporter';
import { RootState } from '../store';
import type { FreeCreditsReward } from '../store/slices/authSlice';
import {
  type AccountPlanAnalyticsContext,
  getAccountMenuDisplayName,
  getAccountPlanAnalyticsContext,
  getAccountPlanPresentation,
  getFinalRewards,
} from './accountMenuState';
import { ACCOUNT_MENU_COMPACT_CTA_CLASS_NAME } from './accountMenuStyles';
import CreditsFinalRewardModal from './CreditsFinalRewardModal';
import { DailyCheckInAccountMenuEntry } from './DailyCheckInActivity';
import { getDailyCheckInAuthScopeKey } from './dailyCheckInActivityState';
import UserAvatarIcon from './icons/UserAvatarIcon';
import LowCreditPurchaseOfferCard from './LowCreditPurchaseOfferCard';
import {
  type StartupCreditCampaignEntry,
  useStartupCreditCampaignEntry,
} from './startupCreditCampaignBridge';
import {
  DailyCheckInLoadResultStatus,
  type DailyCheckInSnapshot,
  loadDailyCheckInSnapshot,
} from './useDailyCheckInActivity';

const ACCOUNT_MENU_ANALYTICS_SOURCE = 'home_account_menu';
const reportAccountMenuAction = (
  actionType: string,
  options: {
    accountMode?: AccountPlanAnalyticsContext['accountMode'];
    creditItemCount?: number;
    canUpgrade?: boolean;
    errorCode?: string;
    hasCredits?: boolean;
    hasSubscriptionPlan?: boolean;
    isLoggedIn?: boolean;
    planTier?: AccountPlanAnalyticsContext['planTier'];
    result?: 'success' | 'failed';
    subscriptionStatus?: string;
  } = {},
): void => {
  console.debug('[LoginButton] reporting account menu analytics');
  void reportYdAnalyzer({
    action: LogReporterAction.AccountMenuAction,
    source: ACCOUNT_MENU_ANALYTICS_SOURCE,
    actionType,
    accountMode: options.accountMode,
    canUpgrade: options.canUpgrade,
    errorCode: options.errorCode,
    result: options.result,
    isLoggedIn: options.isLoggedIn ?? true,
    hasCredits: options.hasCredits,
    hasSubscriptionPlan: options.hasSubscriptionPlan,
    creditItemCount: options.creditItemCount,
    planTier: options.planTier,
    subscriptionStatus: options.subscriptionStatus,
  });
};

const writeAccountMenuRendererLog = (
  level: 'debug' | 'warn',
  message: string,
): void => {
  try {
    window.electron?.log?.fromRenderer?.(level, 'LoginButton', message);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.debug(`[LoginButton] renderer log unavailable: ${errorMessage}`);
  }
};

const getPlanUpgradeLogMessage = (
  analytics: AccountPlanAnalyticsContext,
  hasCredits: boolean,
  suffix?: string,
): string => {
  const baseMessage = [
    'opening plan pricing portal',
    `accountMode=${analytics.accountMode}`,
    `subscriptionStatus=${analytics.subscriptionStatus}`,
    `planTier=${analytics.planTier}`,
    `hasSubscriptionPlan=${analytics.hasSubscriptionPlan}`,
    `canUpgrade=${analytics.canUpgrade}`,
    `hasCredits=${hasCredits}`,
  ].join(', ');
  return suffix ? `${baseMessage}, ${suffix}` : baseMessage;
};

const formatDate = (dateStr: string | null): string => {
  if (!dateStr) return '';
  const dateMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!dateMatch) return dateStr;
  return `${dateMatch[1]}.${dateMatch[2]}.${dateMatch[3]}`;
};

const formatCredits = (n: number): string => {
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(2);
};

const getFinalRewardText = (reward: FreeCreditsReward | undefined) => {
  const creditsText = reward ? formatCredits(reward.credits) : '0';
  const isEn = i18nService.getLanguage() === 'en';
  const presentation = reward?.presentation;
  return {
    creditsText,
    title: (isEn ? presentation?.titleEn : presentation?.titleZh)
      || i18nService.t('authFinalRewardAlt').replace('{credits}', creditsText),
    actionText: (isEn ? presentation?.actionTextEn : presentation?.actionTextZh)
      || i18nService.t('authFinalRewardAction').replace('{credits}', creditsText),
  };
};

interface AccountMenuActionProps {
  icon: React.ReactNode;
  label: string;
  onClick: () => void | Promise<void>;
  trailing?: React.ReactNode;
  danger?: boolean;
  title?: string;
}

const AccountMenuAction: React.FC<AccountMenuActionProps> = ({
  icon,
  label,
  onClick,
  trailing,
  danger = false,
  title,
}) => (
  <button
    type="button"
    title={title}
    onClick={() => void onClick()}
    className={`flex w-full cursor-pointer items-center gap-2 px-4 py-2 text-left text-[13px] transition-colors hover:bg-surface-raised ${
      danger ? 'text-red-500' : 'text-foreground'
    }`}
  >
    {icon}
    <span className="min-w-0 flex-1 truncate">{label}</span>
    {trailing}
  </button>
);

const DiamondSparkleIcon: React.FC = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="3 3 18 18"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-4 w-4 shrink-0 text-[#111111] dark:text-white"
    aria-hidden="true"
  >
    <path d="M12 4.75 14.15 9.85 19.25 12 14.15 14.15 12 19.25 9.85 14.15 4.75 12 9.85 9.85 12 4.75Z" />
  </svg>
);

interface AccountPlanActionProps {
  label: string;
  expiresAt: string | null;
  canUpgrade: boolean;
  onUpgrade: () => void | Promise<void>;
}

const AccountPlanAction: React.FC<AccountPlanActionProps> = ({
  label,
  expiresAt,
  canUpgrade,
  onUpgrade,
}) => {
  const isEnglish = i18nService.getLanguage() === 'en';
  const expiryText = expiresAt
    ? i18nService.t('authPlanExpiresAt').replace('{date}', formatDate(expiresAt))
    : null;

  return (
    <div className="flex w-full items-center gap-2 px-4 py-2 text-left text-[13px] text-foreground">
      <DiamondSparkleIcon />
      {isEnglish ? (
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium" title={label}>
            {label}
          </span>
          {expiryText && (
            <span className="mt-0.5 block truncate text-[9px] leading-3 text-secondary">
              {expiryText}
            </span>
          )}
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span
            className={expiryText ? 'max-w-[64px] shrink-0 truncate font-medium' : 'min-w-0 flex-1 truncate font-medium'}
            title={label}
          >
            {label}
          </span>
          {expiryText && (
            <span className="shrink-0 whitespace-nowrap text-[9px] leading-4 text-secondary">
              {expiryText}
            </span>
          )}
        </span>
      )}
      {canUpgrade && (
        <button
          type="button"
          onClick={() => void onUpgrade()}
          className={`${ACCOUNT_MENU_COMPACT_CTA_CLASS_NAME} bg-[#111111] text-white transition-colors hover:bg-[#2a2a2a] dark:bg-white dark:text-black dark:hover:bg-white/85`}
        >
          {i18nService.t('authUpgradePlan')}
        </button>
      )}
    </div>
  );
};

const PortalMenuIcon: React.FC<{ src: string; darkInvert?: boolean }> = ({
  src,
  darkInvert = false,
}) => (
  <img
    src={src}
    alt=""
    className={`h-4 w-4 shrink-0 ${darkInvert ? 'dark:invert' : ''}`}
    aria-hidden="true"
  />
);

const PointsStackIcon: React.FC = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="3 3 18 18"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    className="h-4 w-4 shrink-0 text-[#111111] dark:text-white"
    aria-hidden="true"
  >
    <ellipse cx="12" cy="7.75" rx="5.75" ry="2.5" />
    <path d="M6.25 7.75V12.25C6.25 13.63 8.82 14.75 12 14.75C15.18 14.75 17.75 13.63 17.75 12.25V7.75" />
    <path d="M6.25 12.25V16.25C6.25 17.63 8.82 18.75 12 18.75C15.18 18.75 17.75 17.63 17.75 16.25V12.25" />
  </svg>
);

interface UserMenuProps {
  dailyCheckInSnapshot: DailyCheckInSnapshot | null;
  onClose: () => void;
  onOpenFinalReward: (campaignCode: string) => void;
  startupCreditEntry: StartupCreditCampaignEntry;
}

const UserMenu: React.FC<UserMenuProps> = ({
  dailyCheckInSnapshot,
  onClose,
  onOpenFinalReward,
  startupCreditEntry,
}) => {
  const user = useSelector((state: RootState) => state.auth.user);
  const quota = useSelector((state: RootState) => state.auth.quota);
  const profileSummary = useSelector((state: RootState) => state.auth.profileSummary);
  const isEn = i18nService.getLanguage() === 'en';
  // The menu fetches on mount, so start in the loading state to avoid a
  // one-frame "--" flash before the mount effect runs.
  const [summaryLoading, setSummaryLoading] = useState(true);

  const refreshProfileSummary = useCallback(async () => {
    setSummaryLoading(true);
    try {
      await authService.fetchProfileSummary();
    } finally {
      setSummaryLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshProfileSummary();
  }, [refreshProfileSummary]);

  const openPortalUrl = async (url: string) => {
    await window.electron.shell.openExternal(url);
    onClose();
  };

  const handleLogout = async () => {
    try {
      await authService.logout();
      reportAccountMenuAction('logout', {
        creditItemCount: creditItems.length,
        hasCredits,
        result: 'success',
      });
      onClose();
    } catch (error) {
      reportAccountMenuAction('logout', {
        creditItemCount: creditItems.length,
        hasCredits,
        result: 'failed',
      });
      throw error;
    }
  };

  const handleCreditsDetail = async () => {
    if (!profileSummary) {
      // The summary never loaded (e.g. offline); clicking retries the fetch
      // instead of opening a portal page that would fail the same way.
      if (summaryLoading) return;
      reportAccountMenuAction('retry_profile_summary', {
        creditItemCount: creditItems.length,
        hasCredits,
      });
      await refreshProfileSummary();
      return;
    }
    try {
      await openPortalUrl(getPortalCreditsDetailUrl());
      reportAccountMenuAction('open_credits_detail', {
        creditItemCount: creditItems.length,
        hasCredits,
        result: 'success',
      });
    } catch (error) {
      reportAccountMenuAction('open_credits_detail', {
        creditItemCount: creditItems.length,
        hasCredits,
        result: 'failed',
      });
      throw error;
    }
  };

  const handleUsageOverview = async () => {
    try {
      await openPortalUrl(getPortalProfileUrl());
      reportAccountMenuAction('open_usage_overview', {
        creditItemCount: creditItems.length,
        hasCredits,
        result: 'success',
      });
    } catch (error) {
      reportAccountMenuAction('open_usage_overview', {
        creditItemCount: creditItems.length,
        hasCredits,
        result: 'failed',
      });
      throw error;
    }
  };

  const handleRecharge = async () => {
    reportAccountMenuAction('open_recharge', {
      creditItemCount: creditItems.length,
      hasCredits,
    });
    try {
      const message = 'opening recharge portal from account menu';
      console.debug(`[LoginButton] ${message}`);
      writeAccountMenuRendererLog('debug', message);
      const result = await window.electron.shell.openExternal(getPortalRechargeUrl());
      if (!result.success) {
        console.warn('[LoginButton] failed to open recharge portal:', result.error);
        writeAccountMenuRendererLog(
          'warn',
          `failed to open recharge portal from account menu: ${result.error ?? 'unknown'}`,
        );
        reportAccountMenuAction('open_recharge_failed', {
          creditItemCount: creditItems.length,
          errorCode: 'open_external_failed',
          hasCredits,
          result: 'failed',
        });
        return;
      }
      onClose();
    } catch (error) {
      console.warn('[LoginButton] failed to open recharge portal:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      writeAccountMenuRendererLog(
        'warn',
        `failed to open recharge portal from account menu: ${errorMessage}`,
      );
      reportAccountMenuAction('open_recharge_failed', {
        creditItemCount: creditItems.length,
        errorCode: 'unknown',
        hasCredits,
        result: 'failed',
      });
    }
  };

  const handleUpgradePlan = async () => {
    const accountPlanAnalytics = getAccountPlanAnalyticsContext({
      accountMode: user?.accountMode ?? quota?.accountMode,
      creditItems,
      planName: quota?.planName,
      subscriptionStatus: quota?.subscriptionStatus,
    });
    try {
      const logMessage = getPlanUpgradeLogMessage(accountPlanAnalytics, hasCredits);
      console.debug(`[LoginButton] ${logMessage}`);
      writeAccountMenuRendererLog('debug', logMessage);
      await openPortalUrl(getPortalPricingUrl());
      reportAccountMenuAction('open_plan_upgrade', {
        ...accountPlanAnalytics,
        creditItemCount: creditItems.length,
        hasCredits,
        result: 'success',
      });
    } catch (error) {
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      const logMessage = getPlanUpgradeLogMessage(
        accountPlanAnalytics,
        hasCredits,
        `result=failed error=${errorName}`,
      );
      console.warn(`[LoginButton] ${logMessage}`, error);
      writeAccountMenuRendererLog('warn', logMessage);
      reportAccountMenuAction('open_plan_upgrade', {
        ...accountPlanAnalytics,
        creditItemCount: creditItems.length,
        hasCredits,
        result: 'failed',
      });
      throw error;
    }
  };

  const handleInvite = async () => {
    try {
      await openPortalUrl(getPortalInvitationUrl());
      reportAccountMenuAction('open_invitation', {
        creditItemCount: creditItems.length,
        hasCredits,
        result: 'success',
      });
    } catch (error) {
      reportAccountMenuAction('open_invitation', {
        creditItemCount: creditItems.length,
        hasCredits,
        result: 'failed',
      });
      throw error;
    }
  };

  const handleCreditsResetActivity = async () => {
    try {
      await openPortalUrl(getPortalCreditsResetActivityUrl());
      reportAccountMenuAction('open_credits_reset_campaign', {
        creditItemCount: creditItems.length,
        hasCredits,
        result: 'success',
      });
    } catch (error) {
      reportAccountMenuAction('open_credits_reset_campaign', {
        creditItemCount: creditItems.length,
        hasCredits,
        result: 'failed',
      });
      throw error;
    }
  };

  const handleFinalReward = (reward: FreeCreditsReward) => {
    reportAccountMenuAction('open_credits_final_reward', {
      creditItemCount: creditItems.length,
      hasCredits,
      result: 'success',
    });
    onClose();
    onOpenFinalReward(reward.campaignCode);
  };

  const totalCredits = profileSummary?.totalCreditsRemaining ?? 0;
  const creditsUnavailable = !profileSummary && !summaryLoading;
  let creditsTrailingContent: React.ReactNode;
  if (profileSummary) {
    creditsTrailingContent = (
      <>
        {formatCredits(totalCredits)}
        <ChevronRightIcon className="h-3.5 w-3.5 text-secondary" />
      </>
    );
  } else if (summaryLoading) {
    creditsTrailingContent = (
      <ArrowPathIcon className="h-3.5 w-3.5 animate-spin text-secondary" />
    );
  } else {
    creditsTrailingContent = (
      <>
        <span className="text-secondary">--</span>
        <ArrowPathIcon className="h-3.5 w-3.5 text-secondary" />
      </>
    );
  }
  const creditItems = profileSummary?.creditItems ?? [];
  const hasCredits = creditItems.length > 0;
  const accountName = getAccountMenuDisplayName({
    fallback: i18nService.t('myAccount'),
    profileNickname: profileSummary?.nickname,
    userNickname: user?.nickname,
    userPhone: user?.phone,
  });
  const accountPlan = getAccountPlanPresentation(creditItems, isEn);
  const visibleAccountPlan = user?.accountMode === 'enterprise' ? null : accountPlan;
  const shouldShowPlanLearnAction = (
    user?.accountMode !== 'enterprise'
    && profileSummary !== null
    && visibleAccountPlan === null
  );
  const availableResetCount = profileSummary?.availableResetCount ?? 0;
  const availablePromoSubscriptionCount = profileSummary?.availablePromoSubscriptionCount ?? 0;
  const campaignActionLabel = availableResetCount > 0
    ? i18nService.t('authCreditsResetActionCount').replace('{count}', String(availableResetCount))
    : availablePromoSubscriptionCount > 0
      ? i18nService.t('authPromoSubscriptionAction')
      : null;
  const finalRewards = getFinalRewards(profileSummary?.creditsResetCampaign);

  return (
    <div className="absolute bottom-full left-[-0.5rem] z-50 mb-1 max-h-[calc(100vh-4rem)] w-[14.5rem] overflow-x-hidden overflow-y-auto rounded-xl border border-border bg-surface shadow-popover popover-enter">
      {/* Account info */}
      <div className="border-b border-border px-4 py-3">
        <div className="truncate text-sm font-medium text-foreground">
          {accountName}
        </div>
      </div>

      {/* Account destinations */}
      <div className="border-b border-border py-1">
        {visibleAccountPlan && (
          <AccountPlanAction
            label={visibleAccountPlan.label}
            expiresAt={visibleAccountPlan.expiresAt}
            canUpgrade={visibleAccountPlan.canUpgrade}
            onUpgrade={handleUpgradePlan}
          />
        )}
        {shouldShowPlanLearnAction && (
          <AccountPlanAction
            label={i18nService.t('planFree')}
            expiresAt={null}
            canUpgrade
            onUpgrade={handleUpgradePlan}
          />
        )}
        <DailyCheckInAccountMenuEntry
          enabled={startupCreditEntry.resolved
            && !startupCreditEntry.available}
          initialSnapshot={dailyCheckInSnapshot}
          loadOnMount={false}
          suppressed={!startupCreditEntry.resolved
            || startupCreditEntry.available}
        />
        <AccountMenuAction
          icon={<PointsStackIcon />}
          label={i18nService.t('authCreditsRemaining')}
          title={creditsUnavailable ? i18nService.t('authCreditsUnavailableRetry') : undefined}
          trailing={(
            <span className="ml-auto flex shrink-0 items-center gap-1 text-xs font-medium text-foreground">
              {creditsTrailingContent}
            </span>
          )}
          onClick={handleCreditsDetail}
        />
        <AccountMenuAction
          icon={<PortalMenuIcon src={usageOverviewIconUrl} darkInvert />}
          label={i18nService.t('authUsageOverview')}
          onClick={handleUsageOverview}
        />
        <AccountMenuAction
          icon={<PortalMenuIcon src={rechargeIconUrl} darkInvert />}
          label={i18nService.t('authGoRecharge')}
          onClick={handleRecharge}
        />
      </div>

      {/* Campaigns and invitations */}
      <div className="border-b border-border py-1">
        {campaignActionLabel && (
          <AccountMenuAction
            icon={<PortalMenuIcon src={promoSubscriptionIconUrl} darkInvert />}
            label={campaignActionLabel}
            onClick={handleCreditsResetActivity}
          />
        )}
        {finalRewards.map(reward => {
          const rewardText = getFinalRewardText(reward);
          return (
            <AccountMenuAction
              key={`${reward.campaignCode}:${reward.claimDeadline}`}
              icon={<PortalMenuIcon src={reward.presentation?.iconUrl || soccerBallIconUrl} darkInvert />}
              label={rewardText.actionText}
              onClick={() => handleFinalReward(reward)}
            />
          );
        })}
        <AccountMenuAction
          icon={<PortalMenuIcon src={inviteCreditsIconUrl} darkInvert />}
          label={i18nService.t('authInviteFriendsForCredits')}
          onClick={handleInvite}
        />
      </div>

      {/* Session action */}
      <div className="py-1">
        <AccountMenuAction
          icon={<PortalMenuIcon src={logoutIconUrl} darkInvert />}
          label={i18nService.t('authLogout')}
          onClick={handleLogout}
        />
      </div>
    </div>
  );
};

const formatRewardExpiry = (expiresAt: string): string => {
  const value = expiresAt.replace('T', ' ').slice(0, 19);
  return i18nService.getLanguage() === 'en' ? value : value.replace(/-/g, '/');
};

interface LoginButtonProps {
  contentLeftOffset?: number;
  loggedOutVariant?: 'default' | 'sidebarPromo';
}

const LoginButton: React.FC<LoginButtonProps> = ({
  contentLeftOffset = 0,
  loggedOutVariant = 'default',
}) => {
  const {
    accountGeneration,
    isLoggedIn,
    isLoading,
    ownerAccountKey,
    profileSummary,
    purchaseOffer,
    user,
  } = useSelector((state: RootState) => state.auth);
  const enterpriseAccountContext = useSelector(selectEnterpriseAccountContext);
  const startupCreditEntry = useStartupCreditCampaignEntry();
  const [showMenu, setShowMenu] = useState(false);
  const [menuOpening, setMenuOpening] = useState(false);
  const [menuStartupCreditEntry, setMenuStartupCreditEntry] = useState<StartupCreditCampaignEntry>(
    startupCreditEntry,
  );
  const [menuDailyCheckInSnapshot, setMenuDailyCheckInSnapshot] = useState<DailyCheckInSnapshot | null>(null);
  const [selectedFinalRewardCode, setSelectedFinalRewardCode] = useState<string | null>(null);
  const [finalRewardLoading, setFinalRewardLoading] = useState(false);
  const [dismissedOfferWindowKey, setDismissedOfferWindowKey] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuOpenRequestRef = useRef(0);
  const mountedRef = useRef(true);
  const authAccountScope = getDailyCheckInAuthScopeKey(ownerAccountKey, accountGeneration);
  const authAccountScopeRef = useRef(authAccountScope);
  const finalRewards = useMemo(
    () => getFinalRewards(profileSummary?.creditsResetCampaign),
    [profileSummary?.creditsResetCampaign],
  );
  const finalReward = finalRewards.find(
    reward => reward.campaignCode === selectedFinalRewardCode,
  );
  const finalRewardText = getFinalRewardText(finalReward);
  const finalRewardOpen = finalReward !== undefined;

  authAccountScopeRef.current = authAccountScope;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      menuOpenRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target;
      const isEnterpriseAccountFlyout = target instanceof Element
        && target.closest('[data-enterprise-account-flyout="true"]') !== null;
      if (
        containerRef.current
        && !containerRef.current.contains(target as Node)
        && !isEnterpriseAccountFlyout
      ) {
        setShowMenu(false);
      }
    };
    if (showMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showMenu]);

  useEffect(() => {
    if (!isLoggedIn || (selectedFinalRewardCode && !finalReward)) {
      setSelectedFinalRewardCode(null);
    }
  }, [finalReward, isLoggedIn, selectedFinalRewardCode]);

  useEffect(() => {
    if (!isLoggedIn) return;
    menuOpenRequestRef.current += 1;
    setMenuOpening(false);
    setShowMenu(false);
    setMenuDailyCheckInSnapshot(null);
  }, [authAccountScope, isLoggedIn]);

  useEffect(() => {
    if (isLoggedIn) return;
    menuOpenRequestRef.current += 1;
    setMenuOpening(false);
    setShowMenu(false);
    setMenuDailyCheckInSnapshot(null);
  }, [isLoggedIn]);

  if (isLoading) {
    return null;
  }

  const handleClick = async () => {
    if (isLoggedIn) {
      const creditItemCount = profileSummary?.creditItems?.length ?? 0;
      if (showMenu) {
        menuOpenRequestRef.current += 1;
        setMenuOpening(false);
        setShowMenu(false);
        reportAccountMenuAction('close_menu', {
          creditItemCount,
          hasCredits: creditItemCount > 0,
          isLoggedIn: true,
        });
        return;
      }
      if (menuOpening) return;

      const requestId = ++menuOpenRequestRef.current;
      const requestAccountScope = authAccountScope;
      const selectedStartupCreditEntry = startupCreditEntry;
      const shouldLoadDailyCheckIn = !enterpriseAccountContext
        && selectedStartupCreditEntry.resolved
        && !selectedStartupCreditEntry.available;
      setMenuOpening(true);
      setMenuStartupCreditEntry(selectedStartupCreditEntry);
      setMenuDailyCheckInSnapshot(null);
      reportAccountMenuAction('open_menu', {
        creditItemCount,
        hasCredits: creditItemCount > 0,
        isLoggedIn: true,
      });
      let dailyCheckInSnapshot: DailyCheckInSnapshot | null = null;
      try {
        if (shouldLoadDailyCheckIn) {
          const result = await loadDailyCheckInSnapshot();
          if (result.status === DailyCheckInLoadResultStatus.Ready) {
            dailyCheckInSnapshot = result.snapshot;
          } else if (result.status === DailyCheckInLoadResultStatus.Failed) {
            const message = `daily check-in preload failed before opening account menu code=${result.code ?? 'unknown'}`;
            console.warn(`[LoginButton] ${message}`);
            writeAccountMenuRendererLog('warn', message);
          }
        }
      } catch (error) {
        console.warn('[LoginButton] failed to preload daily check-in before opening account menu:', error);
        writeAccountMenuRendererLog(
          'warn',
          'failed to preload daily check-in before opening account menu',
        );
      } finally {
        if (
          mountedRef.current
          && menuOpenRequestRef.current === requestId
          && authAccountScopeRef.current === requestAccountScope
        ) {
          setMenuDailyCheckInSnapshot(dailyCheckInSnapshot);
          setShowMenu(true);
          setMenuOpening(false);
        }
      }
      return;
    }
    const loginVariant = useSidebarPromoLogin ? 'sidebar_promo' : 'default';
    writeAccountMenuRendererLog('debug', `login requested variant=${loginVariant}`);
    try {
      await authService.login();
      reportAccountMenuAction('login', {
        isLoggedIn: false,
        result: 'success',
      });
    } catch (error) {
      writeAccountMenuRendererLog('warn', `login request failed variant=${loginVariant}`);
      reportAccountMenuAction('login', {
        isLoggedIn: false,
        result: 'failed',
      });
      throw error;
    }
  };

  const closeFinalReward = () => {
    if (finalRewardLoading) return;
    setSelectedFinalRewardCode(null);
  };

  const claimFinalReward = async () => {
    if (!finalReward || finalRewardLoading) return;
    setFinalRewardLoading(true);
    try {
      const claimed = await authService.claimCreditsFinalReward(finalReward.campaignCode);
      setSelectedFinalRewardCode(null);
      window.dispatchEvent(new CustomEvent('app:showToast', {
        detail: i18nService.t('authFinalRewardClaimSuccess')
          .replace('{credits}', formatCredits(claimed.creditsGranted))
          .replace('{date}', formatRewardExpiry(claimed.expiresAt)),
      }));
    } catch (error) {
      await authService.fetchProfileSummary();
      window.dispatchEvent(new CustomEvent('app:showToast', {
        detail: error instanceof Error ? error.message : i18nService.t('authFinalRewardClaimFailed'),
      }));
    } finally {
      setFinalRewardLoading(false);
    }
  };

  const useSidebarPromoLogin = !isLoggedIn && loggedOutVariant === 'sidebarPromo';
  const offerWindowKey = purchaseOffer?.offerToken
    ? `${purchaseOffer.offerToken}:${purchaseOffer.windowCount ?? 1}`
    : null;

  return (
    <div ref={containerRef} className="relative">
      {isLoggedIn
        && !enterpriseAccountContext
        && purchaseOffer?.offerToken
        && offerWindowKey !== dismissedOfferWindowKey
        && (
          <LowCreditPurchaseOfferCard
            offer={purchaseOffer}
            onClose={() => setDismissedOfferWindowKey(offerWindowKey)}
          />
        )}
      <button
        type="button"
        onClick={handleClick}
        className={
          useSidebarPromoLogin
            ? 'sidebar-login-rainbow inline-flex h-7 w-[5.75rem] shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-md px-2.5 text-[13px] font-medium leading-none transition-[filter,transform]'
            : 'inline-flex h-7 items-center justify-start gap-2 rounded-md px-1.5 text-sm font-normal text-foreground/80 transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04] cursor-pointer'
        }
      >
        {isLoggedIn ? (
          <>
            {user?.avatarUrl ? (
              <img src={user.avatarUrl} alt="" className="h-4 w-4 shrink-0 rounded-full" />
            ) : (
              <UserAvatarIcon className="h-4 w-4 shrink-0" />
            )}
            <span className="truncate max-w-[80px]">{i18nService.t('myAccount')}</span>
          </>
        ) : (
          useSidebarPromoLogin ? (
            i18nService.t('sidebarLoginNow')
          ) : (
            <>
              <UserAvatarIcon className="h-4 w-4 shrink-0" />
              {i18nService.t('login')}
            </>
          )
        )}
      </button>
      {showMenu && isLoggedIn && (
        enterpriseAccountContext
          ? (
            <EnterpriseAccountMenu
              context={enterpriseAccountContext}
              onClose={() => setShowMenu(false)}
            />
          )
          : (
            <UserMenu
              dailyCheckInSnapshot={menuDailyCheckInSnapshot}
              onClose={() => setShowMenu(false)}
              onOpenFinalReward={setSelectedFinalRewardCode}
              startupCreditEntry={menuStartupCreditEntry}
            />
          )
      )}
      <CreditsFinalRewardModal
        open={finalRewardOpen}
        loading={finalRewardLoading}
        contentLeftOffset={contentLeftOffset}
        campaignCode={finalReward?.campaignCode}
        creditsText={finalRewardText.creditsText}
        title={finalRewardText.title}
        actionText={finalRewardText.actionText}
        posterUrl={finalReward?.presentation?.posterUrl}
        onClose={closeFinalReward}
        onClaim={() => void claimFinalReward()}
      />
    </div>
  );
};

export default LoginButton;
