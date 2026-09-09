import { describe, expect, test, vi } from 'vitest';

import { RemoteConnectionReason, RemoteConnectionStatus, type RemoteSettingsState } from '../../../shared/remote/constants';
import { editRemoteSettingsDraft, isNewRemoteState, isRemoteOnline, needsRemoteSignIn, normalizeRemoteDeviceName, reconcileRemoteSettingsDraft, remoteConnectionDescription, remoteConnectionFailure, remoteOwnerKey, remoteSettingsSwitchChecked, saveRemoteSettingsDraft, toggleRemoteSettingsSwitch } from './remoteControlState';

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
    const staleDraft = { ownerKey: remoteOwnerKey(connected), changes: { enabled: true, keepAwakeEnabled: true } };
    for (const state of [null, { ...connected, owner: null, keepAwakeEnabled: true }]) {
      expect(remoteSettingsSwitchChecked(state, staleDraft, 'enabled')).toBe(false);
      expect(remoteSettingsSwitchChecked(state, staleDraft, 'keepAwakeEnabled')).toBe(false);
    }
  });

  test('authenticated defaults preserve each saved false value and only accept the current owner draft', () => {
    expect(remoteSettingsSwitchChecked(connected, null, 'enabled')).toBe(true);
    expect(remoteSettingsSwitchChecked(connected, null, 'keepAwakeEnabled')).toBe(true);
    const saved = { ...connected, enabled: false, keepAwakeEnabled: false };
    expect(remoteSettingsSwitchChecked(saved, null, 'enabled')).toBe(false);
    expect(remoteSettingsSwitchChecked(saved, null, 'keepAwakeEnabled')).toBe(false);
    const draft = editRemoteSettingsDraft(null, saved, { enabled: true });
    expect(remoteSettingsSwitchChecked(saved, draft, 'enabled')).toBe(true);
    expect(remoteSettingsSwitchChecked(saved, draft, 'keepAwakeEnabled')).toBe(false);
    const otherOwner = { ...saved, owner: { userId: 'user-b', scopeKey: 'personal' } };
    expect(remoteSettingsSwitchChecked(otherOwner, draft, 'enabled')).toBe(false);
  });

  test.each(['enabled', 'keepAwakeEnabled'] as const)('%s requests login without editing until an authenticated state arrives', setting => {
    const onLogin = vi.fn();
    const onEdit = vi.fn();
    toggleRemoteSettingsSwitch(null, null, setting, onLogin, onEdit);
    expect(onLogin).not.toHaveBeenCalled();
    for (const state of [{ ...connected, owner: null }, { ...connected, enabled: false, keepAwakeEnabled: false, errorCode: 401 }]) {
      toggleRemoteSettingsSwitch(state, null, setting, onLogin, onEdit);
      expect(remoteSettingsSwitchChecked(state, null, setting)).toBe(false);
    }
    expect(onLogin).toHaveBeenCalledTimes(2);
    expect(onEdit).not.toHaveBeenCalled();
    // Successful browser handoff has not changed the account state or saved preferences.
    const saved = { ...connected, enabled: false, keepAwakeEnabled: false };
    expect(remoteSettingsSwitchChecked(saved, null, setting)).toBe(false);
    toggleRemoteSettingsSwitch(saved, null, setting, onLogin, onEdit);
    expect(onEdit).toHaveBeenCalledExactlyOnceWith({ [setting]: true });
    expect(onLogin).toHaveBeenCalledTimes(2);
  });

  test.each(['enabled', 'keepAwakeEnabled'] as const)('%s preserves an expired account preference and still allows switching it off', setting => {
    const expired = { ...connected, keepAwakeEnabled: true, errorCode: 40100 };
    const onLogin = vi.fn();
    const onEdit = vi.fn();
    expect(remoteSettingsSwitchChecked(expired, null, setting)).toBe(true);
    toggleRemoteSettingsSwitch(expired, null, setting, onLogin, onEdit);
    expect(onEdit).toHaveBeenCalledExactlyOnceWith({ [setting]: false });
    expect(onLogin).not.toHaveBeenCalled();
    const draft = editRemoteSettingsDraft(null, expired, { [setting]: false });
    expect(remoteSettingsSwitchChecked(expired, draft, setting)).toBe(false);
    toggleRemoteSettingsSwitch(expired, draft, setting, onLogin, onEdit);
    expect(onLogin).toHaveBeenCalledOnce();
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  test('authenticated toggles remain drafts that can be reverted or saved off', async () => {
    const onLogin = vi.fn();
    let draft = null as ReturnType<typeof editRemoteSettingsDraft>;
    const onEdit = (changes: Parameters<typeof editRemoteSettingsDraft>[2]) => { draft = editRemoteSettingsDraft(draft, connected, changes); };
    toggleRemoteSettingsSwitch(connected, draft, 'enabled', onLogin, onEdit);
    toggleRemoteSettingsSwitch(connected, draft, 'keepAwakeEnabled', onLogin, onEdit);
    expect(draft?.changes).toEqual({ enabled: false, keepAwakeEnabled: false });
    const api = { state: vi.fn(async () => connected), configure: vi.fn(async () => connected) };
    expect(api.configure).not.toHaveBeenCalled();
    await saveRemoteSettingsDraft(draft, api);
    expect(api.configure).toHaveBeenCalledExactlyOnceWith({ enabled: false, keepAwakeEnabled: false });
    toggleRemoteSettingsSwitch(connected, draft, 'enabled', onLogin, onEdit);
    toggleRemoteSettingsSwitch(connected, draft, 'keepAwakeEnabled', onLogin, onEdit);
    expect(draft).toBeNull();
    expect(onLogin).not.toHaveBeenCalled();
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


describe('remote preferences are saved by the settings form', () => {
  test('edits merge in a draft, leave live preferences unchanged and disappear when discarded', async () => {
    const api = { state: vi.fn(async () => connected), configure: vi.fn(async () => connected) };
    let draft = editRemoteSettingsDraft(null, connected, { enabled: false });
    draft = editRemoteSettingsDraft(draft, connected, { keepAwakeEnabled: false, name: 'Draft name' });
    expect(draft?.changes).toEqual({ enabled: false, keepAwakeEnabled: false, name: 'Draft name' });
    expect(connected.enabled).toBe(true); expect(connected.name).toBe('Computer');
    expect(api.configure).not.toHaveBeenCalled();
    draft = null; // Cancel/close discards form state; there is no compensating server mutation.
    await saveRemoteSettingsDraft(draft, api);
    expect(api.state).not.toHaveBeenCalled(); expect(api.configure).not.toHaveBeenCalled();
  });

  test('live connection updates preserve unsaved changes across tab unmounts', () => {
    const draft = editRemoteSettingsDraft(null, connected, { enabled: false, name: 'Draft' });
    expect(reconcileRemoteSettingsDraft(draft, { ...connected, connected: false, stateRevision: 11 })).toBe(draft);
    // An in-flight configure may publish local preferences before ultimately failing.
    expect(reconcileRemoteSettingsDraft(draft, { ...connected, enabled: false, name: 'Draft' })).toBe(draft);
    expect(reconcileRemoteSettingsDraft(draft, { ...connected, owner: null })).toBeNull();
    expect(reconcileRemoteSettingsDraft(draft, { ...connected, owner: { userId: 'user-b', scopeKey: 'personal' } })).toBeNull();
    expect(reconcileRemoteSettingsDraft(draft, { ...connected, owner: { userId: 'user-a', scopeKey: 'enterprise:1' } })).toBeNull();
  });

  test('only submits accumulated settings at save, including edits made before switching tabs', async () => {
    const api = { state: vi.fn(async () => connected), configure: vi.fn(async () => connected) };
    const draft = editRemoteSettingsDraft(null, connected, { enabled: false, keepAwakeEnabled: false, name: 'Work' });
    await saveRemoteSettingsDraft(draft, api);
    expect(api.configure).toHaveBeenCalledExactlyOnceWith({ enabled: false, keepAwakeEnabled: false, name: 'Work' });
  });

  test('a failed save preserves the draft for retry and reports a localized error key', async () => {
    const draft = editRemoteSettingsDraft(null, connected, { name: 'Work' });
    const api = { state: vi.fn(async () => connected), configure: vi.fn().mockRejectedValueOnce(new Error('internal')).mockResolvedValue(connected) };
    await expect(saveRemoteSettingsDraft(draft, api)).rejects.toThrow('remoteSaveFailed');
    expect(draft?.changes).toEqual({ name: 'Work' });
    await expect(saveRemoteSettingsDraft(draft, api)).resolves.toBeUndefined();
    expect(api.configure).toHaveBeenCalledTimes(2);
  });

  test('does not apply an old account draft after switching accounts or signing out', async () => {
    const draft = editRemoteSettingsDraft(null, connected, { enabled: false });
    const api = { state: vi.fn(async () => ({ ...connected, owner: null })), configure: vi.fn(async () => connected) };
    await expect(saveRemoteSettingsDraft(draft, api)).rejects.toThrow('remoteAccountChanged');
    expect(api.configure).not.toHaveBeenCalled();
  });

  test('reverting fields removes only those edits and keep-awake activation failures stay retryable', async () => {
    let draft = editRemoteSettingsDraft(null, connected, { enabled: false, name: 'Work' });
    draft = editRemoteSettingsDraft(draft, connected, { enabled: true });
    expect(draft?.changes).toEqual({ name: 'Work' });
    expect(editRemoteSettingsDraft(draft, connected, { name: 'Computer' })).toBeNull();
    const failed = { ...connected, keepAwakeError: 'os error' };
    draft = editRemoteSettingsDraft(null, failed, { keepAwakeEnabled: true });
    const api = { state: vi.fn(async () => failed), configure: vi.fn(async () => failed) };
    await expect(saveRemoteSettingsDraft(draft, api)).rejects.toThrow('remoteKeepAwakeFailed');
    expect(draft?.changes.keepAwakeEnabled).toBe(true);
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
