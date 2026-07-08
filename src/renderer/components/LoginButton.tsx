import React, { useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import inviteCreditsIconUrl from '../assets/icons/invite-credits.svg';
import logoutIconUrl from '../assets/icons/logout.svg';
import promoSubscriptionIconUrl from '../assets/icons/promo-subscription.svg';
import rechargeIconUrl from '../assets/icons/recharge.svg';
import usageOverviewIconUrl from '../assets/icons/usage-overview.svg';
import { authService } from '../services/auth';
import {
  getPortalCreditsResetActivityUrl,
  getPortalInvitationUrl,
  getPortalProfileUrl,
  getPortalRechargeUrl,
} from '../services/endpoints';
import { i18nService } from '../services/i18n';
import { LogReporterAction, reportYdAnalyzer } from '../services/logReporter';
import { RootState } from '../store';
import type { CreditItem } from '../store/slices/authSlice';
import UserAvatarIcon from './icons/UserAvatarIcon';

const ACCOUNT_MENU_ANALYTICS_SOURCE = 'home_account_menu';

const reportAccountMenuAction = (
  actionType: string,
  options: {
    creditItemCount?: number;
    hasCredits?: boolean;
    isLoggedIn?: boolean;
    result?: 'success' | 'failed';
  } = {},
): void => {
  console.debug('[LoginButton] reporting account menu analytics');
  void reportYdAnalyzer({
    action: LogReporterAction.AccountMenuAction,
    source: ACCOUNT_MENU_ANALYTICS_SOURCE,
    actionType,
    result: options.result,
    isLoggedIn: options.isLoggedIn ?? true,
    hasCredits: options.hasCredits,
    creditItemCount: options.creditItemCount,
  });
};

const getSubscriptionBadge = (label: string) => {
  // Determine badge style based on label
  const isStandard = /标准|Standard/i.test(label);
  const isAdvanced = /进阶|Advanced/i.test(label);
  const isPro = /专业|Pro/i.test(label);

  if (isPro) {
    return {
      bg: 'bg-gradient-to-r from-amber-500 to-yellow-400',
      text: 'text-white',
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="currentColor" className="shrink-0">
          <path d="M2 4l3 12h14l3-12-5 4-5-6-5 6z" /><path d="M5 16l-1.5 4h17L19 16" />
        </svg>
      ),
    };
  }
  if (isAdvanced) {
    return {
      bg: 'bg-gradient-to-r from-purple-500 to-violet-400',
      text: 'text-white',
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
      ),
    };
  }
  if (isStandard) {
    return {
      bg: 'bg-gradient-to-r from-blue-500 to-cyan-400',
      text: 'text-white',
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="currentColor" className="shrink-0">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      ),
    };
  }

  return null;
};

const formatDate = (dateStr: string | null): string => {
  if (!dateStr) return '';
  // Format "2026-03-29" to "26.03.29"
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  return `${parts[0].slice(2)}.${parts[1]}.${parts[2]}`;
};

const formatCredits = (n: number): string => {
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(2);
};

