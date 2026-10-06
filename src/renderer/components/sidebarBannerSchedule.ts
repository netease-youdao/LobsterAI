import { isClientVersionAtLeast } from '../../shared/clientVersion';
import { localStore } from '../services/store';
import {
  type ClientBanner,
  SIDEBAR_BANNER_PLACEMENT,
} from './sidebarAdBannerState';

export const SIDEBAR_BANNER_SCHEDULE_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
export const SIDEBAR_BANNER_BOUNDARY_BUFFER_MS = 1000;
export const SIDEBAR_BANNER_BOUNDARY_JITTER_MS = 2000;

const MAX_TIMER_DELAY_MS = 2_147_000_000;
const SCHEDULE_CACHE_VERSION = 'v2';

export interface ClientBannerSnapshot {
  serverTime: string;
  nextRefreshAt: string | null;
  clientVersion: string;
  banners: ClientBanner[];
}

export interface CachedBannerSchedule extends ClientBannerSnapshot {
  savedAtClientMs: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isNonEmptyString = (value: unknown): value is string => (
  typeof value === 'string' && value.trim().length > 0
);

export const parseUtcDateTime = (value: string | null | undefined): number => {
  if (!value) return Number.NaN;
  const normalized = /Z$|[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`;
  return Date.parse(normalized);
};

const normalizeBanner = (value: unknown): ClientBanner | null => {
  if (!isRecord(value)
      || typeof value.id !== 'number'
      || !isNonEmptyString(value.activityDescription)
      || !isNonEmptyString(value.linkUrl)
      || !isNonEmptyString(value.imageUrl)
      || (value.minClientVersion !== null
        && value.minClientVersion !== undefined
        && typeof value.minClientVersion !== 'string')) {
    return null;
  }
  return value as unknown as ClientBanner;
};

const isBannerCompatible = (
  banner: ClientBanner,
  clientVersion: string,
): boolean => {
  const minimumVersion = banner.minClientVersion?.trim();
  return !minimumVersion
    || isClientVersionAtLeast(clientVersion, minimumVersion);
};

export const getSidebarBannerScheduleCacheKey = (
  placement = SIDEBAR_BANNER_PLACEMENT,
): string => `client_sidebar_banner.schedule.${placement}.${SCHEDULE_CACHE_VERSION}`;

export const createCachedBannerSchedule = (
  snapshot: ClientBannerSnapshot,
  savedAtClientMs = Date.now(),
): CachedBannerSchedule | null => {
  if (!Number.isFinite(savedAtClientMs)
      || !Number.isFinite(parseUtcDateTime(snapshot.serverTime))
      || !isNonEmptyString(snapshot.clientVersion)
      || (snapshot.nextRefreshAt !== null
        && !Number.isFinite(parseUtcDateTime(snapshot.nextRefreshAt)))) {
    return null;
  }
  return {
    serverTime: snapshot.serverTime,
    savedAtClientMs,
    nextRefreshAt: snapshot.nextRefreshAt,
    clientVersion: snapshot.clientVersion,
    banners: snapshot.banners.map(normalizeBanner).filter(
      (banner): banner is ClientBanner => banner !== null,
    ).filter(banner => isBannerCompatible(banner, snapshot.clientVersion)),
  };
};

const normalizeCachedSchedule = (
  value: unknown,
  clientVersion: string,
): CachedBannerSchedule | null => {
  if (!isRecord(value)
      || !isNonEmptyString(value.serverTime)
      || !isNonEmptyString(value.clientVersion)
      || typeof value.savedAtClientMs !== 'number'
      || !Array.isArray(value.banners)
      || (value.nextRefreshAt !== null && typeof value.nextRefreshAt !== 'string')) {
    return null;
  }
  return createCachedBannerSchedule({
    serverTime: value.serverTime,
    nextRefreshAt: value.nextRefreshAt as string | null,
    clientVersion,
    banners: value.banners.map(normalizeBanner).filter(
      (banner): banner is ClientBanner => banner !== null,
    ),
  }, value.savedAtClientMs);
};

export const isCachedBannerScheduleFresh = (
  schedule: CachedBannerSchedule,
  clientNow = Date.now(),
): boolean => {
  const age = clientNow - schedule.savedAtClientMs;
  return Number.isFinite(age)
    && age >= 0
    && age < SIDEBAR_BANNER_SCHEDULE_CACHE_MAX_AGE_MS;
};

export const getEstimatedServerTime = (
  schedule: CachedBannerSchedule,
  clientNow = Date.now(),
): number => {
  if (!isCachedBannerScheduleFresh(schedule, clientNow)) return Number.NaN;
  return parseUtcDateTime(schedule.serverTime)
    + (clientNow - schedule.savedAtClientMs);
};

export const getActiveCachedBanners = (
  schedule: CachedBannerSchedule,
  clientNow = Date.now(),
): ClientBanner[] => {
  const serverNow = getEstimatedServerTime(schedule, clientNow);
  if (!Number.isFinite(serverNow)) return [];
  return schedule.banners.filter(banner => {
    const onlineAt = parseUtcDateTime(banner.onlineAt);
    const offlineAt = parseUtcDateTime(banner.offlineAt);
    const started = !Number.isFinite(onlineAt) || onlineAt <= serverNow;
    const notEnded = !Number.isFinite(offlineAt) || serverNow < offlineAt;
    return started && notEnded;
  });
};

export const getNextBannerScheduleEventDelay = (
  schedule: CachedBannerSchedule,
  clientNow = Date.now(),
  boundaryJitterMs = 0,
): number => {
  if (!isCachedBannerScheduleFresh(schedule, clientNow)) return 0;
  const serverNow = getEstimatedServerTime(schedule, clientNow);
  const delays = [
    SIDEBAR_BANNER_SCHEDULE_CACHE_MAX_AGE_MS
      - (clientNow - schedule.savedAtClientMs),
  ];

  for (const banner of schedule.banners) {
    const offlineAt = parseUtcDateTime(banner.offlineAt);
    if (Number.isFinite(offlineAt)) delays.push(Math.max(0, offlineAt - serverNow));
  }

  const nextRefreshAt = parseUtcDateTime(schedule.nextRefreshAt);
  if (Number.isFinite(nextRefreshAt)) {
    delays.push(Math.max(0, nextRefreshAt - serverNow) + Math.max(0, boundaryJitterMs));
  }

  return Math.min(MAX_TIMER_DELAY_MS, Math.max(0, Math.min(...delays)));
};

export const expireCachedBannerSchedule = (
  schedule: CachedBannerSchedule,
  clientNow = Date.now(),
): CachedBannerSchedule => ({
  ...schedule,
  nextRefreshAt: null,
  banners: getActiveCachedBanners(schedule, clientNow),
});

export const readCachedBannerSchedule = async (
  placement = SIDEBAR_BANNER_PLACEMENT,
  clientNow = Date.now(),
  clientVersion: string,
): Promise<CachedBannerSchedule | null> => {
  const key = getSidebarBannerScheduleCacheKey(placement);
  const schedule = normalizeCachedSchedule(
    await localStore.getItem<unknown>(key),
    clientVersion,
  );
  if (schedule && isCachedBannerScheduleFresh(schedule, clientNow)) return schedule;
  if (schedule) await localStore.removeItem(key).catch(() => undefined);
  return null;
};

export const saveCachedBannerSchedule = async (
  schedule: CachedBannerSchedule,
  placement = SIDEBAR_BANNER_PLACEMENT,
): Promise<void> => {
  await localStore.setItem(getSidebarBannerScheduleCacheKey(placement), schedule);
};

export const clearCachedBannerSchedule = async (
  placement = SIDEBAR_BANNER_PLACEMENT,
): Promise<void> => {
  await localStore.removeItem(getSidebarBannerScheduleCacheKey(placement));
};
