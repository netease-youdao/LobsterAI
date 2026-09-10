import { store } from '../store';
import { sameAccountContext } from '../store/accountSessionBoundary';
import { i18nService } from './i18n';

/** A response requested by a previous account must never refill the current view. */
export async function accountBoundRequest<T>(request: () => Promise<T>): Promise<T> {
  const account = store.getState().auth;
  const result = await request();
  if (!sameAccountContext(account, store.getState().auth)) {
    throw new Error(i18nService.t('accountSessionChanged'));
  }
  return result;
}
