import { ProviderName } from '@shared/providers/constants';
import { expect, test } from 'vitest';

import { store } from '../store';
import { type Model, ServerModelLoadStatus } from '../store/slices/modelSlice';
import { canResumeExpertAfterLogin, needsExpertLogin } from './expertLogin';

function state(isLoggedIn: boolean, models: Model[] = [], status: ServerModelLoadStatus = ServerModelLoadStatus.Ready) {
  const initial = store.getState();
  return {
    auth: { ...initial.auth, isLoggedIn },
    model: { ...initial.model, availableModels: models, serverModelLoadStatus: status },
  };
}

test('a fresh guest sees login before any expert preparation, including a locked public catalog', () => {
  expect(needsExpertLogin(state(false))).toBe(true);
  expect(needsExpertLogin(state(false, [{ id: 'plan', name: 'Plan', providerKey: ProviderName.LobsteraiServer, isServerModel: true, accessible: false }]))).toBe(true);
});

test('signed-in users and guests with a usable custom model can summon directly', () => {
  expect(needsExpertLogin(state(true))).toBe(false);
  expect(needsExpertLogin(state(false, [{ id: 'custom', name: 'Custom', providerKey: ProviderName.DeepSeek }]))).toBe(false);
});

test('disabled or busy custom models cannot suppress the login guide', () => {
  expect(needsExpertLogin(state(false, [{ id: 'custom', name: 'Custom', accessible: false }]))).toBe(true);
  expect(needsExpertLogin(state(false, [{ id: 'custom', name: 'Custom', busy: true }]))).toBe(true);
});

test.each([ServerModelLoadStatus.Idle, ServerModelLoadStatus.Loading, ServerModelLoadStatus.Error])(
  'login completion does not resume a summon while the account catalog is %s', status => {
    expect(canResumeExpertAfterLogin(state(true, [], status))).toBe(false);
  },
);

test('only authenticated catalog readiness resumes the retained intent', () => {
  expect(canResumeExpertAfterLogin(state(false))).toBe(false);
  expect(canResumeExpertAfterLogin(state(true))).toBe(true);
});
