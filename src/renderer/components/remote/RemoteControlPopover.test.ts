import { QRCodeSVG } from 'qrcode.react';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { RemoteConnectionReason, RemoteConnectionStatus, type RemoteSettingsState, RemoteSyncHealthStatus, RemoteSyncStatus } from '../../../shared/remote/constants';
import * as endpoints from '../../services/endpoints';
import { i18nService } from '../../services/i18n';
import { getRemotePopoverPosition, RemoteControlPopover } from './RemoteControlPopover';

const harness = vi.hoisted(() => ({
  snapshot: { state: null as RemoteSettingsState | null, busy: false, error: null as string | null },
  submit: vi.fn(async () => true),
  buttons: [] as React.ButtonHTMLAttributes<HTMLButtonElement>[],
  switches: [] as Array<{ checked: boolean; disabled?: boolean; onClick: () => void | Promise<void> }>,
}));
vi.mock('../../services/remoteSettings', () => ({ remoteSettingsService: {
  getSnapshot: () => harness.snapshot,
  subscribe: () => () => undefined,
  submit: harness.submit,
  refresh: vi.fn(async () => undefined),
} }));
vi.mock('../settings/SettingsSwitch', () => ({ default: (props: {
  label: string; checked: boolean; disabled?: boolean; onClick: () => void | Promise<void>;
}) => {
  harness.switches.push(props);
  return React.createElement('button', { role: 'switch', 'aria-label': props.label, 'aria-checked': props.checked, disabled: props.disabled });
} }));

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
  const onClose = vi.fn(); const onLogin = vi.fn(); const onOpenDeviceManagement = vi.fn();
  const html = renderToStaticMarkup(React.createElement(RemoteControlPopover, {
    anchorRef: React.createRef<HTMLButtonElement>(), onClose, onLogin, loginAllowed, onOpenDeviceManagement,
  }));
  return { html, onClose, onLogin, onOpenDeviceManagement };
};

beforeEach(() => {
  harness.snapshot = { state: connected, busy: false, error: null };
  harness.switches = []; harness.buttons = [];
  harness.submit.mockClear();
  const logError = console.error;
  vi.spyOn(console, 'error').mockImplementation((message: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.includes('useLayoutEffect does nothing on the server')) return;
    logError(message, ...args);
  });
});
afterEach(() => vi.restoreAllMocks());

