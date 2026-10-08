import {
  AppUpdateStatus,
  type AppUpdateStatus as AppUpdateStatusValue,
} from '../../../shared/appUpdate/constants';

/**
 * Statuses during which a user-confirmed install locks the app. Downloads are
 * never blocking: they run silently in the background and only the install
 * the user explicitly confirmed takes over the window.
 */
export const isAppUpdateInteractionBlockingStatus = (
  status: AppUpdateStatusValue,
): boolean => (
  status === AppUpdateStatus.Ready
  || status === AppUpdateStatus.Installing
);

export const shouldBlockAppInteractionForUpdate = (
  isUserInitiatedFlowActive: boolean,
  status: AppUpdateStatusValue,
): boolean => (
  isUserInitiatedFlowActive && isAppUpdateInteractionBlockingStatus(status)
);
