import React, { useState, useRef, useEffect } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../store';
import { authService } from '../services/auth';
import { i18nService } from '../services/i18n';
import type { CreditItem } from '../store/slices/authSlice';

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

const UserMenu: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const user = useSelector((state: RootState) => state.auth.user);
  const profileSummary = useSelector((state: RootState) => state.auth.profileSummary);
  const [creditsExpanded, setCreditsExpanded] = useState(false);
  const isEn = i18nService.getLanguage() === 'en';

  useEffect(() => {
    authService.fetchProfileSummary();
  }, []);

  const handleLogout = async () => {
    await authService.logout();
    onClose();
  };

  const handleSubscribe = async () => {
    const { getPortalPricingUrl } = await import('../services/endpoints');
    await window.electron.shell.openExternal(getPortalPricingUrl());
  };

  const handleLearnMore = async () => {
    const { getPortalProfileUrl } = await import('../services/endpoints');
    await window.electron.shell.openExternal(getPortalProfileUrl());
  };

  const phoneSuffix = user?.phone ? user.phone.slice(-4) : '';

  const totalCredits = profileSummary?.totalCreditsRemaining ?? 0;
  const creditItems = profileSummary?.creditItems ?? [];
  const hasCredits = creditItems.length > 0;

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
          onClick={() => setCreditsExpanded(!creditsExpanded)}
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
            <button
              type="button"
              onClick={handleLearnMore}
              className="mt-2 text-xs text-primary hover:underline cursor-pointer"
            >
              {i18nService.t('authLearnMore')}
            </button>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="py-1">
        <button
          type="button"
          onClick={handleSubscribe}
          className="w-full px-4 py-2 text-left text-sm text-foreground hover:bg-surface-raised transition-colors cursor-pointer"
        >
          {i18nService.t('authValueAddedServices')}
        </button>
        <button
          type="button"
          onClick={handleLogout}
          className="w-full px-4 py-2 text-left text-sm text-red-500 hover:bg-surface-raised transition-colors cursor-pointer flex items-center gap-2"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          {i18nService.t('authLogout')}
        </button>
      </div>
    </div>
  );
};

const LoginButton: React.FC = () => {
  const { isLoggedIn, isLoading, user } = useSelector((state: RootState) => state.auth);
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
      setShowMenu(!showMenu);
    } else {
      await authService.login();
    }
  };

  const phoneSuffix = user?.phone ? user.phone.slice(-4) : '';

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={handleClick}
        className="inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium text-secondary hover:text-foreground hover:bg-surface-raised transition-colors cursor-pointer"
      >
        {isLoggedIn ? (
          <>
            {user?.avatarUrl ? (
              <img src={user.avatarUrl} alt="" className="h-4 w-4 rounded-full" />
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><circle cx="12" cy="8" r="5" /><path d="M20 21a8 8 0 0 0-16 0" /></svg>
            )}
            <span className="truncate max-w-[80px]">{user?.nickname || `****${phoneSuffix}`}</span>
          </>
        ) : (
          <>
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><circle cx="12" cy="8" r="5" /><path d="M20 21a8 8 0 0 0-16 0" /></svg>
            {i18nService.t('login')}
          </>
        )}
      </button>
      {showMenu && <UserMenu onClose={() => setShowMenu(false)} />}
    </div>
  );
};

export default LoginButton;
