import {
  type AppUpdateRuntimeState,
  AppUpdateStatus,
} from '../../../shared/appUpdate/constants';

/**
 * Whether the sidebar card and header badge should surface the update at all.
 *
 * Downloads run silently: nothing is shown until the installer is verified and
 * ready, so the only visible states are "ready to restart", "needs a manual
 * download", "installing" and "the last attempt failed". A routine re-check
 * keeps a ready update visible so the card does not flicker on every poll.
 */
export const shouldShowAppUpdateNotice = (state: AppUpdateRuntimeState): boolean => {
  if (!state.info) return false;
  switch (state.status) {
    case AppUpdateStatus.Available:
    case AppUpdateStatus.Ready:
    case AppUpdateStatus.Installing:
    case AppUpdateStatus.Error:
      return true;
    case AppUpdateStatus.Checking:
      return state.readyFilePath != null;
    default:
      return false;
  }
};

/**
 * A verified installer is on disk. Still true during a routine re-check, which
 * keeps the installer but cannot launch it until the check settles.
 */
export const isAppUpdateReadyToInstall = (state: AppUpdateRuntimeState): boolean => (
  state.readyFilePath != null
  && (state.status === AppUpdateStatus.Ready || state.status === AppUpdateStatus.Checking)
);
