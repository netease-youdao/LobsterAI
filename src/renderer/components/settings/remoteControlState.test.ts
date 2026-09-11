import { describe, expect, test, vi } from 'vitest';

import { RemoteConnectionReason, RemoteConnectionStatus, type RemoteSettingsState } from '../../../shared/remote/constants';
import { isNewRemoteState, isRemoteOnline, needsRemoteSignIn, normalizeRemoteDeviceName, remoteConnectionDescription, remoteConnectionFailure, remoteOwnerKey, remoteSettingsSwitchChecked, toggleRemoteSettingsSwitch } from './remoteControlState';

const connected: RemoteSettingsState = {
  enabled: true, connected: true, name: 'Computer', owner: { userId: 'user-a', scopeKey: 'personal' },
  workspaces: [], accessRequests: [], stateRevision: 10, connectionStatus: RemoteConnectionStatus.Online,
};

describe('remote settings state boundaries', () => {
  test('requires the current account, enabled preference and live connection to show online', () => {
    expect(isRemoteOnline(connected)).toBe(true);
    expect(isRemoteOnline({ ...connected, owner: null })).toBe(false);
    expect(isRemoteOnline({ ...connected, enabled: false })).toBe(false);
    expect(isRemoteOnline({ ...connected, connected: false })).toBe(false);
    expect(isRemoteOnline({ ...connected, connectionStatus: RemoteConnectionStatus.Offline })).toBe(false);
    expect(isRemoteOnline(null)).toBe(false);
  });

  test('a delayed initial read cannot restore an old account after a newer sign-out event', () => {
    const signedOut = { ...connected, owner: null, connected: false, stateRevision: 11 };
    expect(isNewRemoteState(signedOut, connected)).toBe(false);
    expect(isNewRemoteState(connected, signedOut)).toBe(true);
    expect(isNewRemoteState(signedOut, { ...connected, stateRevision: 12 })).toBe(true);
    expect(isNewRemoteState(signedOut, { ...connected, stateRevision: undefined })).toBe(false);
  });

  test('rename identity distinguishes users and personal/team scopes', () => {
    expect(remoteOwnerKey(connected)).not.toBe(remoteOwnerKey({ ...connected, owner: { userId: 'user-b', scopeKey: 'personal' } }));
    expect(remoteOwnerKey(connected)).not.toBe(remoteOwnerKey({ ...connected, owner: { userId: 'user-a', scopeKey: 'team:1' } }));
    expect(remoteOwnerKey({ ...connected, owner: null })).toBe('');
  });

  test('connection feedback distinguishes connecting, disabled and quota failures', () => {
    const offline = { ...connected, connected: false, connectionStatus: RemoteConnectionStatus.Offline };
    expect(remoteConnectionDescription({ ...offline, connectionReason: RemoteConnectionReason.Connecting })).toBe('remoteConnecting');
    expect(remoteConnectionDescription({ ...offline, connectionReason: RemoteConnectionReason.ServerUpgradeRequired })).toBe('remoteServerUpgradeRequired');
    expect(remoteConnectionDescription({ ...connected, connectionReason: RemoteConnectionReason.WorkspaceUnavailable })).toBe('remoteWorkspaceUnavailable');
    expect(remoteConnectionDescription({ ...offline, errorCode: 47022 })).toBe('remoteDeviceLimit');
    expect(remoteConnectionDescription({ ...offline, errorCode: 47021 })).toBe('remoteRegistrationLimit');
    expect(remoteConnectionDescription({ ...offline, enabled: false, errorCode: 47022 })).toBe('remoteDisabled');
    expect(remoteConnectionDescription({ ...offline, owner: null })).toBe('remoteSignedOut');
    expect(remoteConnectionDescription({ ...offline, errorCode: 40100 })).toBe('remoteLoginExpired');
    expect(needsRemoteSignIn({ ...offline, errorCode: 401 })).toBe(true);
    expect(needsRemoteSignIn(connected)).toBe(false);
  });
});

