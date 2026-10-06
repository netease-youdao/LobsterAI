import { useEffect, useMemo, useState } from 'react';

import { i18nService } from '@/services/i18n';

const MINUTE_MS = 60_000;
const MAX_REFRESH_MS = 30_000;

export interface PublishingTrialStatusState {
  isTrial: boolean;
  isExpired: boolean;
  label?: string;
}

export const parsePublishingAccessExpiry = (
  accessExpiresAt?: string | null,
): number | undefined => {
  if (!accessExpiresAt?.trim()) return undefined;
  const value = Date.parse(accessExpiresAt);
  return Number.isFinite(value) ? value : undefined;
};

export const getPublishingRemainingMinutes = (remainingMs: number): number => (
  // The expiry comes from the server clock. Minute-level rounding prevents a
  // sub-minute clock difference from displaying a two-hour TTL as 2h 1m.
  Math.max(1, Math.round(remainingMs / MINUTE_MS))
);

export const formatPublishingTrialExpiry = (
  accessExpiresAt: number,
  now: number,
): string => {
  if (accessExpiresAt <= now) {
    return i18nService.t('publishingTrialLinkExpired');
  }
  const remainingMs = accessExpiresAt - now;
  if (remainingMs < MINUTE_MS) {
    return i18nService.t('publishingTrialLinkExpiryLessThanMinute');
  }
  const remainingMinutes = getPublishingRemainingMinutes(remainingMs);
  const hours = Math.floor(remainingMinutes / 60);
  const minutes = remainingMinutes % 60;
  if (hours > 0 && minutes === 0) {
    return i18nService.t('publishingTrialLinkExpiryHours')
      .replace('{hours}', String(hours));
  }
  if (hours > 0) {
    return i18nService.t('publishingTrialLinkExpiryHoursMinutes')
      .replace('{hours}', String(hours))
      .replace('{minutes}', String(minutes));
  }
  return i18nService.t('publishingTrialLinkExpiryMinutes')
    .replace('{minutes}', String(minutes));
};

export const usePublishingTrialStatus = (
  accessExpiresAt?: string | null,
): PublishingTrialStatusState => {
  const expiresAt = useMemo(
    () => parsePublishingAccessExpiry(accessExpiresAt),
    [accessExpiresAt],
  );
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (expiresAt === undefined) return undefined;
    let timer: number | undefined;
    const refresh = (): void => {
      if (timer !== undefined) window.clearTimeout(timer);
      const current = Date.now();
      setNow(current);
      const expiryDelay = expiresAt > current
        ? Math.max(250, expiresAt - current + 50)
        : MAX_REFRESH_MS;
      timer = window.setTimeout(refresh, Math.min(MAX_REFRESH_MS, expiryDelay));
    };
    const handleVisibilityChange = (): void => {
      if (!document.hidden) refresh();
    };
    refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [expiresAt]);

  if (expiresAt === undefined) {
    return { isTrial: false, isExpired: false };
  }
  // accessExpiresAt can arrive after an asynchronous create/update operation.
  // Do not render one frame with the time captured when the dialog first opened.
  const currentNow = Math.max(now, Date.now());
  return {
    isTrial: true,
    isExpired: expiresAt <= currentNow,
    label: formatPublishingTrialExpiry(expiresAt, currentNow),
  };
};

interface PublishingTrialStatusProps {
  status: PublishingTrialStatusState;
}

export const PublishingTrialStatus = ({ status }: PublishingTrialStatusProps) => {
  if (!status.isTrial) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <span className="rounded-md bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-600 dark:bg-orange-500/15 dark:text-orange-300">
        {i18nService.t('publishingTrialBadge')}
      </span>
      <span className={`text-xs font-medium ${
        status.isExpired ? 'text-red-500' : 'text-orange-500 dark:text-orange-300'
      }`}>
        {status.label}
      </span>
    </div>
  );
};
