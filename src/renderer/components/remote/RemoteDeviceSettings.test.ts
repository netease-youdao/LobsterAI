import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { type RemoteConnectionsSnapshot, RemoteDeviceAdmissionState, RemoteDeviceConnectionState } from '../../../shared/remote/connections';
import { RemoteConnectionReason, RemoteConnectionStatus, type RemoteSettingsState, RemoteSyncHealthReason, RemoteSyncHealthStatus, RemoteSyncStatus } from '../../../shared/remote/constants';
import { i18nService } from '../../services/i18n';
import RemoteDeviceSettings from './RemoteDeviceSettings';

const harness = vi.hoisted(() => ({
  snapshot: { state: null as RemoteSettingsState | null, busy: false, error: null as string | null },
  submit: vi.fn(async () => true),
  refresh: vi.fn(async () => undefined),
  management: { accountEpoch: null as string | null, data: null as RemoteConnectionsSnapshot | null, loading: false, error: null as string | null, operations: {} },
  resume: vi.fn(async () => true),
  buttons: [] as React.ButtonHTMLAttributes<HTMLButtonElement>[],
}));
vi.mock('../../services/remoteSettings', () => ({ remoteSettingsService: {
  getSnapshot: () => harness.snapshot,
  subscribe: () => () => undefined,
  submit: harness.submit,
  refresh: harness.refresh,
} }));
vi.mock('../../services/remoteDeviceConnections', () => ({ remoteDeviceConnectionsService: {
  getSnapshot: () => harness.management, subscribe: () => () => undefined, refresh: harness.refresh, resume: harness.resume,
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
  harness.submit.mockClear(); harness.refresh.mockClear(); harness.resume.mockClear();
  harness.management = { accountEpoch: null, data: null, loading: false, error: null, operations: {} };
  const logError = console.error;
  vi.spyOn(console, 'error').mockImplementation((message: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.includes('useLayoutEffect does nothing on the server')) return;
    logError(message, ...args);
  });
});
afterEach(() => vi.restoreAllMocks());

describe('current remote device settings', () => {
  test('shows the current device, public QR banner and identity without duplicating preference switches', () => {
    const { html, button } = render();
    expect(html).toContain('Private alias');
    expect(html).toContain(i18nService.t('remoteCurrentDevice'));
    expect(html).toContain(i18nService.t('remoteOnline'));
    expect(html).toContain(i18nService.t('remoteDevicesBannerTitle'));
    expect(html).not.toContain('role="switch"');
    expect(html).toContain(i18nService.t('remoteQrOfficialSite'));
    expect(html).toContain('https://lobsterai.youdao.com/');
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

  test('an unavailable server pauses queued content without displaying active synchronization', () => {
    harness.snapshot.state = { ...connected, connected: false, connectionStatus: RemoteConnectionStatus.Offline,
      connectionReason: RemoteConnectionReason.ServerUnavailable, sessionSyncStatus: RemoteSyncStatus.Pending,
      syncHealth: { status: RemoteSyncHealthStatus.Syncing, reason: RemoteSyncHealthReason.Connection,
        pendingSessions: 1, oldestPendingAt: null, lastSuccessfulSyncAt: null, observedAt: '2026-09-23T03:03:23Z' } };
    const { html, button } = render();
    expect(html).toContain(i18nService.t('remoteUnavailable'));
    expect(html).toContain(i18nService.t('remoteSyncPaused'));
    expect(html).not.toContain(i18nService.t('remoteContentSyncing'));
    expect(button('remoteReconnect')).toBeDefined();
    harness.snapshot.state = { ...harness.snapshot.state, connected: true, connectionStatus: RemoteConnectionStatus.Online,
      connectionReason: undefined };
    const recovered = render();
    expect(recovered.html).toContain(i18nService.t('remoteContentSyncing'));
    expect(recovered.html).not.toContain(i18nService.t('remoteSyncPaused'));
  });

  test.each([
    ['agentCatalogSyncStatus', 'remoteAgentCatalogSyncFailed'],
    ['sessionSyncStatus', 'remoteSessionSyncFailed'],
  ] as const)('keeps the device online and offers retry for %s', (field, message) => {
    harness.snapshot.state = { ...connected, [field]: RemoteSyncStatus.Error, connectionReason: RemoteConnectionReason.Connecting };
    const { html, button } = render();
    expect(html).toContain(i18nService.t('remoteOnline'));
    expect(html).toContain(i18nService.t(message));
    expect(html).not.toContain(i18nService.t('remoteUnavailable'));
    expect(button('remoteReconnect')).toBeUndefined();
    click(button('retry'));
    expect(harness.submit.mock.calls).toEqual([[{ retry: true }]]);
  });

  test('disables online synchronization retry while busy and removes it after recovery', () => {
    harness.snapshot = { state: { ...connected, agentCatalogSyncStatus: RemoteSyncStatus.Error }, busy: true, error: null };
    const { button } = render();
    expect(button('retry')?.disabled).toBe(true);
    click(button('retry'));
    expect(harness.submit).not.toHaveBeenCalled();
    harness.snapshot = { state: { ...connected, agentCatalogSyncStatus: RemoteSyncStatus.Synced }, busy: false, error: null };
    const recovered = render();
    expect(recovered.html).not.toContain(i18nService.t('remoteAgentCatalogSyncFailed'));
    expect(recovered.button('retry')).toBeUndefined();
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

  test('requires a trusted epoch for rename without repeating help in the page body', () => {
    harness.snapshot.state = { ...connected, accountEpoch: undefined };
    const { html, button } = render();
    expect(button('remoteRenameDevice')?.disabled).toBe(true);
    expect(html).not.toContain(i18nService.t('remoteHowItWorks'));
    expect(html).not.toContain(i18nService.t('remoteSameIdentityHelp'));
  });
  test('quota blocked remains visible with paused-sync explanation and no failure alert', () => {
    harness.snapshot.state = { ...connected, connected: false, deviceConnectionManagementSupported: true,
      connectionReason: RemoteConnectionReason.QuotaBlocked, errorCode: 47022 };
    const { html, button } = render();
    expect(html).toContain('Private alias');
    expect(html).toContain(i18nService.t('remoteWaitingForConnection'));
    expect(html).toContain(i18nService.t('remoteLocalTasksUnaffected'));
    expect(html).not.toContain(i18nService.t('remoteConnectionFailed'));
    click(button('remoteReconnect'));
    expect(harness.submit).toHaveBeenCalledWith({ retry: true });
  });

  test('removed device resumes explicitly rather than retrying the old connection', () => {
    harness.snapshot.state = { ...connected, connected: false, deviceConnectionManagementSupported: true, connectionReason: RemoteConnectionReason.Removed };
    const current = { deviceId: 'this', name: 'Private alias', connectionVersion: '2', connectionState: RemoteDeviceConnectionState.Removed, admissionState: RemoteDeviceAdmissionState.Removed, slotOccupied: false };
    harness.management = { accountEpoch: 'epoch-a', data: { supported: true, observedAt: '', presenceAvailable: true,
      quota: { maxOnlineDesktops: 5, onlineSlotsUsed: 0, scope: 'account_scope' }, currentDevice: current, connections: [] }, loading: false, error: null, operations: {} };
    const { html, button } = render();
    expect(html).toContain(i18nService.t('remoteConnectionRemoved'));
    click(button('remoteReconnect'));
    expect(harness.resume).toHaveBeenCalledWith(current, 'epoch-a');
    expect(harness.submit).not.toHaveBeenCalled();
  });

});
