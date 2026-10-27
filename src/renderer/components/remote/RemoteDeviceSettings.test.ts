import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { OwnershipTargetKind } from '../../../shared/ownership/constants';
import { type RemoteConnectionsSnapshot, RemoteDeviceAdmissionState, RemoteDeviceConnectionState } from '../../../shared/remote/connections';
import { RemoteConnectionReason, RemoteConnectionStatus, RemoteInitializationFailure, type RemoteSettingsState, RemoteSyncHealthReason, RemoteSyncHealthStatus, RemoteSyncLaneStatus, RemoteSyncStatus, RemoteSyncTaskIssueSource, RemoteSyncTaskIssueStatus } from '../../../shared/remote/constants';
import { i18nService } from '../../services/i18n';
import RemoteDeviceSettings from './RemoteDeviceSettings';

const harness = vi.hoisted(() => ({
  snapshot: { state: null as RemoteSettingsState | null, busy: false, error: null as string | null },
  submit: vi.fn(async () => true),
  openTask: vi.fn(async () => undefined),
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
vi.mock('../../services/ownership', () => ({ ownershipService: { open: harness.openTask } }));
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
  const taskButton = (title: string) => harness.buttons.find(props => React.Children.toArray(props.children)
    .some(child => React.isValidElement<{ children?: React.ReactNode }>(child) && child.props.children === title));
  return { html, onLogin, button, taskButton };
};
const click = (button: React.ButtonHTMLAttributes<HTMLButtonElement> | undefined) => {
  expect(button).toBeDefined();
  button?.onClick?.({} as React.MouseEvent<HTMLButtonElement>);
};

beforeEach(() => {
  harness.snapshot = { state: connected, busy: false, error: null };
  harness.submit.mockClear(); harness.refresh.mockClear(); harness.resume.mockClear(); harness.openTask.mockClear();
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

  test.each([
    [RemoteInitializationFailure.SecureStorageUnavailable, 'remoteLocalSecureStorageUnavailable'],
    [RemoteInitializationFailure.IdentityUnreadable, 'remoteLocalIdentityUnreadable'],
    [RemoteInitializationFailure.IdentityInvalid, 'remoteLocalIdentityInvalid'],
    [RemoteInitializationFailure.LocalStorageUnavailable, 'remoteLocalStorageUnavailable'],
    [RemoteInitializationFailure.DependencyUnavailable, 'remoteLocalInitializationFailed'],
  ] as const)('keeps the current device visible for %s and only rechecks the existing identity', (initializationFailure, message) => {
    harness.snapshot.state = { ...connected, initializationFailure, error: 'private credential details', errorCode: 47023 };
    const { html, button } = render();
    expect(html).toContain('Private alias');
    expect(html).toContain(i18nService.t('remoteCurrentDevice'));
    expect(html).toContain(i18nService.t(message));
    expect(html).not.toContain(i18nService.t('remoteOnline'));
    expect(html).not.toContain(i18nService.t('remoteUnavailable'));
    expect(html).not.toContain('private credential details');
    expect(html.includes(i18nService.t('remoteLocalIdentityRecoveryHelp'))).toBe(
      initializationFailure === RemoteInitializationFailure.IdentityUnreadable || initializationFailure === RemoteInitializationFailure.IdentityInvalid,
    );
    expect(button('remoteRenameDevice')?.disabled).toBe(true);
    expect(button('remoteReconnect')).toBeUndefined();
    expect(button('remoteReregister')).toBeUndefined();
    click(button('remoteLocalRecheck'));
    expect(harness.submit.mock.calls).toEqual([[{ retry: true }]]);
    expect(html).not.toContain(i18nService.t('remoteResumeRequested'));
    harness.snapshot.state = { ...connected };
    const recovered = render();
    expect(recovered.html).toContain(i18nService.t('remoteOnline'));
    expect(recovered.button('remoteLocalRecheck')).toBeUndefined();
    expect(recovered.html).not.toContain(i18nService.t('remoteLocalIdentityRecoveryHelp'));
  });

  test('local failure hides stale connection management and does not use its quota or remove state', () => {
    harness.snapshot.state = { ...connected, initializationFailure: RemoteInitializationFailure.IdentityUnreadable,
      deviceConnectionManagementSupported: true, connectionReason: RemoteConnectionReason.QuotaBlocked };
    harness.management = { ...harness.management, accountEpoch: connected.accountEpoch!, data: {
      supported: true, presenceAvailable: true, observedAt: '2026-10-26T00:00:00Z',
      quota: { maxOnlineDesktops: 5, onlineSlotsUsed: 5, scope: 'account_scope' },
      currentDevice: { deviceId: 'current', name: 'Current', connectionVersion: '1', connectionState: RemoteDeviceConnectionState.Removed,
        admissionState: RemoteDeviceAdmissionState.QuotaBlocked, slotOccupied: false }, connections: [],
    } };
    const { html, button } = render();
    expect(html).toContain(i18nService.t('remoteLocalIdentityUnreadable'));
    expect(html).not.toContain(i18nService.t('remoteWaitingForConnection'));
    expect(html).not.toContain(i18nService.t('remoteConnectionRemoved'));
    expect(button('remoteManageConnections')).toBeUndefined();
    expect(button('remoteReconnect')).toBeUndefined();
  });

  test('local recheck keeps a disabled preference and respects busy, logout and account boundaries', () => {
    harness.snapshot.state = { ...connected, enabled: false, initializationFailure: RemoteInitializationFailure.IdentityUnreadable };
    const recheck = render().button('remoteLocalRecheck');
    click(recheck);
    expect(harness.submit.mock.calls).toEqual([[{ retry: true }]]);
    harness.submit.mockClear();
    harness.snapshot.busy = true;
    const busy = render().button('remoteLocalRecheck');
    expect(busy?.disabled).toBe(true);
    click(busy);
    expect(harness.submit).not.toHaveBeenCalled();
    harness.snapshot = { state: { ...connected, owner: null, initializationFailure: RemoteInitializationFailure.IdentityUnreadable }, busy: false, error: null };
    const signedOut = render();
    expect(signedOut.button('remoteLocalRecheck')).toBeUndefined();
    expect(signedOut.html).not.toContain(i18nService.t('remoteLocalIdentityRecoveryHelp'));
    expect(signedOut.html).not.toContain(i18nService.t('remoteLocalIdentityUnreadable'));
    expect(signedOut.html).not.toContain('Private alias');
    click(recheck);
    expect(harness.submit).not.toHaveBeenCalled();
    harness.snapshot.state = { ...connected, accountEpoch: 'epoch-b', owner: { userId: 'user-b', scopeKey: 'personal' } };
    click(recheck);
    expect(harness.submit).not.toHaveBeenCalled();
  });

  test('partial task errors stay separate from connection status and open task details', () => {
    harness.snapshot.state = { ...connected, sessionSyncStatus: RemoteSyncStatus.Error,
      syncHealth: { status: RemoteSyncHealthStatus.Degraded, reason: RemoteSyncHealthReason.Projection,
        pendingSessions: 2, failedSessions: 2, isolatedSessions: 1, retryingSessions: 1,
        oldestPendingAt: null, lastSuccessfulSyncAt: null, observedAt: '2026-09-23T00:00:00Z',
        taskIssues: [{ localSessionId: 'task-1', title: 'Affected task', status: RemoteSyncTaskIssueStatus.Retrying, retryable: true }] } };
    const { html, button, taskButton } = render();
    expect(html).toContain(`${i18nService.t('remoteOnline')}</span> · ${i18nService.t('remoteCurrentDevice')}`);
    expect(html).toContain(i18nService.t('remoteTaskContentIncomplete'));
    expect(html).not.toContain(i18nService.t('remoteSyncPaused'));
    expect(html).not.toContain(i18nService.t('remoteSessionSyncFailed'));
    expect(html).toContain('Affected task');
    expect(html).toContain('<details');
    expect(html).not.toContain('<details open');
    expect(button('retry')).toBeUndefined();
    expect(button('remoteRetryTask')).toBeUndefined();
    click(taskButton('Affected task'));
    expect(harness.openTask).toHaveBeenCalledExactlyOnceWith({ kind: OwnershipTargetKind.Task, id: 'task-1' });
    expect(harness.submit).not.toHaveBeenCalled();
  });

  test('object faults expose the affected session without promising automatic repair or pausing the whole connection', () => {
    harness.snapshot.state = { ...connected, sessionSyncStatus: RemoteSyncStatus.Error,
      syncHealth: { status: RemoteSyncHealthStatus.Degraded, reason: RemoteSyncHealthReason.Projection,
        pendingSessions: 1, failedSessions: 1, isolatedSessions: 1, retryingSessions: 0,
        oldestPendingAt: null, lastSuccessfulSyncAt: null, observedAt: '2026-10-27T00:00:00Z',
        taskIssues: [{ localSessionId: 'live-task', title: 'Affected live session', source: RemoteSyncTaskIssueSource.Live,
          status: RemoteSyncTaskIssueStatus.Isolated, retryable: true }] } };
    const { html, button } = render();
    expect(html).toContain(i18nService.t('remoteOnline'));
    expect(html).toContain(i18nService.t('remoteTaskContentIncomplete'));
    expect(html).toContain('Affected live session'); expect(html).toContain(i18nService.t('ownershipContentSyncEntryFailed'));
    expect(html).not.toContain(i18nService.t('remoteTaskLiveSyncIssue'));
    expect(html).not.toContain(i18nService.t('remoteSyncPaused')); expect(html).not.toContain(i18nService.t('remoteSessionSyncFailed'));
    expect(html).not.toContain(i18nService.t('remoteTaskSyncRetrying'));
    expect(button('remoteRetryTask')).toBeUndefined();
    click(render().taskButton('Affected live session'));
    expect(harness.openTask).toHaveBeenCalledExactlyOnceWith({ kind: OwnershipTargetKind.Task, id: 'live-task' });
    expect(harness.submit).not.toHaveBeenCalled();
  });
  test('desktop-only content has a neutral explanation, including alongside a separate pending upload', () => {
    harness.snapshot.state = { ...connected, sessionSyncStatus: RemoteSyncStatus.Synced,
      syncHealth: { status: RemoteSyncHealthStatus.Idle, pendingSessions: 0, desktopOnlySessions: 1, failedSessions: 0,
        oldestPendingAt: null, lastSuccessfulSyncAt: null, observedAt: '2026-10-27T00:00:00Z', taskIssues: [] } };
    const { html, button } = render();
    expect(html).toContain(i18nService.t('remoteOnline')); expect(html).toContain(i18nService.t('remoteDesktopOnlyContent'));
    expect(html).not.toContain('role="alert"'); expect(html).not.toContain(i18nService.t('remoteSyncPaused'));
    expect(html).not.toContain('<details'); expect(button('retry')).toBeUndefined();
    harness.snapshot.state = { ...harness.snapshot.state, syncHealth: { ...harness.snapshot.state.syncHealth!, status: RemoteSyncHealthStatus.Syncing, pendingSessions: 1 } };
    const pending = render().html;
    expect(pending).not.toContain(i18nService.t('remoteContentSyncing')); expect(pending).toContain(i18nService.t('remoteDesktopOnlyContent'));
    expect(pending).not.toContain('role="alert"');
  });
  test('marks bounded health counts as lower bounds instead of presenting an exact total', () => {
    harness.snapshot.state = { ...connected, sessionSyncStatus: RemoteSyncStatus.Error,
      syncHealth: { status: RemoteSyncHealthStatus.Degraded, reason: RemoteSyncHealthReason.Projection,
        pendingSessions: 64, failedSessions: 64, countsTruncated: true, taskIssuesTruncated: true,
        oldestPendingAt: null, lastSuccessfulSyncAt: null, observedAt: '2026-09-23T00:00:00Z' } };
    const { html } = render();
    expect(html).toContain(i18nService.t('remoteTaskContentIncomplete'));
    expect(html).toContain(i18nService.t('remoteTaskContentLimited'));
    expect(html).toContain(i18nService.t('remoteTaskContentDetailsUnavailable'));
    expect(html).not.toContain('≥64');
  });

  test('legacy session errors without a task summary show uncertainty without inventing a target or retry', () => {
    harness.snapshot.state = { ...connected, sessionSyncStatus: RemoteSyncStatus.Error };
    const { html, button } = render();
    expect(html).toContain(i18nService.t('remoteTaskContentUnknown'));
    expect(html).toContain(i18nService.t('remoteTaskContentDetailsUnavailable'));
    expect(html).not.toContain(i18nService.t('remoteTaskContentIncomplete'));
    expect(html).not.toContain('role="alert"');
    expect(button('retry')).toBeUndefined(); expect(button('remoteRetryTask')).toBeUndefined();
  });

  test('the disclosure shows at most twenty identified tasks and states that the list is incomplete', () => {
    harness.snapshot.state = { ...connected, syncHealth: { status: RemoteSyncHealthStatus.Degraded, failedSessions: 25,
      pendingSessions: 25, oldestPendingAt: null, lastSuccessfulSyncAt: null, observedAt: '2026-10-27T00:00:00Z',
      taskIssues: Array.from({ length: 25 }, (_, index) => ({ localSessionId: `task-${index}`, title: `Affected-${index}`,
        status: RemoteSyncTaskIssueStatus.Isolated, retryable: false })) } };
    const { html, taskButton } = render();
    expect(taskButton('Affected-19')).toBeDefined(); expect(taskButton('Affected-20')).toBeUndefined();
    expect(html).toContain(i18nService.t('remoteTaskContentLimited'));
    expect(html).not.toContain(i18nService.t('remoteRetryTask'));
  });

  test('explains deferred history admission while preserving online status and a reconnect action', () => {
    harness.snapshot.state = { ...connected, sessionSyncStatus: RemoteSyncStatus.Error,
      syncHealth: { status: RemoteSyncHealthStatus.Paused, admissionDeferred: true, failedSessions: 2,
        pendingSessions: 2, oldestPendingAt: null, lastSuccessfulSyncAt: null, observedAt: '2026-09-23T00:00:00Z' } };
    const { html, button } = render();
    expect(html).toContain(i18nService.t('remoteOnline'));
    expect(html).not.toContain(i18nService.t('remoteSyncPaused'));
    expect(html).toContain(i18nService.t('remoteHistoryAdmissionDeferred'));
    expect(html).not.toContain(i18nService.t('remoteUnavailable'));
    expect(html).not.toContain(i18nService.t('remoteSessionSyncFailed'));
    click(button('remoteReconnect'));
    expect(harness.submit.mock.calls).toEqual([[{ retry: true }]]);
    harness.snapshot.state = { ...connected };
    const recovered = render();
    expect(recovered.html).not.toContain(i18nService.t('remoteHistoryAdmissionDeferred'));
    expect(recovered.button('remoteReconnect')).toBeUndefined();
  });

  test('safety-blocked tasks expose their status without offering a bypass', () => {
    harness.snapshot.state = { ...connected, syncHealth: { status: RemoteSyncHealthStatus.Degraded, failedSessions: 1,
      pendingSessions: 1, oldestPendingAt: null, lastSuccessfulSyncAt: null, observedAt: '2026-09-23T00:00:00Z',
      taskIssues: [{ localSessionId: 'task-1', title: 'Protected task', status: RemoteSyncTaskIssueStatus.Isolated, retryable: false }] } };
    const { html, button } = render();
    expect(html).toContain(i18nService.t('remoteTaskSyncIsolated'));
    expect(button('remoteRetryTask')).toBeUndefined();
    click(render().taskButton('Protected task'));
    expect(harness.openTask).toHaveBeenCalledExactlyOnceWith({ kind: OwnershipTargetKind.Task, id: 'task-1' });
    expect(harness.submit).not.toHaveBeenCalled();
    harness.snapshot.state = { ...harness.snapshot.state, owner: null };
    expect(render().html).not.toContain('Protected task');
  });

  test('a task details button captured before an account change cannot open a stale target', () => {
    harness.snapshot.state = { ...connected, syncHealth: { status: RemoteSyncHealthStatus.Degraded, failedSessions: 1,
      pendingSessions: 1, oldestPendingAt: null, lastSuccessfulSyncAt: null, observedAt: '2026-09-23T00:00:00Z',
      taskIssues: [{ localSessionId: 'task-1', status: RemoteSyncTaskIssueStatus.Retrying, retryable: true }] } };
    const retry = render().taskButton(i18nService.t('remoteUnnamedTask'));
    harness.snapshot.state = { ...connected, accountEpoch: 'epoch-b', owner: { userId: 'user-b', scopeKey: 'personal' } };
    click(retry);
    expect(harness.openTask).not.toHaveBeenCalled();
    expect(harness.submit).not.toHaveBeenCalled();
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
    expect(html).not.toContain(i18nService.t('remoteSyncPaused'));
    expect(html).not.toContain(i18nService.t('remoteContentSyncing'));
    expect(button('remoteReconnect')).toBeDefined();
    harness.snapshot.state = { ...harness.snapshot.state, connected: true, connectionStatus: RemoteConnectionStatus.Online,
      connectionReason: undefined };
    const recovered = render();
    expect(recovered.html).not.toContain(i18nService.t('remoteContentSyncing'));
    expect(recovered.html).not.toContain('<details');
    expect(recovered.html).not.toContain(i18nService.t('remoteSyncPaused'));
  });

  test.each([
    [{ agentCatalogSyncStatus: RemoteSyncStatus.Error }, 'remoteAgentCatalogSyncFailed'],
    [{ syncHealth: { status: RemoteSyncHealthStatus.Degraded, lanes: { control: RemoteSyncLaneStatus.Backoff }, pendingSessions: 1,
      oldestPendingAt: null, lastSuccessfulSyncAt: null, observedAt: '2026-10-27T00:00:00Z' } }, 'remoteControlSyncFailed'],
  ] as const)('keeps the device online and preserves catalog/control recovery: %j', (failure, message) => {
    harness.snapshot.state = { ...connected, ...failure, connectionReason: RemoteConnectionReason.Connecting };
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


test.each([true, false])('offers explicit registration recovery for retired devices (enabled=%s), never resume', enabled => {
  harness.snapshot.state = { ...connected, enabled, connected: false, errorCode: 47023, connectionReason: RemoteConnectionReason.Removed };
  const { html, button } = render();
  expect(html).toContain(i18nService.t('remoteDeviceRetired'));
  expect(html).toContain(i18nService.t('remoteReregisterHelp'));
  expect(button('remoteReconnect')).toBeUndefined();
  click(button('remoteReregister'));
  expect(harness.submit.mock.calls).toEqual([[{ reregister: true }]]);
  expect(harness.resume).not.toHaveBeenCalled();
});

test('disables registration recovery while a settings operation is pending', () => {
  harness.snapshot.state = { ...connected, connected: false, errorCode: 47023 };
  harness.snapshot.busy = true;
  expect(render().button('remoteReregister')?.disabled).toBe(true);
});
