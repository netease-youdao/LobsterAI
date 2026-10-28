import { AuthSessionStatus } from '@shared/auth/constants';

import { ServerModelLoadStatus } from '../store/slices/modelSlice';

export const AccountConnectionState = {
  Restoring: 'restoring',
  Unavailable: 'unavailable',
  ModelsLoading: 'models_loading',
  ModelsUnavailable: 'models_unavailable',
} as const;
export type AccountConnectionState = typeof AccountConnectionState[keyof typeof AccountConnectionState];

interface AuthSnapshot {
  isLoading: boolean;
  isLoggedIn: boolean;
  sessionStatus: AuthSessionStatus;
}

export const getAccountConnectionState = (auth: AuthSnapshot): AccountConnectionState | null => {
  if (auth.isLoading) return AccountConnectionState.Restoring;
  if (auth.sessionStatus === AuthSessionStatus.TemporarilyUnavailable) {
    return AccountConnectionState.Unavailable;
  }
  return null;
};

export const getModelConnectionState = (
  auth: AuthSnapshot,
  loadStatus: ServerModelLoadStatus,
  hasServerModels: boolean,
): AccountConnectionState | null => {
  const accountState = getAccountConnectionState(auth);
  if (accountState) return accountState;
  if (loadStatus === ServerModelLoadStatus.Error) return AccountConnectionState.ModelsUnavailable;
  if (!hasServerModels && (
    loadStatus === ServerModelLoadStatus.Loading
    || (auth.isLoggedIn && loadStatus === ServerModelLoadStatus.Idle)
  )) return AccountConnectionState.ModelsLoading;
  return null;
};
