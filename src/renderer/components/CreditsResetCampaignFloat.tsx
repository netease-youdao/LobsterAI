import React, { useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';

import { getPortalCreditsResetActivityUrl } from '../services/endpoints';
import { i18nService } from '../services/i18n';
import { RootState } from '../store';

type CampaignKind = 'reset' | 'promo';

interface CampaignCandidate {
  kind: CampaignKind;
  campaignCode?: string;
  expiresAt?: string;
  storageKey: string;
}

const todayKey = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

const storageKeyFor = (userKey: string, kind: CampaignKind, campaignCode?: string) => (
  `credits_reset_campaign_manual_dismissed.${userKey}.${kind}.${campaignCode ?? 'legacy'}.${todayKey()}`
);

const formatExpiry = (expiresAt?: string): string => {
  if (!expiresAt) return '';
  const datePart = expiresAt.split('T')[0];
  if (!datePart) return expiresAt;
  const [year, month, day] = datePart.split('-');
  if (!year || !month || !day) return datePart;
  return i18nService.getLanguage() === 'en'
    ? `${year}-${month}-${day}`
    : `${Number(month)}月${Number(day)}日`;
};

const CreditsResetCampaignFloat: React.FC = () => {
  const user = useSelector((state: RootState) => state.auth.user);
  const profileSummary = useSelector((state: RootState) => state.auth.profileSummary);
  const [, forceLanguageRefresh] = useState(0);
  const [dismissedKeys, setDismissedKeys] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const unsubscribe = i18nService.subscribe(() => {
      forceLanguageRefresh((prev) => prev + 1);
    });
    return unsubscribe;
  }, []);

  const userKey = profileSummary?.id?.toString()
    ?? user?.id?.toString()
    ?? user?.userId
    ?? user?.yid
    ?? 'anonymous';

  const candidates = useMemo<CampaignCandidate[]>(() => {
    const status = profileSummary?.creditsResetCampaign;
    if (!status) return [];
    const entitlements = status.resetEntitlements?.length
      ? [...status.resetEntitlements].sort((a, b) => a.expiresAt.localeCompare(b.expiresAt))
      : (profileSummary.availableResetCount ?? 0) > 0
        ? [{ campaignCode: status.campaignCode, expiresAt: status.endAt }]
        : [];
    if (entitlements.length > 0) {
      return entitlements.map((entitlement) => ({
        kind: 'reset' as const,
        campaignCode: entitlement.campaignCode,
        expiresAt: entitlement.expiresAt,
        storageKey: storageKeyFor(userKey, 'reset', entitlement.campaignCode),
      }));
    }
    if ((profileSummary.availablePromoSubscriptionCount ?? 0) > 0) {
      return [{
        kind: 'promo',
        storageKey: storageKeyFor(userKey, 'promo', status.campaignCode),
      }];
    }
    return [];
  }, [profileSummary, userKey]);

  const candidateKey = candidates.map((candidate) => candidate.storageKey).join('|');

  useEffect(() => {
    const keys = candidateKey ? candidateKey.split('|') : [];
    setDismissedKeys(new Set(keys.filter((key) => localStorage.getItem(key) === '1')));
  }, [candidateKey]);

  const candidate = candidates.find((item) => !dismissedKeys.has(item.storageKey));
  if (!candidate) return null;

  const dismissToday = () => {
    localStorage.setItem(candidate.storageKey, '1');
    setDismissedKeys((current) => new Set(current).add(candidate.storageKey));
  };

  const openActivity = async () => {
    await window.electron.shell.openExternal(
      getPortalCreditsResetActivityUrl(candidate.kind === 'reset' ? candidate.campaignCode : undefined),
    );
  };

  const title = i18nService.t(candidate.kind === 'reset'
    ? 'authCreditsResetFloatTitle'
    : 'authPromoSubscriptionFloatTitle');
  const desc = candidate.kind === 'reset'
    ? i18nService.t('authCreditsResetFloatDescWithExpiry').replace('{date}', formatExpiry(candidate.expiresAt))
    : i18nService.t('authPromoSubscriptionFloatDesc');
  const action = i18nService.t(candidate.kind === 'reset'
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
