import { XMarkIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useMemo, useState } from 'react';

import { getPortalInvitationUrl } from '../services/endpoints';
import { i18nService } from '../services/i18n';
import {
  type ClientBanner,
  getSidebarBannerStorageKey,
  readSidebarBannerDismissState,
  saveSidebarBannerDismissState,
  shouldShowSidebarBanner,
} from './sidebarAdBannerState';

interface SidebarAdBannerProps {
  onVisibleChange?: (visible: boolean) => void;
}

const SidebarAdBanner: React.FC<SidebarAdBannerProps> = ({ onVisibleChange }) => {
  const [banners, setBanners] = useState<ClientBanner[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [hiddenKey, setHiddenKey] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let isCurrent = true;

    const loadBanner = async () => {
      try {
        const result = await window.electron.auth.getActiveClientBanners();
        if (!isCurrent) return;
        if (result.success && Array.isArray(result.data)) {
          setBanners(result.data as ClientBanner[]);
          setCurrentIndex(0);
        } else {
          setBanners([]);
        }
      } catch {
        if (isCurrent) setBanners([]);
      }
    };

    void loadBanner();
    return () => {
      isCurrent = false;
    };
  }, []);

  const storageKey = useMemo(() => (
    banners.length > 0 ? getSidebarBannerStorageKey(banners) : null
  ), [banners]);

  useEffect(() => {
    if (!storageKey) {
      setHiddenKey(null);
      return;
    }
    let isCurrent = true;
    setHiddenKey(undefined);

    const loadDismissState = async () => {
      const dismissState = await readSidebarBannerDismissState(storageKey);
      if (isCurrent) {
        setHiddenKey(shouldShowSidebarBanner(dismissState) ? null : storageKey);
      }
    };

    void loadDismissState();
    return () => {
      isCurrent = false;
    };
  }, [storageKey]);

  useEffect(() => {
    if (banners.length <= 1 || !storageKey || hiddenKey === undefined || hiddenKey === storageKey) {
      return;
    }
    const timer = window.setInterval(() => {
      setCurrentIndex((index) => (index + 1) % banners.length);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [banners.length, hiddenKey, storageKey]);

  const currentBannerIndex = banners.length > 0 ? currentIndex % banners.length : 0;
  const banner = banners.length > 0 ? banners[currentBannerIndex] : null;
  const hasMultipleBanners = banners.length > 1;
  const visibleIndicatorCount = Math.min(banners.length, 3);
  const activeIndicatorIndex = Math.min(currentBannerIndex, visibleIndicatorCount - 1);
  const isVisible = Boolean(banner && storageKey && hiddenKey !== undefined && hiddenKey !== storageKey);

  useEffect(() => {
    onVisibleChange?.(isVisible);
    return () => onVisibleChange?.(false);
  }, [isVisible, onVisibleChange]);

  if (!banner || !storageKey || !isVisible) {
    return null;
  }

  const dismiss = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setHiddenKey(storageKey);
    void saveSidebarBannerDismissState(storageKey).catch(() => {
      setHiddenKey(storageKey);
    });
  };

  const openBanner = async () => {
    await window.electron.shell.openExternal(banner.linkUrl || getPortalInvitationUrl());
  };

  const imageAspectRatio = banner.imageWidth && banner.imageHeight
    ? `${banner.imageWidth} / ${banner.imageHeight}`
    : '16 / 5';

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 pl-[18px] pr-3.5">
      <div
        role="button"
        tabIndex={0}
        onClick={() => void openBanner()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            void openBanner();
          }
        }}
        className="pointer-events-auto group relative block w-full overflow-visible rounded-lg bg-transparent drop-shadow-[0_4px_4px_rgba(227,227,228,0.5)] transition-opacity hover:opacity-95 dark:drop-shadow-none"
        style={{
          aspectRatio: imageAspectRatio,
        }}
        aria-label={banner.activityDescription}
      >
        <img
          src={banner.imageUrl}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          aria-hidden="true"
        />
        {hasMultipleBanners && (
          <div
            aria-hidden="true"
            className="absolute left-3 top-3 z-20 flex w-2 flex-col items-center gap-1"
          >
            {Array.from({ length: visibleIndicatorCount }, (_, index) => (
              <span
                key={index}
                className={`h-1.5 w-1.5 rounded-full ${
                  index === activeIndicatorIndex ? 'bg-[#656877]' : 'bg-[#D9D9D9]'
                }`}
              />
            ))}
          </div>
        )}
        <button
          type="button"
          aria-label={i18nService.t('close')}
          onClick={dismiss}
          onKeyDown={(event) => event.stopPropagation()}
          className="absolute right-2 top-2 z-20 flex h-4 w-4 items-center justify-center rounded-full bg-[#D9D9DB]/80 text-white transition-colors hover:bg-[#CFCFD2] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/20"
        >
          <XMarkIcon className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
};

export default SidebarAdBanner;
