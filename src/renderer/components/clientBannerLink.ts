import { isAppDeepLink, openAppDeepLink } from '../services/appDeepLink';
import { getClientBannerTargetUrl } from '../services/endpoints';
import type { ClientBanner } from './sidebarAdBannerState';
import { logSidebarExperienceDiagnostic } from './sidebarExperienceDiagnostics';

/**
 * Banner click target: lobsterai:// links navigate inside the app, everything else opens in the browser.
 * An in-app link this version does not know is ignored rather than handed to the OS, which would only
 * bounce back to LobsterAI's own protocol handler.
 */
export const openClientBannerLink = async (banner: ClientBanner): Promise<void> => {
  if (isAppDeepLink(banner.linkUrl)) {
    if (!openAppDeepLink(banner.linkUrl)) {
      logSidebarExperienceDiagnostic('warn', `unsupported in-app banner link: ${banner.linkUrl}`);
    }
    return;
  }
  await window.electron.shell.openExternal(
    getClientBannerTargetUrl(banner.linkUrl, banner.activityDescription),
  );
};
