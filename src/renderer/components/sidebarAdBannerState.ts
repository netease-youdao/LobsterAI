import { localStore } from '../services/store';

export interface ClientBanner {
  id: number;
  placement?: string;
  activityDescription: string;
  linkUrl: string;
  imageUrl: string;
  imageWidth?: number;
  imageHeight?: number;
  updatedAt?: string;
}

export interface SidebarBannerDismissState {
  closedAt: number;
}

export const SIDEBAR_BANNER_PLACEMENT = 'desktop_sidebar';

export const getSidebarBannerStorageKey = (
  banners: ClientBanner[],
  placement = SIDEBAR_BANNER_PLACEMENT,
) => {
  const version = banners
    .map((banner) => `${banner.id}:${banner.updatedAt ?? 'v1'}`)
    .sort()
    .join('.');

  return `client_sidebar_banner.${placement}.${version || 'empty'}`;
};

export const shouldShowSidebarBanner = (state: SidebarBannerDismissState | null) => !state;

export const readSidebarBannerDismissState = async (
  key: string,
): Promise<SidebarBannerDismissState | null> => {
  const stored = await localStore.getItem<Partial<SidebarBannerDismissState>>(key);
  if (!stored || typeof stored.closedAt !== 'number') {
    return null;
  }
  return { closedAt: stored.closedAt };
};

export const saveSidebarBannerDismissState = async (
  key: string,
  closedAt = Date.now(),
): Promise<void> => {
  await localStore.setItem<SidebarBannerDismissState>(key, { closedAt });
};
