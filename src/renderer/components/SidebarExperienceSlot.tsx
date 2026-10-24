import {
  ChevronLeftIcon,
  ChevronRightIcon,
} from '@heroicons/react/24/outline';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';

import { configService } from '../services/config';
import { i18nService } from '../services/i18n';
import SidebarAdBanner from './SidebarAdBanner';
import {
  type ClientBanner,
  getSidebarBannerVersion,
} from './sidebarAdBannerState';
import {
  getAdjacentSidebarCarouselKey,
  resolveSidebarCarouselIndex,
  shouldShowSidebarCarouselControls,
} from './sidebarExperienceCarouselState';
import { useSidebarAdBanners } from './useSidebarAdBanners';

interface SidebarExperienceSlotProps {
  hidden?: boolean;
  onVisibleChange?: (visible: boolean) => void;
}

interface BannerExperienceItem {
  key: string;
  banner: ClientBanner;
}

const SIDEBAR_BANNER_ROTATION_MS = 5000;

const SidebarExperienceSlot: React.FC<SidebarExperienceSlotProps> = ({
  hidden = false,
  onVisibleChange,
}) => {
  const {
    visibleBanners,
    loading,
    dismissGroup,
  } = useSidebarAdBanners();
  const [activeItemKey, setActiveItemKey] = useState<string | null>(null);
  const [configHidden, setConfigHidden] = useState(false);

  // Check if user has permanently hidden the ad banner in settings
  useEffect(() => {
    try {
      const config = configService.getConfig();
      setConfigHidden(config.app?.adBannerHidden === true);
    } catch {
      // config service may not be ready yet
    }
  }, []);

  const items = useMemo<BannerExperienceItem[]>(
    () => (configHidden
      ? []
      : visibleBanners.map(banner => ({
        key: `banner:${getSidebarBannerVersion(banner)}`,
        banner,
      }))),
    [configHidden, visibleBanners],
  );
  const itemKeys = useMemo(
    () => items.map(item => item.key),
    [items],
  );
  const activeIndex = resolveSidebarCarouselIndex(itemKeys, activeItemKey);
  const activeItem = activeIndex >= 0 ? items[activeIndex] : null;
  const resolvedActiveItemKey = activeItem?.key ?? null;
  const showCarouselControls = shouldShowSidebarCarouselControls(items.length);
  const displayed = Boolean(!hidden && !loading && activeItem);

  useEffect(() => {
    setActiveItemKey(currentKey => (
      currentKey === resolvedActiveItemKey
        ? currentKey
        : resolvedActiveItemKey
    ));
  }, [resolvedActiveItemKey]);

  useLayoutEffect(() => {
    onVisibleChange?.(displayed);
    return () => onVisibleChange?.(false);
  }, [displayed, onVisibleChange]);

  const changeActiveItem = useCallback((offset: number) => {
    setActiveItemKey(currentKey => getAdjacentSidebarCarouselKey(
      itemKeys,
      currentKey,
      offset,
    ));
  }, [itemKeys]);

  useEffect(() => {
    if (hidden || items.length <= 1) return undefined;
    const timer = window.setInterval(() => {
      changeActiveItem(1);
    }, SIDEBAR_BANNER_ROTATION_MS);
    return () => window.clearInterval(timer);
  }, [changeActiveItem, hidden, items.length]);

  if (loading || !activeItem) return null;

  return (
    <div
      aria-hidden={hidden || undefined}
      className={`pointer-events-none absolute inset-x-0 bottom-0 z-40 pl-[18px] pr-3.5 transition-[opacity,transform] motion-reduce:transition-none ${
        hidden
          ? 'translate-y-2 opacity-0 duration-0'
          : 'translate-y-0 opacity-100 duration-200 ease-out'
      }`}
    >
      <div className="relative">
        <SidebarAdBanner
          banner={activeItem.banner}
          hidden={hidden}
          onDismiss={() => void dismissGroup()}
        />
        {showCarouselControls && (
          <>
            <button
              type="button"
              tabIndex={hidden ? -1 : 0}
              aria-label={i18nService.t('sidebarCarouselPrevious')}
              onClick={() => changeActiveItem(-1)}
              className={`${hidden ? 'pointer-events-none' : 'pointer-events-auto'} absolute -left-2.5 top-1/2 z-30 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white shadow-sm transition-colors hover:bg-black/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80`}
            >
              <ChevronLeftIcon className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              tabIndex={hidden ? -1 : 0}
              aria-label={i18nService.t('sidebarCarouselNext')}
              onClick={() => changeActiveItem(1)}
              className={`${hidden ? 'pointer-events-none' : 'pointer-events-auto'} absolute -right-2.5 top-1/2 z-30 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white shadow-sm transition-colors hover:bg-black/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80`}
            >
              <ChevronRightIcon className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>
    </div>
  );
};

export default SidebarExperienceSlot;
