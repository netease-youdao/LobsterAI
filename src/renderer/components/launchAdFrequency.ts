import {
  ClientBannerDisplayFrequency,
} from '../../shared/clientBanner/constants';
import type { ClientBanner } from './sidebarAdBannerState';
import { getSidebarBannerVersion } from './sidebarAdBannerState';

export const LAUNCH_AD_STATE_KEY = 'client_launch_ad.state.v1';
/** Stop pop-up attempts that would land long after the user started working. */
export const LAUNCH_AD_MAX_DELAY_MS = 10_000;
const MAX_TRACKED_VERSIONS = 50;
/** Launch-modal width bounds; the server validates the same range when Admin saves a banner. */
export const LAUNCH_AD_DEFAULT_WIDTH = 400;
export const LAUNCH_AD_MIN_WIDTH = 320;
export const LAUNCH_AD_MAX_WIDTH = 960;

/** Width the launch modal should use for a banner; unknown or out-of-range values fall back to the default. */
export const resolveLaunchAdWidth = (banner: Pick<ClientBanner, 'modalWidth'>): number => {
  const width = banner.modalWidth;
  if (typeof width !== 'number' || !Number.isFinite(width)) return LAUNCH_AD_DEFAULT_WIDTH;
  if (width < LAUNCH_AD_MIN_WIDTH || width > LAUNCH_AD_MAX_WIDTH) return LAUNCH_AD_DEFAULT_WIDTH;
  return Math.round(width);
};

export interface LaunchAdVersionState {
  lastShownAt?: number;
  dismissedAt?: number;
}

export interface LaunchAdState {
  versions: Record<string, LaunchAdVersionState>;
}

export const emptyLaunchAdState = (): LaunchAdState => ({ versions: {} });

export const normalizeLaunchAdState = (value: unknown): LaunchAdState => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyLaunchAdState();
  const versions = (value as { versions?: unknown }).versions;
  if (!versions || typeof versions !== 'object' || Array.isArray(versions)) return emptyLaunchAdState();
  const normalized: Record<string, LaunchAdVersionState> = {};
  for (const [version, entry] of Object.entries(versions as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    const { lastShownAt, dismissedAt } = entry as LaunchAdVersionState;
    normalized[version] = {
      ...(typeof lastShownAt === 'number' ? { lastShownAt } : {}),
      ...(typeof dismissedAt === 'number' ? { dismissedAt } : {}),
    };
  }
  return { versions: normalized };
};

const isSameLocalDay = (a: number, b: number): boolean => {
  const left = new Date(a);
  const right = new Date(b);
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
};

/**
 * The modal opens at most once per app session (enforced by the caller); these
 * rules decide whether this launch qualifies for a banner.
 */
export const isLaunchAdEligible = (
  banner: ClientBanner,
  state: LaunchAdState,
  now = Date.now(),
): boolean => {
  const entry = state.versions[getSidebarBannerVersion(banner)];
  switch (banner.displayFrequency) {
    case ClientBannerDisplayFrequency.EveryLaunch:
      return true;
    case ClientBannerDisplayFrequency.Once:
      return entry?.dismissedAt === undefined;
    case ClientBannerDisplayFrequency.Daily:
    default:
      return entry?.lastShownAt === undefined || !isSameLocalDay(entry.lastShownAt, now);
  }
};

export const pickLaunchAd = (
  banners: ClientBanner[],
  state: LaunchAdState,
  now = Date.now(),
  random: () => number = Math.random,
): ClientBanner | null => {
  const eligible = banners.filter(banner => isLaunchAdEligible(banner, state, now));
  if (eligible.length === 0) return null;
  const weights = eligible.map(banner => Math.max(0, banner.weight ?? 1));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return eligible[0];
  let cursor = random() * total;
  for (let index = 0; index < eligible.length; index += 1) {
    cursor -= weights[index];
    if (cursor < 0) return eligible[index];
  }
  return eligible[eligible.length - 1];
};

const pruneVersions = (
  versions: Record<string, LaunchAdVersionState>,
): Record<string, LaunchAdVersionState> => {
  const entries = Object.entries(versions);
  if (entries.length <= MAX_TRACKED_VERSIONS) return versions;
  const latest = (entry: LaunchAdVersionState) => Math.max(entry.lastShownAt ?? 0, entry.dismissedAt ?? 0);
  return Object.fromEntries(
    entries.sort(([, a], [, b]) => latest(b) - latest(a)).slice(0, MAX_TRACKED_VERSIONS),
  );
};

export const markLaunchAdShown = (
  state: LaunchAdState,
  banner: ClientBanner,
  now = Date.now(),
): LaunchAdState => {
  const version = getSidebarBannerVersion(banner);
  return {
    versions: pruneVersions({
      ...state.versions,
      [version]: { ...state.versions[version], lastShownAt: now },
    }),
  };
};

export const markLaunchAdDismissed = (
  state: LaunchAdState,
  banner: ClientBanner,
  now = Date.now(),
): LaunchAdState => {
  const version = getSidebarBannerVersion(banner);
  return {
    versions: pruneVersions({
      ...state.versions,
      [version]: { ...state.versions[version], dismissedAt: now },
    }),
  };
};
