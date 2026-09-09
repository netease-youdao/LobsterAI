import { CheckIcon, ComputerDesktopIcon, DevicePhoneMobileIcon, PencilSquareIcon, SunIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { RemoteConnectionReason, type RemoteSettingsState,RemoteSyncStatus } from '../../shared/remote/constants';
import { i18nService } from '../services/i18n';
import Modal from './common/Modal';
import { editRemoteSettingsDraft, isNewRemoteState, isRemoteOnline, needsRemoteSignIn, normalizeRemoteDeviceName, remoteConnectionDescription, remoteConnectionFailure, remoteOwnerKey, type RemoteSettingsChanges, type RemoteSettingsDraft, type RemoteSettingsSwitch, remoteSettingsSwitchChecked, toggleRemoteSettingsSwitch } from './settings/remoteControlState';
import SettingsSwitch from './settings/SettingsSwitch';

interface RemoteControlSettingsProps {
  onLogin: () => Promise<void>;
  draft: RemoteSettingsDraft | null;
  onDraftChange: React.Dispatch<React.SetStateAction<RemoteSettingsDraft | null>>;
  saving: boolean;
}

export function RemoteControlSettings({ onLogin, draft, onDraftChange, saving }: RemoteControlSettingsProps): React.ReactElement {
  const [state, setState] = useState<RemoteSettingsState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [renameOpen, setRenameOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [nameError, setNameError] = useState('');
  const latestState = useRef<RemoteSettingsState | null>(null);
  const mounted = useRef(false);
  const busyRef = useRef(false);
  const renameButton = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const renameDialog = useRef<HTMLDivElement>(null);
  const t = (key: string) => i18nService.t(key);

  const acceptState = useCallback((incoming: RemoteSettingsState) => {
    if (!mounted.current || !isNewRemoteState(latestState.current, incoming)) return;
    if (remoteOwnerKey(latestState.current) !== remoteOwnerKey(incoming)) {
      setRenameOpen(false);
      setNameDraft('');
      setNameError('');
      setFeedback('');
    } else if (incoming.nameSyncStatus === RemoteSyncStatus.Synced
      && latestState.current?.nameSyncStatus && latestState.current.nameSyncStatus !== RemoteSyncStatus.Synced) {
      setFeedback('remoteNameSaved');
    } else if (incoming.settingsSyncStatus === RemoteSyncStatus.Synced
      && latestState.current?.settingsSyncStatus && latestState.current.settingsSyncStatus !== RemoteSyncStatus.Synced) {
      setFeedback('remoteSettingsSaved');
    }
    latestState.current = incoming;
    setState(incoming);
    setError('');
  }, []);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = window.electron.remote.onChanged(acceptState);
    const refresh = async () => {
      try { acceptState(await window.electron.remote.state()); }
      catch { if (mounted.current) setError('remoteStateUnavailable'); }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 5000);
    return () => {
      mounted.current = false;
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [acceptState]);

  useEffect(() => {
    if (!renameOpen) return;
    nameInput.current?.focus();
    nameInput.current?.select();
  }, [renameOpen]);

  const closeRename = () => {
    if (busyRef.current || saving) return;
    setRenameOpen(false);
    setNameError('');
    renameButton.current?.focus();
  };

  const editDraft = (changes: RemoteSettingsChanges) => {
    if (!latestState.current || saving || busyRef.current) return;
    const current = latestState.current;
    onDraftChange(previous => editRemoteSettingsDraft(previous, current, changes));
    setError(''); setFeedback('');
  };

  const retry = async () => {
    if (busyRef.current || saving) return;
    const owner = remoteOwnerKey(latestState.current);
    busyRef.current = true; setBusy(true); setError('');
    try { acceptState(await window.electron.remote.configure({ retry: true })); }
    catch { if (mounted.current && owner === remoteOwnerKey(latestState.current)) setError('remoteReconnectFailed'); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };

  const saveName = () => {
    const name = normalizeRemoteDeviceName(nameDraft);
    if (!name) { setNameError('remoteNameInvalid'); return; }
    editDraft({ name });
    closeRename();
  };

  const startLogin = async () => {
    if (busyRef.current || saving) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try { await onLogin(); }
    catch { if (mounted.current) setError('remoteLoginFailed'); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };

  const toggleSwitch = (setting: RemoteSettingsSwitch) => {
    if (busyRef.current || saving) return;
    toggleRemoteSettingsSwitch(latestState.current, draft, setting, () => { void startLogin(); }, editDraft);
  };

  const locked = busy || saving;
  const changes = draft?.ownerKey === remoteOwnerKey(state) ? draft.changes : {};
  const enabledDraft = remoteSettingsSwitchChecked(state, draft, 'enabled');
  const keepAwakeDraft = remoteSettingsSwitchChecked(state, draft, 'keepAwakeEnabled');
  const connectionFailure = remoteConnectionFailure(state);
  const online = isRemoteOnline(state);
  const displayName = state?.owner ? (changes.name ?? (state.name || state.hostName)) : state?.hostName;
  const namePending = state?.nameSyncStatus === RemoteSyncStatus.Pending || state?.nameSyncStatus === RemoteSyncStatus.Error;
  const settingsPending = state?.settingsSyncStatus === RemoteSyncStatus.Pending || state?.settingsSyncStatus === RemoteSyncStatus.Error;

  return <div className="space-y-7" data-remote-control-settings="true">
    <p className="max-w-2xl text-sm leading-6 text-secondary">{t('remoteDescription')}</p>
    <div className="divide-y divide-border rounded-xl border border-border bg-surface">
      <div className="px-4 py-5">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary-muted text-primary">
            <DevicePhoneMobileIcon className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-4">
              <h4 className="text-sm font-medium text-foreground">{t('remoteAllowConnection')}</h4>
              <SettingsSwitch label={t('remoteAllowConnection')} checked={enabledDraft}
                disabled={locked || !state} onClick={() => toggleSwitch('enabled')} />
            </div>
            <p className="mt-1.5 text-sm leading-5 text-secondary">{t('remoteAllowDescription')}</p>
            {state && needsRemoteSignIn(state) && <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-secondary">
              <span>{t(state.owner ? 'remoteLoginExpired' : 'remoteLoginRequired')}</span>
              <button type="button" disabled={locked} className="text-primary hover:underline disabled:opacity-50"
                onClick={() => { void startLogin(); }}>{t('login')}</button>
            </div>}
          </div>
        </div>
      </div>
      <div className="px-4 py-5">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
            <SunIcon className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-4">
              <h4 className="text-sm font-medium text-foreground">{t('remoteKeepAwake')}</h4>
              <SettingsSwitch label={t('remoteKeepAwake')} checked={keepAwakeDraft}
                disabled={locked || !state} onClick={() => toggleSwitch('keepAwakeEnabled')} />
            </div>
            <p className="mt-1.5 text-sm leading-5 text-secondary">{t('remoteKeepAwakeDescription')}</p>
            {state?.keepAwakeError && <div role="alert" className="mt-2 flex items-center gap-2 text-xs text-amber-700 dark:text-amber-400">
              <span>{t(state.keepAwakeEnabled ? 'remoteKeepAwakeFailed' : 'remoteKeepAwakeDisableFailed')}</span>
              {!needsRemoteSignIn(state) && <button type="button" disabled={locked} className="text-primary hover:underline disabled:opacity-50"
                onClick={() => { editDraft({ keepAwakeEnabled: keepAwakeDraft }); }}>{t('remoteRetryOnSave')}</button>}
            </div>}
          </div>
        </div>
      </div>
    </div>

    <section aria-labelledby="remote-device-heading" className="space-y-3">
      <h4 id="remote-device-heading" className="text-sm font-medium text-foreground">{t('remoteThisComputer')}</h4>
      <div className="rounded-xl border border-border bg-surface px-4 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border text-foreground">
            <ComputerDesktopIcon className="h-5 w-5" aria-hidden="true" />
            <span aria-hidden="true" className={`absolute -right-0.5 top-0 h-2.5 w-2.5 rounded-full border-2 border-surface ${online ? 'bg-emerald-500' : 'bg-gray-400'}`} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 [overflow-wrap:anywhere] text-sm font-medium text-foreground" title={displayName} data-remote-device-name="true">{displayName || t('remoteThisComputer')}</p>
            <p className="mt-1 text-xs text-secondary">{t('remoteCurrentDevice')}{state?.owner ? ` · ${t(state.owner.scopeKey === 'personal' ? 'remotePersonalAccount' : 'remoteTeamAccount')}` : ''}</p>
          </div>
          <button type="button" ref={renameButton} disabled={!state?.owner || locked}
            className="flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-primary hover:bg-primary-muted disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => { setNameDraft(displayName || ''); setNameError(''); setRenameOpen(true); }}>
            <PencilSquareIcon className="h-4 w-4" aria-hidden="true" />{t('rename')}
          </button>
        </div>
        <div className="mt-4 border-t border-border pt-3" role="status" aria-live="polite">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className={`inline-flex items-center gap-1.5 font-medium ${online ? 'text-emerald-600 dark:text-emerald-400' : 'text-secondary'}`}>
              <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${online ? 'bg-emerald-500' : 'bg-gray-400'}`} />
              {t(online ? 'remoteOnline' : connectionFailure ? 'remoteConnectionFailed' : 'remoteOffline')}
            </span>
            {(!connectionFailure && (!online || state?.connectionReason === RemoteConnectionReason.WorkspaceUnavailable)) && <span className="text-secondary">{t(remoteConnectionDescription(state))}</span>}
            {online && state?.screenLocked === true && <span className="text-secondary">{t('remoteScreenLocked')}</span>}
            {namePending && <span className="text-secondary">{t('remoteNamePending')}</span>}
            {settingsPending && <span className="text-secondary">{t(state?.enabled ? 'remoteSettingsPending' : 'remoteDisabledPending')}</span>}
            {state?.owner && !online && state.enabled && !needsRemoteSignIn(state) && <button type="button" disabled={locked}
              className="ml-auto text-primary hover:underline disabled:opacity-50" onClick={() => { void retry(); }}>{t('remoteReconnect')}</button>}
          </div>
          {connectionFailure && <p role="alert" className="mt-2 text-xs leading-5 text-red-600 dark:text-red-400">{t(connectionFailure)}</p>}
        </div>
      </div>
      <p className="text-xs leading-5 text-secondary">{t('remoteHistoryScope')}</p>
    </section>

    {draft && <p role="status" className="text-xs text-secondary">{t('remoteUnsavedChanges')}</p>}
    {feedback && <div className="flex items-center gap-1.5 text-xs text-secondary" role="status" aria-live="polite">
      <CheckIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{t(feedback)}</span>
    </div>}
    {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{t(error)}</p>}

    <Modal isOpen={renameOpen} onClose={closeRename} onEscape={closeRename}
      overlayClassName="fixed inset-0 z-[60] modal-backdrop flex items-center justify-center p-4"
      className="w-full max-w-md rounded-2xl border border-border bg-background p-6 shadow-modal">
      <div ref={renameDialog} role="dialog" aria-modal="true" aria-labelledby="remote-rename-heading"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && event.target === nameInput.current && !event.nativeEvent.isComposing) {
            event.preventDefault(); event.stopPropagation(); void saveName();
          }
          if (event.key !== 'Tab') return;
          const focusable = renameDialog.current?.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)');
          if (!focusable?.length) { event.preventDefault(); return; }
          const first = focusable[0]; const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }}>
        <h3 id="remote-rename-heading" className="text-base font-semibold text-foreground">{t('remoteRenameDevice')}</h3>
        <label htmlFor="remote-device-name" className="mb-2 mt-5 block text-sm text-foreground">{t('remoteDeviceName')}</label>
        <input id="remote-device-name" ref={nameInput} value={nameDraft} disabled={locked}
          aria-invalid={Boolean(nameError)} aria-describedby={nameError ? 'remote-name-error' : 'remote-name-hint'}
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          onChange={(event) => { setNameDraft(event.target.value); setNameError(''); }} />
        <p id="remote-name-hint" className="mt-2 text-xs leading-5 text-secondary">{t('remoteRenameHint')}</p>
        {nameError && <p id="remote-name-error" role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{t(nameError)}</p>}
        <div className="mt-6 flex justify-end gap-3">
          <button type="button" disabled={locked} onClick={closeRename}
            className="rounded-xl border border-border px-4 py-2 text-sm text-foreground hover:bg-surface-raised disabled:opacity-50">{t('cancel')}</button>
          <button type="button" disabled={locked} onClick={() => { void saveName(); }}
            className="rounded-xl bg-primary px-4 py-2 text-sm text-white hover:bg-primary-hover disabled:opacity-50">{t('confirm')}</button>
        </div>
      </div>
    </Modal>
  </div>;
}