describe('remote switches require a completed login', () => {
  test('loading and signed-out states show both switches off even with stale true values', () => {
    for (const state of [null, { ...connected, owner: null, keepAwakeEnabled: true }]) {
      expect(remoteSettingsSwitchChecked(state, 'enabled')).toBe(false);
      expect(remoteSettingsSwitchChecked(state, 'keepAwakeEnabled')).toBe(false);
    }
  });

  test('authenticated defaults preserve each saved false value', () => {
    expect(remoteSettingsSwitchChecked(connected, 'enabled')).toBe(true);
    expect(remoteSettingsSwitchChecked(connected, 'keepAwakeEnabled')).toBe(true);
    const saved = { ...connected, enabled: false, keepAwakeEnabled: false };
    expect(remoteSettingsSwitchChecked(saved, 'enabled')).toBe(false);
    expect(remoteSettingsSwitchChecked(saved, 'keepAwakeEnabled')).toBe(false);
  });

  test.each(['enabled', 'keepAwakeEnabled'] as const)('%s requests login without writing settings', setting => {
    const onLogin = vi.fn(); const onEdit = vi.fn();
    toggleRemoteSettingsSwitch(null, setting, onLogin, onEdit);
    expect(onLogin).not.toHaveBeenCalled();
    for (const state of [{ ...connected, owner: null }, { ...connected, enabled: false, keepAwakeEnabled: false, errorCode: 401 }]) {
      toggleRemoteSettingsSwitch(state, setting, onLogin, onEdit);
    }
    expect(onLogin).toHaveBeenCalledTimes(2);
    expect(onEdit).not.toHaveBeenCalled();
    // A browser handoff cannot overwrite an explicitly saved false preference.
    const saved = { ...connected, enabled: false, keepAwakeEnabled: false };
    expect(remoteSettingsSwitchChecked(saved, setting)).toBe(false);
    toggleRemoteSettingsSwitch(saved, setting, onLogin, onEdit);
    expect(onEdit).toHaveBeenCalledExactlyOnceWith({ [setting]: true });
  });

  test.each(['enabled', 'keepAwakeEnabled'] as const)('%s permits turning off after login expires but gates enabling', setting => {
    const expired = { ...connected, keepAwakeEnabled: true, errorCode: 40100 };
    const onLogin = vi.fn(); const onEdit = vi.fn();
    expect(remoteSettingsSwitchChecked(expired, setting)).toBe(true);
    toggleRemoteSettingsSwitch(expired, setting, onLogin, onEdit);
    expect(onEdit).toHaveBeenCalledExactlyOnceWith({ [setting]: false });
    const saved = { ...expired, [setting]: false };
    toggleRemoteSettingsSwitch(saved, setting, onLogin, onEdit);
    expect(onLogin).toHaveBeenCalledOnce();
  });
});

describe('device display names', () => {
  test('trims surrounding spaces without changing valid names', () => {
    expect(normalizeRemoteDeviceName('  我的工作电脑  ')).toBe('我的工作电脑');
    expect(normalizeRemoteDeviceName('BIH-L-X5116.local')).toBe('BIH-L-X5116.local');
  });

  test('rejects empty and control-character names, including controls that trim would remove', () => {
    for (const name of ['', '   ', '\nComputer', 'Computer\r', 'Com\tputer', 'Com\u0000puter', 'Com\u007fputer', 'Com\u0085puter']) {
      expect(normalizeRemoteDeviceName(name)).toBeNull();
    }
  });

  test('uses the API UTF-16 length limit without silently truncating', () => {
    expect(normalizeRemoteDeviceName('电'.repeat(100))).toHaveLength(100);
    expect(normalizeRemoteDeviceName('电'.repeat(101))).toBeNull();
    expect(normalizeRemoteDeviceName('🦞'.repeat(50))).toHaveLength(100);
    expect(normalizeRemoteDeviceName('🦞'.repeat(51))).toBeNull();
  });
});


describe('connection failure feedback', () => {
  test('credential failure wins over a reconnecting label and never exposes raw server data', () => {
    const failed = { ...connected, connected: false, errorCode: 47013, connectionReason: RemoteConnectionReason.Reconnecting, error: 'private device credential' };
    expect(remoteConnectionDescription(failed)).toBe('remoteCredentialInvalid');
    expect(remoteConnectionFailure(failed)).toBe('remoteCredentialInvalid');
    expect(remoteConnectionFailure({ ...failed, errorCode: 47023 })).toBe('remoteDeviceUnavailable');
  });

  test('network failures remain explicit until recovery while a genuine reconnect can show progress', () => {
    const offline = { ...connected, connected: false, connectionReason: RemoteConnectionReason.Reconnecting };
    expect(remoteConnectionFailure(offline)).toBeNull();
    expect(remoteConnectionDescription(offline)).toBe('remoteReconnecting');
    expect(remoteConnectionDescription({ ...offline, error: 'connect failed' })).toBe('remoteUnavailable');
    expect(remoteConnectionDescription({ ...offline, errorCode: 1006 })).toBe('remoteUnavailable');
    expect(remoteConnectionFailure(connected)).toBeNull();
    expect(remoteConnectionFailure({ ...offline, enabled: false, errorCode: 47013 })).toBeNull();
    expect(remoteConnectionDescription({ ...offline, connectionReason: undefined })).toBe('remoteOffline');
  });
});
