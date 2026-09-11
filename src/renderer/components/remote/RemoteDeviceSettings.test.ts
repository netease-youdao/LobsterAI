import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { RemoteConnectionReason, RemoteConnectionStatus, type RemoteSettingsState, RemoteSyncStatus } from '../../../shared/remote/constants';
import { i18nService } from '../../services/i18n';
import RemoteDeviceSettings from './RemoteDeviceSettings';

const harness = vi.hoisted(() => ({
  snapshot: { state: null as RemoteSettingsState | null, busy: false, error: null as string | null },
  submit: vi.fn(async () => true),
  refresh: vi.fn(async () => undefined),
  buttons: [] as React.ButtonHTMLAttributes<HTMLButtonElement>[],
}));
vi.mock('../../services/remoteSettings', () => ({ remoteSettingsService: {
  getSnapshot: () => harness.snapshot,
  subscribe: () => () => undefined,
  submit: harness.submit,
  refresh: harness.refresh,
} }));
vi.mock('react-redux', () => ({ useSelector: () => 1 }));
vi.mock('react/jsx-dev-runtime', async (importOriginal) => {
  const runtime = await importOriginal<typeof import('react/jsx-dev-runtime')>();
  const jsxDEV: typeof runtime.jsxDEV = (...args) => {
    const element = runtime.jsxDEV(...args);
    if (element.type === 'button') harness.buttons.push(element.props as React.ButtonHTMLAttributes<HTMLButtonElement>);
    return element;
  };
  return { ...runtime, jsxDEV };
});

const connected: RemoteSettingsState = {
  accountEpoch: 'epoch-a', stateRevision: 1, enabled: true, connected: true,
  keepAwakeEnabled: true, keepAwakeActive: true, name: 'Private alias', hostName: 'Local host',
  owner: { userId: 'user-a', scopeKey: 'personal' }, workspaces: [], accessRequests: [],
  connectionStatus: RemoteConnectionStatus.Online, settingsSyncStatus: RemoteSyncStatus.Synced,
};
const render = (loginAllowed = true) => {
  const onLogin = vi.fn();
  harness.buttons.length = 0;
  const html = renderToStaticMarkup(React.createElement(RemoteDeviceSettings, { onLogin, loginAllowed }));
  const button = (key: string) => harness.buttons.find(props => props['aria-label'] === i18nService.t(key) || props.children === i18nService.t(key));
  return { html, onLogin, button };
};
const click = (button: React.ButtonHTMLAttributes<HTMLButtonElement> | undefined) => {
  expect(button).toBeDefined();
  button?.onClick?.({} as React.MouseEvent<HTMLButtonElement>);
};

beforeEach(() => {
  harness.snapshot = { state: connected, busy: false, error: null };
  harness.submit.mockClear(); harness.refresh.mockClear();
  const logError = console.error;
  vi.spyOn(console, 'error').mockImplementation((message: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.includes('useLayoutEffect does nothing on the server')) return;
    logError(message, ...args);
  });
});
afterEach(() => vi.restoreAllMocks());

