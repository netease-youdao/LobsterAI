import { XMarkIcon } from '@heroicons/react/24/outline';
import React from 'react';

import { getClientBannerTargetUrl } from '../services/endpoints';
import { i18nService } from '../services/i18n';
import type { ClientBanner } from './sidebarAdBannerState';

interface SidebarAdBannerProps {
  banner: ClientBanner;
  hidden?: boolean;
  onDismiss: () => void;
}

const SidebarAdBanner: React.FC<SidebarAdBannerProps> = ({
  banner,
  hidden = false,
  onDismiss,
}) => {
  const dismiss = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onDismiss();
  };

  const openBanner = async () => {
    await window.electron.shell.openExternal(
      getClientBannerTargetUrl(banner.linkUrl, banner.activityDescription),
    );
  };

  const imageAspectRatio = banner.imageWidth && banner.imageHeight
    ? `${banner.imageWidth} / ${banner.imageHeight}`
    : '16 / 5';

  return (
    <div
      role="button"
      tabIndex={hidden ? -1 : 0}
      onClick={() => void openBanner()}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          void openBanner();
        }
      }}
      className={`${hidden ? 'pointer-events-none' : 'pointer-events-auto'} group relative block w-full overflow-visible rounded-lg bg-transparent drop-shadow-[0_4px_4px_rgba(227,227,228,0.5)] transition-opacity hover:opacity-95 dark:drop-shadow-none`}
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
      <button
        type="button"
        tabIndex={hidden ? -1 : 0}
        aria-label={i18nService.t('close')}
        onClick={dismiss}
        onKeyDown={(event) => event.stopPropagation()}
        className="absolute right-2 top-2 z-20 flex h-4 w-4 items-center justify-center rounded-full bg-[#D9D9DB]/80 text-white transition-colors hover:bg-[#CFCFD2] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/20"
      >
        <XMarkIcon className="h-3 w-3" />
      </button>
    </div>
  );
};

export default SidebarAdBanner;
