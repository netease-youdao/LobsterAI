import type { RootState } from '../store';
import { ServerModelLoadStatus } from '../store/slices/modelSlice';

export function needsExpertLogin(state: Pick<RootState, 'auth' | 'model'>): boolean {
  return !state.auth.isLoggedIn && !state.model.availableModels.some(model => (
    !model.isServerModel && model.accessible !== false && model.busy !== true
  ));
}

export function canResumeExpertAfterLogin(state: Pick<RootState, 'auth' | 'model'>): boolean {
  return state.auth.isLoggedIn && state.model.serverModelLoadStatus === ServerModelLoadStatus.Ready;
}
