import { AuthSubscriptionStatus } from '@shared/auth/constants';
import React, { useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';

import { getPortalCreditsResetActivityUrl } from '../services/endpoints';
import { i18nService } from '../services/i18n';
import { RootState } from '../store';

type CampaignKind = 'reset' | 'promo';

const todayKey = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

const storageKeyFor = (userKey: string, kind: CampaignKind) => (
  `credits_reset_campaign_manual_dismissed.${userKey}.${kind}.${todayKey()}`
);

const CreditsResetCampaignFloat: React.FC = () => {
  const user = useSelector((state: RootState) => state.auth.user);
  const quota = useSelector((state: RootState) => state.auth.quota);
  const profileSummary = useSelector((state: RootState) => state.auth.profileSummary);
  const [, forceLanguageRefresh] = useState(0);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = i18nService.subscribe(() => {
      forceLanguageRefresh((prev) => prev + 1);
    });
    return unsubscribe;
  }, []);

  const campaignKind = useMemo<CampaignKind | null>(() => {
    if (!profileSummary) return null;
    if (profileSummary.creditsResetCampaign?.active === false) return null;
    if ((profileSummary.availableResetCount ?? 0) > 0) return 'reset';
    if (quota?.subscriptionStatus === AuthSubscriptionStatus.Active) return null;
    if ((profileSummary.availablePromoSubscriptionCount ?? 0) > 0) return 'promo';
    return null;
  }, [profileSummary, quota?.subscriptionStatus]);

  const userKey = profileSummary?.id?.toString()
    ?? user?.id?.toString()
    ?? user?.userId
    ?? user?.yid
    ?? 'anonymous';

  const currentStorageKey = campaignKind ? storageKeyFor(userKey, campaignKind) : null;

  useEffect(() => {
    if (!currentStorageKey) {
      setDismissedKey(null);
      return;
    }
    setDismissedKey(localStorage.getItem(currentStorageKey) === '1' ? currentStorageKey : null);
  }, [currentStorageKey]);

  if (!campaignKind || !currentStorageKey || dismissedKey === currentStorageKey) {
    return null;
  }

  const dismissToday = () => {
    localStorage.setItem(currentStorageKey, '1');
    setDismissedKey(currentStorageKey);
  };

  const openActivity = async () => {
    await window.electron.shell.openExternal(getPortalCreditsResetActivityUrl());
  };

  const title = i18nService.t(campaignKind === 'reset'
    ? 'authCreditsResetFloatTitle'
    : 'authPromoSubscriptionFloatTitle');
  const desc = i18nService.t(campaignKind === 'reset'
    ? 'authCreditsResetFloatDesc'
    : 'authPromoSubscriptionFloatDesc');
  const action = i18nService.t(campaignKind === 'reset'
    ? 'authCreditsResetFloatAction'
    : 'authPromoSubscriptionFloatAction');

  return (
    <div className="relative z-20 mt-16 inline-flex max-w-[calc(100vw-2rem)] items-center gap-8 rounded-lg border border-border bg-surface py-4 pl-5 pr-14 shadow-popover">
      <button
        type="button"
        aria-label={i18nService.t('close')}
        onClick={dismissToday}
        className="absolute right-2 top-2 text-secondary hover:text-foreground transition-colors cursor-pointer"
      >
        ×
      </button>
      <div className="min-w-0">
        <div className="whitespace-nowrap text-sm font-semibold text-foreground">{title}</div>
        <div className="mt-1 whitespace-nowrap text-xs leading-5 text-secondary">{desc}</div>
      </div>
      <button
        type="button"
        onClick={() => void openActivity()}
        className="h-7 shrink-0 rounded-full bg-foreground px-4 text-xs font-medium text-background transition-opacity hover:opacity-85 cursor-pointer"
      >
        {action}
      </button>
    </div>
  );
};

export default CreditsResetCampaignFloat;
