import { ChevronRightIcon, ComputerDesktopIcon, PencilSquareIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useSelector } from 'react-redux';

import { type RemoteConfigureRequest, RemoteConnectionReason, RemoteSyncStatus } from '../../../shared/remote/constants';
import { i18nService } from '../../services/i18n';
import { remoteSettingsService } from '../../services/remoteSettings';
import type { RootState } from '../../store';
import Modal from '../common/Modal';
import { isRemoteOnline, needsRemoteSignIn, normalizeRemoteDeviceName, remoteConnectionDescription, remoteConnectionFailure } from '../settings/remoteControlState';

interface RemoteDeviceSettingsProps {
  onLogin: () => void;
  loginAllowed: boolean;
}

const t = (key: string) => i18nService.t(key);
const DeviceAction = { Rename: 'rename', Retry: 'retry' } as const;
type DeviceAction = typeof DeviceAction[keyof typeof DeviceAction];
const ACTION_CLASS = 'text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50';

export function RemoteDeviceSettings({ onLogin, loginAllowed }: RemoteDeviceSettingsProps): React.ReactElement {
  const { state, busy, error } = useSyncExternalStore(
    remoteSettingsService.subscribe, remoteSettingsService.getSnapshot, remoteSettingsService.getSnapshot,
  );
  const accountGeneration = useSelector((root: RootState) => root.auth.accountGeneration);
  const id = useId();
  const renameButton = useRef<HTMLButtonElement>(null);
  const renameDialog = useRef<HTMLDivElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const requestGeneration = useRef(0);
  const previousAccountGeneration = useRef(accountGeneration);
  const [renameOpen, setRenameOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [nameError, setNameError] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [activeAction, setActiveAction] = useState<DeviceAction | null>(null);
  const [feedback, setFeedback] = useState('');
  const [actionError, setActionError] = useState('');
  const identity = JSON.stringify([accountGeneration, state?.accountEpoch, state?.owner?.userId, state?.owner?.scopeKey]);
  const online = isRemoteOnline(state);
  const signInRequired = needsRemoteSignIn(state);
  const connectionFailure = remoteConnectionFailure(state);
  const displayName = state?.owner ? state.name || state.hostName : state?.hostName;
  const statusKey = state?.owner && signInRequired ? 'remoteLoginExpired' : online ? 'remoteOnline' : remoteConnectionDescription(state);
  const namePending = state?.nameSyncStatus === RemoteSyncStatus.Pending || state?.nameSyncStatus === RemoteSyncStatus.Error;
  const settingsPending = state?.settingsSyncStatus === RemoteSyncStatus.Pending || state?.settingsSyncStatus === RemoteSyncStatus.Error;
  const displayedError = error || actionError;
  const canRename = Boolean(state?.owner && state.accountEpoch && !busy && !signInRequired && !displayedError);

  useLayoutEffect(() => {
    requestGeneration.current++;
    setRenameOpen(false); setNameDraft(''); setNameError('');
    setFeedback(''); setActionError(''); setActiveAction(null);
  }, [identity]);

  useEffect(() => {
    mounted.current = true;
    requestGeneration.current++;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (previousAccountGeneration.current === accountGeneration) return;
    previousAccountGeneration.current = accountGeneration;
    void remoteSettingsService.refresh();
  }, [accountGeneration]);

  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(''), 2500);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  useEffect(() => {
    if (!renameOpen) return;
    nameInput.current?.focus();
    nameInput.current?.select();
  }, [renameOpen]);

  const closeRename = () => {
    setRenameOpen(false); setNameDraft(''); setNameError('');
    renameButton.current?.focus();
  };

  const refresh = () => {
    if (busy) return;
    setActionError('');
    void remoteSettingsService.refresh();
  };

  const submit = async (changes: RemoteConfigureRequest, action: DeviceAction): Promise<boolean> => {
    const snapshot = remoteSettingsService.getSnapshot();
    if (busy || snapshot.busy || !state?.owner || !state.accountEpoch || signInRequired
      || state.accountEpoch !== snapshot.state?.accountEpoch) return false;
    if (displayedError) { refresh(); return false; }
    const generation = requestGeneration.current;
    const epoch = state.accountEpoch;
    setActiveAction(action); setFeedback(''); setActionError('');
    try {
      const saved = await remoteSettingsService.submit(changes);
      const current = remoteSettingsService.getSnapshot().state;
      if (!mounted.current || generation !== requestGeneration.current || epoch !== current?.accountEpoch) return false;
      if (saved && action === DeviceAction.Rename) {
        const pending = current?.nameSyncStatus === RemoteSyncStatus.Pending || current?.nameSyncStatus === RemoteSyncStatus.Error;
        setFeedback(pending ? 'remoteNamePending' : 'remoteNameSaved');
      }
      return saved;
    } catch {
      if (mounted.current && generation === requestGeneration.current) setActionError('remoteSaveFailed');
      return false;
    } finally {
      if (mounted.current && generation === requestGeneration.current) setActiveAction(null);
    }
  };

  const saveName = async () => {
    if (!canRename) return;
    const name = normalizeRemoteDeviceName(nameDraft);
    if (!name) { setNameError('remoteNameInvalid'); return; }
    if (await submit({ name }, DeviceAction.Rename)) closeRename();
  };

  return <div className="space-y-5">
    <p className="text-sm leading-6 text-secondary">{t('remoteDeviceManagementDescription')}</p>
    <section className="rounded-xl border border-border bg-surface p-5" aria-labelledby={`${id}-computer`}>
      <h3 id={`${id}-computer`} className="mb-4 text-sm font-medium">{t('remoteThisComputer')}</h3>
      <div className="flex items-center gap-3">
        <ComputerDesktopIcon className="h-6 w-6 shrink-0 text-secondary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={displayName} data-remote-device-name="true">{displayName || t('remoteThisComputer')}</p>
          <p className="mt-1 text-xs leading-5 text-secondary" role="status">
            <span className={online && !signInRequired ? 'text-emerald-600 dark:text-emerald-400' : undefined}>{t(statusKey)}</span>
            {state?.owner && ` · ${t(state.owner.scopeKey === 'personal' ? 'remotePersonalAccount' : 'remoteTeamAccount')}`}
          </p>
        </div>
        <button ref={renameButton} type="button" title={t('remoteRenameDevice')} aria-label={t('remoteRenameDevice')} disabled={!canRename}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-secondary hover:bg-surface-raised disabled:opacity-40"
          onClick={() => { if (!canRename) return; setNameDraft(displayName || ''); setNameError(''); setRenameOpen(true); }}>
          <PencilSquareIcon className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <div className="mt-3 space-y-2 text-xs leading-5">
        {connectionFailure && connectionFailure !== statusKey && <p role="alert" className="text-red-600 dark:text-red-400">{t(connectionFailure)}</p>}
        {online && state?.connectionReason === RemoteConnectionReason.WorkspaceUnavailable && <p className="text-secondary">{t('remoteWorkspaceUnavailable')}</p>}
        {online && state?.screenLocked && <p className="text-secondary">{t('remoteScreenLocked')}</p>}
        {namePending && <p className="text-secondary">{t('remoteNamePending')}</p>}
        {settingsPending && <p className="text-secondary">{t(state?.enabled ? 'remoteSavedPending' : 'remoteDisabledPending')}</p>}
        {feedback && <p role="status" className="text-secondary">{t(feedback)}</p>}
        {state && signInRequired && (loginAllowed
          ? <button type="button" disabled={busy} className={ACTION_CLASS} onClick={() => { if (!busy) onLogin(); }}>{t('login')}</button>
          : <p className="text-secondary">{t('remoteLoginUnavailable')}</p>)}
        {state?.owner && state.enabled && !online && !signInRequired && state.connectionReason !== RemoteConnectionReason.Connecting
          && <button type="button" disabled={busy} className={ACTION_CLASS} onClick={() => { void submit({ retry: true }, DeviceAction.Retry); }}>
            {t(busy && activeAction === DeviceAction.Retry ? 'remoteReconnecting' : 'remoteReconnect')}
          </button>}
        {displayedError && <div role="alert" className="text-red-600 dark:text-red-400">
          <p>{t(displayedError)}</p>
          <button type="button" disabled={busy} className={ACTION_CLASS} onClick={refresh}>{t('retry')}</button>
        </div>}
      </div>
    </section>
    <section className="rounded-xl border border-border p-5">
      <button type="button" className="flex w-full items-center gap-2 text-sm text-secondary hover:text-foreground" aria-expanded={helpOpen} aria-controls={`${id}-help`} onClick={() => setHelpOpen(value => !value)}>
        <ChevronRightIcon className={`h-4 w-4 transition-transform ${helpOpen ? 'rotate-90' : ''}`} aria-hidden="true" />{t('remoteHowItWorks')}
      </button>
      {helpOpen && <div id={`${id}-help`} className="mt-3 space-y-3 text-sm leading-6 text-secondary">
        <p>{t('remoteSameIdentityHelp')}</p><p>{t('remoteHistoryHelp')}</p><p>{t('remoteAwakeHelp')}</p>
      </div>}
    </section>
    <Modal isOpen={renameOpen} onClose={closeRename} onEscape={closeRename}
      overlayClassName="fixed inset-0 z-[60] modal-backdrop flex items-center justify-center p-4"
      className="w-full max-w-md rounded-2xl border border-border bg-background p-6 shadow-modal">
      <div ref={renameDialog} role="dialog" aria-modal="true" aria-labelledby={`${id}-rename-title`}
        onKeyDown={event => {
          if (event.key === 'Enter' && event.target === nameInput.current && !event.nativeEvent.isComposing) {
            event.preventDefault(); void saveName();
          }
          if (event.key !== 'Tab') return;
          const focusable = renameDialog.current?.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)');
          if (!focusable?.length) { event.preventDefault(); return; }
          const first = focusable[0]; const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }}>
        <h3 id={`${id}-rename-title`} className="text-base font-semibold">{t('remoteRenameDevice')}</h3>
        <label htmlFor={`${id}-device-name`} className="mb-2 mt-5 block text-sm">{t('remoteDeviceName')}</label>
        <input id={`${id}-device-name`} ref={nameInput} value={nameDraft} disabled={busy || !canRename}
          aria-invalid={Boolean(nameError)} aria-describedby={`${id}-${nameError ? 'name-error' : 'name-hint'}`}
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          onChange={event => { setNameDraft(event.target.value); setNameError(''); }} />
        <p id={`${id}-name-hint`} className="mt-2 text-xs leading-5 text-secondary">{t('remoteRenameHint')}</p>
        {nameError && <p id={`${id}-name-error`} role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{t(nameError)}</p>}
        {displayedError && <div role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
          <p>{t(displayedError)}</p><button type="button" disabled={busy} onClick={refresh} className={ACTION_CLASS}>{t('retry')}</button>
        </div>}
        <div className="mt-6 flex justify-end gap-3">
          <button type="button" onClick={closeRename} className="rounded-xl border border-border px-4 py-2 text-sm hover:bg-surface-raised">{t('cancel')}</button>
          <button type="button" disabled={!canRename} onClick={() => { void saveName(); }} className="rounded-xl bg-primary px-4 py-2 text-sm text-white hover:bg-primary-hover disabled:opacity-50">{t(busy ? 'saving' : 'save')}</button>
        </div>
      </div>
    </Modal>
  </div>;
}

export default RemoteDeviceSettings;