describe('current remote device settings', () => {
  test('shows the current device and identity without duplicating QR or preference switches', () => {
    const { html, button } = render();
    expect(html).toContain('Private alias');
    expect(html).toContain(i18nService.t('remotePersonalAccount'));
    expect(html).toContain(i18nService.t('remoteOnline'));
    expect(html).toContain(i18nService.t('remoteDeviceManagementDescription'));
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain(i18nService.t('remoteQrOfficialSite'));
    expect(html).not.toContain(i18nService.t('remoteAllowConnection'));
    expect(html).not.toContain('<h2');
    expect(button('remoteRenameDevice')?.disabled).toBe(false);
  });

  test('signed-out state hides the old alias and offers login without configuring the device', () => {
    harness.snapshot.state = { ...connected, owner: null };
    const { html, button, onLogin } = render();
    expect(html).toContain('Local host');
    expect(html).not.toContain('Private alias');
    expect(html).not.toContain(i18nService.t('remotePersonalAccount'));
    expect(button('remoteRenameDevice')?.disabled).toBe(true);
    click(button('login'));
    expect(onLogin).toHaveBeenCalledOnce();
    expect(harness.submit).not.toHaveBeenCalled();
  });

  test('respects login policy for signed-out accounts', () => {
    harness.snapshot.state = { ...connected, owner: null };
    const { html, button } = render(false);
    expect(html).toContain(i18nService.t('remoteLoginUnavailable'));
    expect(button('login')).toBeUndefined();
  });

  test('allows local rename while offline and reconnects without changing preferences', () => {
    harness.snapshot.state = { ...connected, connected: false, connectionStatus: RemoteConnectionStatus.Offline,
      error: 'network stack details', connectionReason: RemoteConnectionReason.Reconnecting };
    const { html, button } = render();
    expect(button('remoteRenameDevice')?.disabled).toBe(false);
    expect(html).not.toContain('network stack details');
    click(button('remoteReconnect'));
    expect(harness.submit.mock.calls).toEqual([[{ retry: true }]]);
  });

  test('does not offer reconnect when remote access is disabled or currently connecting', () => {
    harness.snapshot.state = { ...connected, connected: false, enabled: false };
    expect(render().button('remoteReconnect')).toBeUndefined();
    harness.snapshot.state = { ...connected, connected: false, connectionStatus: RemoteConnectionStatus.Offline,
      connectionReason: RemoteConnectionReason.Connecting };
    expect(render().button('remoteReconnect')).toBeUndefined();
  });

  test('busy state prevents repeated writes', () => {
    harness.snapshot = { state: { ...connected, connected: false, connectionStatus: RemoteConnectionStatus.Offline }, busy: true, error: null };
    const { button } = render();
    expect(button('remoteRenameDevice')?.disabled).toBe(true);
    expect(button('remoteReconnect')?.disabled).toBe(true);
    click(button('remoteReconnect'));
    expect(harness.submit).not.toHaveBeenCalled();
  });

  test('a button from an old account snapshot cannot submit changes for the new account', () => {
    harness.snapshot.state = { ...connected, connected: false, connectionStatus: RemoteConnectionStatus.Offline };
    const reconnect = render().button('remoteReconnect');
    harness.snapshot.state = { ...connected, accountEpoch: 'epoch-b', owner: { userId: 'user-b', scopeKey: 'personal' } };
    click(reconnect);
    expect(harness.submit).not.toHaveBeenCalled();
  });

  test('expired identity disables rename and requests login instead of reconnect', () => {
    harness.snapshot.state = { ...connected, connected: false, errorCode: 401 };
    const { html, button, onLogin } = render();
    expect(html).toContain(i18nService.t('remoteLoginExpired'));
    expect(button('remoteRenameDevice')?.disabled).toBe(true);
    expect(button('remoteReconnect')).toBeUndefined();
    click(button('login'));
    expect(onLogin).toHaveBeenCalledOnce();
    expect(harness.submit).not.toHaveBeenCalled();
  });

  test('unconfirmed settings refresh before any reconnect attempt', () => {
    harness.snapshot = { state: { ...connected, connected: false, connectionStatus: RemoteConnectionStatus.Offline }, busy: false, error: 'remoteSettingsUnconfirmed' };
    const { html, button } = render();
    expect(html).toContain(i18nService.t('remoteSettingsUnconfirmed'));
    expect(button('remoteRenameDevice')?.disabled).toBe(true);
    click(button('remoteReconnect'));
    expect(harness.refresh).toHaveBeenCalledOnce();
    expect(harness.submit).not.toHaveBeenCalled();
  });

  test('shows pending local changes and online workspace or lock explanations', () => {
    harness.snapshot.state = { ...connected, nameSyncStatus: RemoteSyncStatus.Pending, settingsSyncStatus: RemoteSyncStatus.Error,
      connectionReason: RemoteConnectionReason.WorkspaceUnavailable, screenLocked: true };
    const { html } = render();
    for (const key of ['remoteNamePending', 'remoteSavedPending', 'remoteWorkspaceUnavailable', 'remoteScreenLocked']) {
      expect(html).toContain(i18nService.t(key));
    }
  });

  test('requires a trusted epoch for rename and keeps instructions collapsed initially', () => {
    harness.snapshot.state = { ...connected, accountEpoch: undefined };
    const { html, button } = render();
    expect(button('remoteRenameDevice')?.disabled).toBe(true);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(i18nService.t('remoteHowItWorks'));
    expect(html).not.toContain(i18nService.t('remoteSameIdentityHelp'));
  });
});
