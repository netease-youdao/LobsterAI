import { configureStore } from '@reduxjs/toolkit';
import { AuthSessionStatus } from '@shared/auth/constants';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Provider } from 'react-redux';
import { afterEach, expect, test } from 'vitest';

import { i18nService } from '../services/i18n';
import { type RootState, store } from '../store';
import { ServerModelLoadStatus } from '../store/slices/modelSlice';
import { AccountConnectionState, getModelConnectionState } from './accountConnectionState';
import LoginButton from './LoginButton';
import ModelSelector from './ModelSelector';

afterEach(() => i18nService.setLanguage('zh', { persist: false }));

const snapshot = (
  auth: Partial<RootState['auth']> = {},
  model: Partial<RootState['model']> = {},
): RootState => {
  const state = store.getState();
  return {
    ...state,
    auth: { ...state.auth, ...auth },
    model: { ...state.model, availableModels: [], ...model },
  };
};

const render = (state: RootState, component: React.ReactElement): string => renderToStaticMarkup(
  React.createElement(Provider, {
    store: configureStore({ reducer: () => state }),
    children: component,
  }),
);

const picker = React.createElement(ModelSelector, { value: null, onChange: () => {} });
const account = React.createElement(LoginButton, { loggedOutVariant: 'sidebarPromo' });

test('cold startup keeps My visible and describes session restoration instead of asking for login', () => {
  const state = snapshot({ isLoading: true, isLoggedIn: false });
  const accountHtml = render(state, account);
  const pickerHtml = render(state, picker);
  expect(accountHtml).toContain('我的');
  expect(accountHtml).toContain('正在恢复登录状态');
  expect(accountHtml).toContain('disabled=""');
  expect(accountHtml).not.toContain('sidebar-login-rainbow');
  expect(pickerHtml).toContain('正在恢复登录状态');
  expect(pickerHtml).not.toContain('登录使用套餐模型');
  expect(pickerHtml).not.toContain('请先在设置中配置模型');
});

test.each([false, true])('temporary verification failure shows recovery even with cached login=%s', isLoggedIn => {
  const state = snapshot({
    isLoading: false,
    isLoggedIn,
    sessionStatus: AuthSessionStatus.TemporarilyUnavailable,
    ownerAccountKey: null,
  });
  const accountHtml = render(state, account);
  const pickerHtml = render(state, picker);
  expect(accountHtml).toContain('我的');
  expect(accountHtml).not.toContain('sidebar-login-rainbow');
  expect(pickerHtml).toContain('账号连接暂不可用');
  expect(pickerHtml).toContain('重试');
  expect(pickerHtml).not.toContain('disabled=""');
  expect(pickerHtml).not.toContain('请先在设置中配置模型');
  expect(pickerHtml).not.toContain('登录使用套餐模型');
});

test('authenticated startup distinguishes pending models, request failure and confirmed empty models', () => {
  const auth = { isLoading: false, isLoggedIn: true, sessionStatus: AuthSessionStatus.Authenticated };
  const loading = render(snapshot(auth, { serverModelLoadStatus: ServerModelLoadStatus.Loading }), picker);
  expect(loading).toContain('正在加载套餐模型');
  const failed = render(snapshot(auth, { serverModelLoadStatus: ServerModelLoadStatus.Error }), picker);
  expect(failed).toContain('套餐模型暂不可用');
  expect(failed).not.toContain('请先在设置中配置模型');
  const empty = render(snapshot(auth, { serverModelLoadStatus: ServerModelLoadStatus.Ready }), picker);
  expect(empty).toContain('请先在设置中配置模型');
});

test('confirmed logged out users still get the login entry', () => {
  const state = snapshot({ isLoading: false, isLoggedIn: false, sessionStatus: AuthSessionStatus.Unauthenticated }, {
    serverModelLoadStatus: ServerModelLoadStatus.Ready,
  });
  expect(render(state, account)).toContain('sidebar-login-rainbow');
  expect(render(state, picker)).toContain('登录使用套餐模型');
});

test('custom models remain selectable while account connectivity is unavailable', () => {
  const custom = { id: 'local-model', name: 'Local Model', providerKey: 'ollama' };
  const state = snapshot({ isLoading: false, sessionStatus: AuthSessionStatus.TemporarilyUnavailable }, {
    availableModels: [custom],
    defaultSelectedModel: custom,
  });
  const html = render(state, React.createElement(ModelSelector));
  expect(html).toContain('Local Model');
  expect(html).not.toContain('disabled=""');
});

test('background model refresh keeps the loaded list without a loading notice', () => {
  const auth = { isLoading: false, isLoggedIn: true, sessionStatus: AuthSessionStatus.Authenticated };
  expect(getModelConnectionState(auth, ServerModelLoadStatus.Loading, true)).toBeNull();
  expect(getModelConnectionState(auth, ServerModelLoadStatus.Error, true))
    .toBe(AccountConnectionState.ModelsUnavailable);
  expect(getModelConnectionState(auth, ServerModelLoadStatus.Ready, true)).toBeNull();
});

test('connection messages are localized in English', () => {
  i18nService.setLanguage('en', { persist: false });
  const state = snapshot({ isLoading: false, sessionStatus: AuthSessionStatus.TemporarilyUnavailable });
  const html = render(state, picker);
  expect(html).toContain('Account connection unavailable');
  expect(html).toContain('Retry');
  expect(html).not.toContain('账号连接');
});
