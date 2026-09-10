import { createAction, type Middleware } from '@reduxjs/toolkit';

interface AccountContext {
  ownerAccountKey: string | null;
  accountGeneration: number;
}

export const resetAccountSessionData = createAction('account/resetSessionData');

export const sameAccountContext = (before: AccountContext, after: AccountContext): boolean => (
  before.ownerAccountKey === after.ownerAccountKey
  && before.accountGeneration === after.accountGeneration
);

/** Clear account-owned views synchronously before an auth dispatch returns. */
export const accountSessionBoundary: Middleware = api => next => action => {
  const before = (api.getState() as { auth: AccountContext }).auth;
  const result = next(action);
  const after = (api.getState() as { auth: AccountContext }).auth;
  if (!sameAccountContext(before, after)) api.dispatch(resetAccountSessionData());
  return result;
};