const CreditItemRow: React.FC<{ item: CreditItem; isEn: boolean }> = ({ item, isEn }) => {
  const label = isEn ? item.labelEn : item.label;
  const badge = item.type === 'subscription' ? getSubscriptionBadge(label) : null;
  const expiresText = item.expiresAt
    ? `${i18nService.t('authExpiresAt')}${formatDate(item.expiresAt)}`
    : '';

  return (
    <div className="flex flex-col gap-0.5 py-1.5 first:pt-0 last:pb-0">
      <div className="flex items-center gap-1.5">
        {badge ? (
          <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium ${badge.bg} ${badge.text}`}>
            {badge.icon}
            {label}
          </span>
        ) : (
          <span className="text-xs text-secondary">
            {label}
          </span>
        )}
        <span className="text-xs font-medium text-foreground">
          {formatCredits(item.creditsRemaining)}{i18nService.t('authCreditsUnit')}
        </span>
      </div>
      {expiresText && (
        <span className="text-[10px] text-secondary pl-0.5">
          {expiresText}
        </span>
      )}
    </div>
  );
};

interface AccountMenuActionProps {
  icon: React.ReactNode;
  label: string;
  onClick: () => void | Promise<void>;
  danger?: boolean;
}

const AccountMenuAction: React.FC<AccountMenuActionProps> = ({
  icon,
  label,
  onClick,
  danger = false,
}) => (
  <button
    type="button"
    onClick={() => void onClick()}
    className={`w-full px-4 py-2 text-left text-sm hover:bg-surface-raised transition-colors cursor-pointer flex items-center gap-2 ${
      danger ? 'text-red-500' : 'text-foreground'
    }`}
  >
    {icon}
    <span>{label}</span>
  </button>
);

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

const UserMenu: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const user = useSelector((state: RootState) => state.auth.user);
  const profileSummary = useSelector((state: RootState) => state.auth.profileSummary);
  const [creditsExpanded, setCreditsExpanded] = useState(false);
  const isEn = i18nService.getLanguage() === 'en';

  useEffect(() => {
    authService.fetchProfileSummary();
  }, []);

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
    try {
      await openPortalUrl(getPortalRechargeUrl());
      reportAccountMenuAction('open_recharge', {
        creditItemCount: creditItems.length,
        hasCredits,
        result: 'success',
      });
    } catch (error) {
      reportAccountMenuAction('open_recharge', {
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

  const phoneSuffix = user?.phone ? user.phone.slice(-4) : '';

  const totalCredits = profileSummary?.totalCreditsRemaining ?? 0;
  const creditItems = profileSummary?.creditItems ?? [];
  const hasCredits = creditItems.length > 0;
  const availableResetCount = profileSummary?.availableResetCount ?? 0;
  const availablePromoSubscriptionCount = profileSummary?.availablePromoSubscriptionCount ?? 0;
  const campaignActionLabel = availableResetCount > 0
    ? i18nService.t('authCreditsResetAction')
    : availablePromoSubscriptionCount > 0
      ? i18nService.t('authPromoSubscriptionAction')
      : null;

  return (
    <div className="absolute bottom-full left-[-0.5rem] mb-1 w-[14.5rem] bg-surface rounded-xl shadow-popover border border-border overflow-hidden z-50 popover-enter">
      {/* Account info */}
      <div className="px-4 py-3 border-b border-border">
        <div className="text-sm font-medium text-foreground truncate">
          {user?.nickname || phoneSuffix}
        </div>
        {phoneSuffix && (
          <div className="text-xs text-secondary mt-0.5">
            ****{phoneSuffix}
          </div>
        )}
      </div>

      {/* Credits section - collapsible */}
      <div className="border-b border-border">
        <button
          type="button"
          onClick={() => {
            const nextExpanded = !creditsExpanded;
            setCreditsExpanded(nextExpanded);
            reportAccountMenuAction(nextExpanded ? 'expand_credits' : 'collapse_credits', {
              creditItemCount: creditItems.length,
              hasCredits,
            });
          }}
          className="w-full px-4 py-2.5 flex items-center justify-between cursor-pointer hover:bg-surface-raised transition-colors"
        >
          <span className="text-xs text-secondary">
            {i18nService.t('authCreditsRemaining')}
          </span>
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium text-foreground">
              {formatCredits(totalCredits)}{i18nService.t('authCreditsUnit')}
            </span>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`text-secondary transition-transform duration-200 ${creditsExpanded ? 'rotate-180' : ''}`}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </div>
        </button>

        {/* Expanded credit details */}
        {creditsExpanded && (
          <div className="px-4 pb-3">
            {hasCredits ? (
              <div className="divide-y divide-border">
                {creditItems.map((item, idx) => (
                  <CreditItemRow key={idx} item={item} isEn={isEn} />
                ))}
              </div>
            ) : (
              <div className="text-xs text-secondary py-1">
                {i18nService.t('authZeroCredits')}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="py-1">
        {campaignActionLabel && (
          <AccountMenuAction
            icon={<PortalMenuIcon src={promoSubscriptionIconUrl} darkInvert />}
            label={campaignActionLabel}
            onClick={handleCreditsResetActivity}
          />
        )}
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
        <AccountMenuAction
          icon={<PortalMenuIcon src={inviteCreditsIconUrl} darkInvert />}
          label={i18nService.t('authInviteFriendsForCredits')}
          onClick={handleInvite}
        />
        <AccountMenuAction
          icon={<PortalMenuIcon src={logoutIconUrl} darkInvert />}
          label={i18nService.t('authLogout')}
          onClick={handleLogout}
        />
      </div>
    </div>
  );
};

const LoginButton: React.FC = () => {
  const { isLoggedIn, isLoading, profileSummary, user } = useSelector((state: RootState) => state.auth);
  const [showMenu, setShowMenu] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
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

  if (isLoading) {
    return null;
  }

  const handleClick = async () => {
    if (isLoggedIn) {
      const nextShowMenu = !showMenu;
      setShowMenu(nextShowMenu);
      const creditItemCount = profileSummary?.creditItems?.length ?? 0;
      reportAccountMenuAction(nextShowMenu ? 'open_menu' : 'close_menu', {
        creditItemCount,
        hasCredits: creditItemCount > 0,
        isLoggedIn: true,
      });
      return;
    }
    try {
      await authService.login();
      reportAccountMenuAction('login', {
        isLoggedIn: false,
        result: 'success',
      });
    } catch (error) {
      reportAccountMenuAction('login', {
        isLoggedIn: false,
        result: 'failed',
      });
      throw error;
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={handleClick}
        className="inline-flex h-7 items-center justify-start gap-2 rounded-md px-1.5 text-[14px] font-normal text-foreground/80 transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04] cursor-pointer"
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
          <>
            <UserAvatarIcon className="h-4 w-4 shrink-0" />
            {i18nService.t('login')}
          </>
        )}
      </button>
      {showMenu && isLoggedIn && <UserMenu onClose={() => setShowMenu(false)} />}
    </div>
  );
};

export default LoginButton;
