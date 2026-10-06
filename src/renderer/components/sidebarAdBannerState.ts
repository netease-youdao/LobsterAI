import { localStore } from '../services/store';

export interface ClientBanner {
  id: number;
  placement?: string;
  activityDescription: string;
  linkUrl: string;
  imageUrl: string;
  imageWidth?: number;
  imageHeight?: number;
  minClientVersion?: string | null;
  onlineAt?: string;
  offlineAt?: string;
  updatedAt?: string;
}

export interface SidebarBannerDismissState {
  closedAt: number;
  dismissedBannerVersions: string[];
}

export const SIDEBAR_BANNER_PLACEMENT = 'desktop_sidebar';
const SIDEBAR_BANNER_DISMISS_STATE_VERSION = 'dismissed_versions_v2';

export const getSidebarBannerVersion = (banner: ClientBanner): string => (
  `${banner.id}:${banner.updatedAt ?? 'v1'}`
);

export const getSidebarBannerVersions = (
  banners: ClientBanner[],
): string[] => Array.from(new Set(
  banners.map(getSidebarBannerVersion),
));

export const getSidebarBannerDismissStateKey = (
  placement = SIDEBAR_BANNER_PLACEMENT,
): string => (
  `client_sidebar_banner.${placement}.${SIDEBAR_BANNER_DISMISS_STATE_VERSION}`
);

export const getLegacySidebarBannerStorageKey = (
  banners: ClientBanner[],
  placement = SIDEBAR_BANNER_PLACEMENT,
): string => (
  `client_sidebar_banner.${placement}.${
    [...getSidebarBannerVersions(banners)].sort().join('.') || 'empty'
  }`
);

const normalizeDismissState = (
  value: Partial<SidebarBannerDismissState> | null,
): SidebarBannerDismissState | null => {
  if (!value
      || typeof value.closedAt !== 'number'
      || !Array.isArray(value.dismissedBannerVersions)) {
    return null;
  }
  return {
    closedAt: value.closedAt,
    dismissedBannerVersions: Array.from(new Set(
      value.dismissedBannerVersions.filter(version => typeof version === 'string'),
    )),
  };
};

export const createSidebarBannerDismissState = (
  banners: ClientBanner[],
  previousState: SidebarBannerDismissState | null,
  closedAt = Date.now(),
): SidebarBannerDismissState => ({
  closedAt,
  dismissedBannerVersions: Array.from(new Set([
    ...(previousState?.dismissedBannerVersions ?? []),
    ...getSidebarBannerVersions(banners),
  ])),
});

export const shouldShowSidebarBanners = (
  banners: ClientBanner[],
  state: SidebarBannerDismissState | null,
): boolean => {
  if (banners.length === 0) return false;
  if (!state) return true;
  const dismissedVersions = new Set(state.dismissedBannerVersions);
  return getSidebarBannerVersions(banners).some(
    version => !dismissedVersions.has(version),
  );
};

export const readSidebarBannerDismissState = async (
  banners: ClientBanner[],
  placement = SIDEBAR_BANNER_PLACEMENT,
): Promise<SidebarBannerDismissState | null> => {
  const key = getSidebarBannerDismissStateKey(placement);
  const stored = normalizeDismissState(
    await localStore.getItem<Partial<SidebarBannerDismissState>>(key),
  );
  if (stored) return stored;
  if (banners.length === 0) return null;

  const legacyState = await localStore.getItem<Pick<
    SidebarBannerDismissState,
    'closedAt'
  >>(getLegacySidebarBannerStorageKey(banners, placement));
  if (!legacyState || typeof legacyState.closedAt !== 'number') {
    return null;
  }

  const migratedState = createSidebarBannerDismissState(
    banners,
    null,
    legacyState.closedAt,
  );
  try {
    await localStore.setItem<SidebarBannerDismissState>(key, migratedState);
  } catch {
    // The current session can still honor the legacy close state.
  }
  return migratedState;
};

export const saveSidebarBannerDismissState = async (
  state: SidebarBannerDismissState,
  placement = SIDEBAR_BANNER_PLACEMENT,
): Promise<void> => {
  await localStore.setItem<SidebarBannerDismissState>(
    getSidebarBannerDismissStateKey(placement),
    state,
  );
};
