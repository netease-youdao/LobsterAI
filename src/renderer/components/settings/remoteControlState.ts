import { type RemoteConfigureRequest, RemoteConnectionReason, RemoteConnectionStatus, type RemoteSettingsState } from '../../../shared/remote/constants';

export function remoteOwnerKey(state: RemoteSettingsState | null): string {
  return state?.owner ? JSON.stringify([state.owner.userId, state.owner.scopeKey]) : '';
}

export function isNewRemoteState(current: RemoteSettingsState | null, incoming: RemoteSettingsState): boolean {
  return !current || (incoming.stateRevision ?? 0) >= (current.stateRevision ?? 0);
}

export function isRemoteOnline(state: RemoteSettingsState | null): boolean {
  return Boolean(state?.owner && state.enabled && state.connected
    && state.connectionStatus !== RemoteConnectionStatus.Offline);
}

export function needsRemoteSignIn(state: RemoteSettingsState | null): boolean {
  return !state?.owner || state.errorCode === 401 || state.errorCode === 40100;
}

export function remoteConnectionDescription(state: RemoteSettingsState | null): string {
  if (!state) return 'remoteLoading';
  if (!state.owner) return 'remoteSignedOut';
  if (!state.enabled) return 'remoteDisabled';
  const failure = remoteConnectionFailure(state);
  if (failure) return failure;
  if (state.connectionReason === RemoteConnectionReason.WorkspaceUnavailable) return 'remoteWorkspaceUnavailable';
  if (isRemoteOnline(state)) return 'remoteCurrentDevice';
  if (state.errorCode === 47022) return 'remoteDeviceLimit';
  if (state.errorCode === 47021) return 'remoteRegistrationLimit';
  if (needsRemoteSignIn(state)) return 'remoteLoginExpired';
  const reasons: Record<string, string> = {
    [RemoteConnectionReason.Connecting]: 'remoteConnecting',
    [RemoteConnectionReason.Reconnecting]: 'remoteReconnecting',
    [RemoteConnectionReason.Disabled]: 'remoteDisabled',
    [RemoteConnectionReason.SignedOut]: 'remoteSignedOut',
    [RemoteConnectionReason.ServerUpgradeRequired]: 'remoteServerUpgradeRequired',
    [RemoteConnectionReason.ServerUnavailable]: 'remoteUnavailable',
    [RemoteConnectionReason.DeviceUnavailable]: 'remoteDeviceUnavailable',
    [RemoteConnectionReason.WorkspaceUnavailable]: 'remoteWorkspaceUnavailable',
  };
  return reasons[state.connectionReason ?? ''] ?? 'remoteOffline';
}

export function normalizeRemoteDeviceName(value: string): string | null {
  const name = value.trim();
  if (!name || name.length > 100 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return null;
  return name;
}


/** A failure remains visible while the bridge waits or retries; raw server errors stay out of UI. */
export function remoteConnectionFailure(state: RemoteSettingsState | null): string | null {
  if (!state?.owner || !state.enabled) return null;
  if (needsRemoteSignIn(state)) return 'remoteLoginExpired';
  if (state.errorCode === 47013) return 'remoteCredentialInvalid';
  if (state.errorCode === 47023) return 'remoteDeviceUnavailable';
  if (state.errorCode === 47022) return 'remoteDeviceLimit';
  if (state.errorCode === 47021) return 'remoteRegistrationLimit';
  if (state.connectionReason === RemoteConnectionReason.ServerUpgradeRequired) return 'remoteServerUpgradeRequired';
  if (state.connectionReason === RemoteConnectionReason.DeviceUnavailable) return 'remoteDeviceUnavailable';
  if (state.error || state.errorCode || state.connectionReason === RemoteConnectionReason.ServerUnavailable) return 'remoteUnavailable';
  return null;
}

export type RemoteSettingsChanges = Pick<RemoteConfigureRequest, 'enabled' | 'keepAwakeEnabled' | 'name'>;
export type RemoteSettingsSwitch = keyof Pick<RemoteSettingsChanges, 'enabled' | 'keepAwakeEnabled'>;

export function remoteSettingsSwitchChecked(state: RemoteSettingsState | null, setting: RemoteSettingsSwitch): boolean {
  if (!state?.owner) return false;
  return state[setting] ?? true;
}

/** Opening the login browser is not authentication; only a later state event can enable a switch. */
export function toggleRemoteSettingsSwitch(state: RemoteSettingsState | null, setting: RemoteSettingsSwitch,
  onLogin: () => void, onEdit: (changes: RemoteSettingsChanges) => void): void {
  if (!state) return;
  const checked = remoteSettingsSwitchChecked(state, setting);
  if (needsRemoteSignIn(state) && !checked) { onLogin(); return; }
  onEdit({ [setting]: !checked });
}