describe('mobile connection popover', () => {
  test('encodes exactly the public entry with a four-module QR quiet zone', () => {
    const entry = endpoints.getMobileAppEntry();
    const { html } = render();
    const qr = renderToStaticMarkup(React.createElement(QRCodeSVG, {
      value: entry.url, size: 160, marginSize: 4, bgColor: '#FFFFFF', fgColor: '#000000',
      title: `${i18nService.t('remoteQrOfficialSite')}: ${entry.url}`,
    }));
    expect(html).toContain(qr);
    expect(html).not.toContain('<a ');
    expect(html).not.toContain(i18nService.t('remoteCopyLink'));
    expect(html).not.toContain(i18nService.t('remoteRenameDevice'));
    expect(html).not.toContain(i18nService.t('remoteHowItWorks'));
    expect(html).not.toContain(i18nService.t('remoteAllowDescription'));
    expect(html).not.toContain(i18nService.t('remoteKeepAwakeDescription'));
    expect(html).not.toContain(i18nService.t('remoteQrAppDownloadHint'));
  });

  test('one entry configuration switches both formal download copy and QR target', () => {
    vi.spyOn(endpoints, 'getMobileAppEntry').mockReturnValue({
      kind: endpoints.MobileAppEntryKind.AppDownload, url: 'https://download.example.com/',
    });
    const { html } = render();
    expect(html).toContain('https://download.example.com/');
    expect(html).toContain(i18nService.t('remoteQrAppDownload'));
    expect(html).toContain(i18nService.t('remoteQrAppDownloadHint'));
  });

  test('signed-out switches initiate login without writing a preference or exposing the old alias', () => {
    harness.snapshot.state = { ...connected, owner: null, enabled: false };
    const { html, onLogin, onClose } = render();
    expect(html).not.toContain('Local host');
    expect(html).not.toContain('Private alias');
    expect(harness.switches.map(control => control.checked)).toEqual([false, false]);
    for (const control of harness.switches) { expect(control.disabled).toBe(false); void control.onClick(); }
    expect(onLogin).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(harness.submit).not.toHaveBeenCalled();
  });

  test('an existing false preference remains off and each click submits only its own field', () => {
    harness.snapshot.state = { ...connected, enabled: false, keepAwakeEnabled: false };
    render();
    expect(harness.switches.map(control => control.checked)).toEqual([false, false]);
    void harness.switches[0].onClick();
    void harness.switches[1].onClick();
    expect(harness.submit.mock.calls).toEqual([[{ enabled: true }], [{ keepAwakeEnabled: true }]]);
  });

  test('a stale account callback cannot submit using the new account epoch', () => {
    const { onClose, onLogin } = render();
    const staleSwitches = [...harness.switches];
    harness.snapshot.state = { ...connected, accountEpoch: 'epoch-b', owner: { userId: 'user-b', scopeKey: 'personal' } };
    for (const control of staleSwitches) void control.onClick();
    expect(harness.submit).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onLogin).not.toHaveBeenCalled();
  });

  test('expired sign-in still allows turning off an enabled setting', () => {
    harness.snapshot.state = { ...connected, errorCode: 401, connected: false };
    const { onLogin } = render();
    void harness.switches[0].onClick();
    expect(harness.submit).toHaveBeenCalledWith({ enabled: false });
    expect(onLogin).not.toHaveBeenCalled();
  });

  test('login policy hides the login action and disables signed-out setting changes', () => {
    harness.snapshot.state = { ...connected, owner: null };
    const { html } = render(false);
    expect(html).toContain(i18nService.t('remoteLoginUnavailable'));
    expect(harness.switches.every(control => control.disabled)).toBe(true);
    expect(harness.submit).not.toHaveBeenCalled();
  });

  test('offline choices remain checked while only actionable power errors are shown', () => {
    harness.snapshot.state = { ...connected, connected: false, connectionStatus: RemoteConnectionStatus.Offline,
      connectionReason: RemoteConnectionReason.Reconnecting, settingsSyncStatus: RemoteSyncStatus.Pending,
      keepAwakeActive: false, keepAwakeError: 'Power API error' };
    const { html } = render();
    expect(harness.switches.map(control => control.checked)).toEqual([true, true]);
    expect(html).not.toContain(i18nService.t('remoteSavedPending'));
    expect(html).toContain(i18nService.t('remoteKeepAwakeFailed'));
    expect(html).not.toContain(i18nService.t('remoteReconnect'));
    expect(html).not.toContain('Power API error');
  });

  test('quota failure adds a management link without exposing device metadata', () => {
    harness.snapshot.state = { ...connected, connected: false, errorCode: 47022 };
    const { html } = render();
    expect(html).toContain(i18nService.t('remoteQuotaAttention'));
    expect(html).toContain(i18nService.t('remoteDeviceManagement'));
    expect(html).not.toContain('Private alias');
  });

  test('content faults have a neutral management entry without a second task list or connection failure', () => {
    harness.snapshot.state = { ...connected, sessionSyncStatus: RemoteSyncStatus.Error,
      syncHealth: { status: RemoteSyncHealthStatus.Degraded, failedSessions: 1, pendingSessions: 1,
        oldestPendingAt: null, lastSuccessfulSyncAt: null, observedAt: '2026-10-27T00:00:00Z' } };
    const { html, onClose, onOpenDeviceManagement } = render();
    expect(html).toContain(i18nService.t('remoteTaskContentIncomplete'));
    expect(html).not.toContain('role="alert"'); expect(html).not.toContain('<details');
    expect(html).not.toContain(i18nService.t('remoteConnectionAttention'));
    expect(html).toContain('text-xs text-secondary');
    const details = harness.buttons.find(button => button.children === i18nService.t('remoteTaskContentViewDetails'));
    expect(details).toBeDefined(); details?.onClick?.({} as React.MouseEvent<HTMLButtonElement>);
    expect(onClose).toHaveBeenCalledOnce(); expect(onOpenDeviceManagement).toHaveBeenCalledOnce();
    expect(harness.submit).not.toHaveBeenCalled();
  });

  test('uncertain persistence still gets an explicit retry message', () => {
    harness.snapshot.error = 'remoteSettingsUnconfirmed';
    const { html } = render();
    expect(html).toContain(i18nService.t('remoteSettingsUnconfirmed'));
    expect(html).not.toContain(i18nService.t('remoteSameIdentityHelp'));
  });
});

describe('popover positioning', () => {
  test('opens above its anchor with the configured gap', () => {
    expect(getRemotePopoverPosition({ left: 160, top: 700 }, 540, { width: 1000, height: 800 }))
      .toEqual({ left: 160, top: 152, width: 320, maxHeight: 776 });
  });
  test('clamps narrow windows and tall contents inside the viewport', () => {
    const position = getRemotePopoverPosition({ left: 260, top: 400 }, 600, { width: 300, height: 440 });
    expect(position).toEqual({ left: 12, top: 12, width: 276, maxHeight: 416 });
  });
});
