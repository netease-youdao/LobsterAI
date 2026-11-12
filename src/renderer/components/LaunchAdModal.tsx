import { XMarkIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { ClientBannerPlacement } from '../../shared/clientBanner/constants';
import { i18nService } from '../services/i18n';
import { localStore } from '../services/store';
import { openClientBannerLink } from './clientBannerLink';
import Modal from './common/Modal';
import {
  LAUNCH_AD_MAX_DELAY_MS,
  LAUNCH_AD_STATE_KEY,
  type LaunchAdState,
  markLaunchAdDismissed,
  markLaunchAdShown,
  normalizeLaunchAdState,
  pickLaunchAd,
  resolveLaunchAdWidth,
} from './launchAdFrequency';
import SidebarAdBannerHtml from './SidebarAdBannerHtml';
import { type ClientBanner, isHtmlSidebarBanner } from './sidebarAdBannerState';
import { logSidebarExperienceDiagnostic } from './sidebarExperienceDiagnostics';
import { useClientBanners } from './useSidebarAdBanners';

const DIALOG_SELECTOR = '[data-app-modal], [role="dialog"], [aria-modal="true"]';
const otherDialogOpen = (): boolean => Array.from(document.querySelectorAll(DIALOG_SELECTOR))
  .some(node => node.getClientRects().length > 0);

/** One pop-up decision per app session, even if the component remounts. */
let launchAdDecided = false;

interface LaunchAdModalProps {
  /** True once first-run onboarding and privacy consent are done and no other overlay is up. */
  enabled: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * Launch ad shown right after the window opens. It sits above the engine startup
 * overlay (z-[100]) and never waits for the gateway, which keeps booting underneath.
 */
const LaunchAdModal: React.FC<LaunchAdModalProps> = ({ enabled, onOpenChange }) => {
  const { banners, loading } = useClientBanners(ClientBannerPlacement.DesktopLaunchModal);
  const [banner, setBanner] = useState<ClientBanner | null>(null);
  const stateRef = useRef<LaunchAdState | null>(null);
  const mountedAtRef = useRef(Date.now());

  useEffect(() => {
    if (launchAdDecided || !enabled || loading) return;
    launchAdDecided = true;
    if (banners.length === 0 || Date.now() - mountedAtRef.current > LAUNCH_AD_MAX_DELAY_MS) return;
    void (async () => {
      const state = normalizeLaunchAdState(await localStore.getItem<unknown>(LAUNCH_AD_STATE_KEY));
      const picked = pickLaunchAd(banners, state);
      // Another dialog grabbed the screen while we were reading state; skip this launch.
      if (!picked || otherDialogOpen()) return;
      const shownState = markLaunchAdShown(state, picked);
      stateRef.current = shownState;
      setBanner(picked);
      try {
        await localStore.setItem(LAUNCH_AD_STATE_KEY, shownState);
      } catch (error) {
        logSidebarExperienceDiagnostic('warn', 'failed to persist launch ad state', error);
      }
    })();
  }, [banners, enabled, loading]);

  useEffect(() => {
    onOpenChange?.(banner !== null);
  }, [banner, onOpenChange]);

  const close = useCallback(() => {
    if (!banner) return;
    const nextState = markLaunchAdDismissed(stateRef.current ?? { versions: {} }, banner);
    stateRef.current = nextState;
    setBanner(null);
    void localStore.setItem(LAUNCH_AD_STATE_KEY, nextState).catch(error => {
      logSidebarExperienceDiagnostic('warn', 'failed to persist launch ad dismissal', error);
    });
  }, [banner]);

  const openLink = useCallback(() => {
    if (!banner) return;
    void openClientBannerLink(banner);
    close();
  }, [banner, close]);

  if (!banner) return null;

  const htmlBanner = isHtmlSidebarBanner(banner);
  const aspectRatio = banner.imageWidth && banner.imageHeight
    ? `${banner.imageWidth} / ${banner.imageHeight}`
    : '4 / 5';

  return (
    <Modal
      onClose={close}
      onEscape={close}
      overlayClassName="fixed inset-0 z-[220] flex items-center justify-center bg-black/45 p-4"
      className="relative max-w-[90vw]"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={banner.activityDescription}
        data-launch-ad
        className="max-w-full"
        style={{ width: resolveLaunchAdWidth(banner) }}
      >
        <div
          role="button"
          tabIndex={0}
          onClick={openLink}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              openLink();
            }
          }}
          className="relative block w-full cursor-pointer overflow-hidden rounded-2xl shadow-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
          style={htmlBanner ? undefined : { aspectRatio }}
        >
          {htmlBanner ? (
            <SidebarAdBannerHtml html={banner.htmlContent ?? ''} />
          ) : (
            <img
              src={banner.imageUrl}
              alt=""
              aria-hidden="true"
              className="absolute inset-0 h-full w-full object-cover"
            />
          )}
        </div>
        <button
          type="button"
          aria-label={i18nService.t('close')}
          onClick={close}
          className="absolute -right-3 -top-3 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-white/90 text-neutral-700 shadow-md transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
        >
          <XMarkIcon className="h-4 w-4" />
        </button>
      </div>
    </Modal>
  );
};

export default LaunchAdModal;
