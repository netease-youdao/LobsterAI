import { ComputerDesktopIcon, InformationCircleIcon, PencilSquareIcon } from '@heroicons/react/24/outline';
import { QRCodeSVG } from 'qrcode.react';
import React, { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useSelector } from 'react-redux';

import { RemoteDeviceAdmissionState, RemoteDeviceConnectionState } from '../../../shared/remote/connections';
import { type RemoteConfigureRequest, RemoteConnectionReason, RemoteSyncStatus, RemoteSyncTaskIssueStatus } from '../../../shared/remote/constants';
import { getMobileAppEntry, MobileAppEntryKind } from '../../services/endpoints';
import { i18nService } from '../../services/i18n';
import { remoteDeviceConnectionsService } from '../../services/remoteDeviceConnections';
import { remoteSettingsService } from '../../services/remoteSettings';
import type { RootState } from '../../store';
import Modal from '../common/Modal';
import RemoteControlIcon from '../icons/RemoteControlIcon';
import { isRemoteOnline, needsRemoteSignIn, normalizeRemoteDeviceName, remoteConnectionDescription, remoteConnectionFailure, remoteSyncDescription } from '../settings/remoteControlState';
import { RemoteDeviceConnectionList, RemoteDeviceConnectionSummary } from './RemoteDeviceConnectionList';

interface RemoteDeviceSettingsProps {
  onLogin: () => void;
  loginAllowed: boolean;
}

const t = (key: string) => i18nService.t(key);
const DeviceAction = { Rename: 'rename', Retry: 'retry', RetryTask: 'retry_task', Enable: 'enable' } as const;
const TASK_STATUS_KEYS = {
  [RemoteSyncTaskIssueStatus.Retrying]: 'remoteTaskSyncRetrying',
  [RemoteSyncTaskIssueStatus.Isolated]: 'remoteTaskSyncIsolated',
  [RemoteSyncTaskIssueStatus.WaitingDependency]: 'remoteTaskSyncWaiting',
  [RemoteSyncTaskIssueStatus.Repairing]: 'remoteTaskSyncRepairing',
  [RemoteSyncTaskIssueStatus.Closed]: 'remoteTaskSyncClosed',
} as const;
type DeviceAction = typeof DeviceAction[keyof typeof DeviceAction];
const ACTION_CLASS = 'text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50';

export function RemoteDeviceSettings({ onLogin, loginAllowed }: RemoteDeviceSettingsProps): React.ReactElement {
  const { state, busy, error } = useSyncExternalStore(
    remoteSettingsService.subscribe, remoteSettingsService.getSnapshot, remoteSettingsService.getSnapshot,
  );
  const management = useSyncExternalStore(remoteDeviceConnectionsService.subscribe, remoteDeviceConnectionsService.getSnapshot, remoteDeviceConnectionsService.getSnapshot);
  const connectionsSection = useRef<HTMLElement>(null);
  const entry = getMobileAppEntry();
  const isDownload = entry.kind === MobileAppEntryKind.AppDownload;
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
  const [activeAction, setActiveAction] = useState<DeviceAction | null>(null);
  const [feedback, setFeedback] = useState('');
  const [actionError, setActionError] = useState('');
  const identity = JSON.stringify([accountGeneration, state?.accountEpoch, state?.owner?.userId, state?.owner?.scopeKey]);
  const online = isRemoteOnline(state);
  const signInRequired = needsRemoteSignIn(state);
  const admissionDeferred = Boolean(state?.owner && state.enabled && !signInRequired && state.syncHealth?.admissionDeferred);
  const connectionFailure = remoteConnectionFailure(state);
  const contentStatus = remoteSyncDescription(state);
  const contentLabel = contentStatus === 'remoteTasksSyncFailed'
    ? t('remoteTasksSyncFailedCount').replace('{count}', String(state?.syncHealth?.failedSessions ?? 0))
    : t(contentStatus ?? 'remoteCurrentDevice');
  const taskIssues = state?.owner && state.enabled && !signInRequired
    ? (state.syncHealth?.taskIssues ?? []).filter(issue => issue.status !== RemoteSyncTaskIssueStatus.Closed).slice(0, 20) : [];
  const displayName = state?.owner ? state.name || state.hostName : state?.hostName;
  const connections = state?.accountEpoch === management.accountEpoch ? management.data : null;
  const showConnections = Boolean(state?.owner && !signInRequired && (state.deviceConnectionManagementSupported || connections?.supported) && management.accountEpoch === state.accountEpoch);
  const currentConnection = connections?.currentDevice;
  const observedSlots = connections?.presenceAvailable && !management.error ? connections.quota.onlineSlotsUsed : null;
  const slotAvailable = observedSlots !== null && observedSlots !== undefined && observedSlots < (connections?.quota.maxOnlineDesktops ?? 0);
  const removed = Boolean(state?.owner && state.enabled && (state.connectionReason === RemoteConnectionReason.Removed
    || state.errorCode === 47121 || currentConnection?.connectionState === RemoteDeviceConnectionState.Removed));
  const quotaBlocked = Boolean(!online && !removed && state?.owner && state.enabled && (state.errorCode === 47022
    || state.connectionReason === RemoteConnectionReason.QuotaBlocked || currentConnection?.admissionState === RemoteDeviceAdmissionState.QuotaBlocked));
  const statusKey = state?.owner && signInRequired ? 'remoteLoginExpired' : removed ? 'remoteConnectionRemoved'
    : quotaBlocked ? 'remoteWaitingForConnection' : online ? 'remoteOnline' : remoteConnectionDescription(state);
  const [retryCooldown, setRetryCooldown] = useState(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout>>();
  const namePending = state?.nameSyncStatus === RemoteSyncStatus.Pending || state?.nameSyncStatus === RemoteSyncStatus.Error;
  const settingsPending = state?.settingsSyncStatus === RemoteSyncStatus.Pending || state?.settingsSyncStatus === RemoteSyncStatus.Error;
  const displayedError = error || actionError;
  const canRename = Boolean(state?.owner && state.accountEpoch && !busy && !signInRequired && !displayedError);

  useLayoutEffect(() => {
    requestGeneration.current++;
    setRenameOpen(false); setNameDraft(''); setNameError('');
    setFeedback(''); setActionError(''); setActiveAction(null);
    clearTimeout(retryTimer.current); setRetryCooldown(false);
  }, [identity]);

  useEffect(() => {
    mounted.current = true;
    requestGeneration.current++;
    return () => { mounted.current = false; clearTimeout(retryTimer.current); };
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
    if ((action === DeviceAction.Retry && retryCooldown) || busy || snapshot.busy || !state?.owner || !state.accountEpoch || signInRequired
      || state.accountEpoch !== snapshot.state?.accountEpoch) return false;
    if (displayedError) { refresh(); return false; }
    const generation = requestGeneration.current;
    const epoch = state.accountEpoch;
    setActiveAction(action); setFeedback(''); setActionError('');
    if (action === DeviceAction.Retry && quotaBlocked) {
      setRetryCooldown(true);
      retryTimer.current = setTimeout(() => setRetryCooldown(false), Math.max(30000, currentConnection?.retryAfterMs ?? 0));
    }
    try {
      const saved = await remoteSettingsService.submit(changes);
      const current = remoteSettingsService.getSnapshot().state;
      if (!mounted.current || generation !== requestGeneration.current || epoch !== current?.accountEpoch) return false;
      if (saved && action === DeviceAction.Rename) {
        const pending = current?.nameSyncStatus === RemoteSyncStatus.Pending || current?.nameSyncStatus === RemoteSyncStatus.Error;
        setFeedback(pending ? 'remoteNamePending' : 'remoteNameSaved');
      }
      if (saved && action === DeviceAction.RetryTask) setFeedback('remoteTaskRetryRequested');
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

  const resume = async () => {
    if (!currentConnection || !state?.accountEpoch || state.accountEpoch !== remoteSettingsService.getSnapshot().state?.accountEpoch) return;
    const epoch = state.accountEpoch;
    const saved = await remoteDeviceConnectionsService.resume(currentConnection, epoch);
    if (mounted.current && epoch === remoteSettingsService.getSnapshot().state?.accountEpoch && saved) setFeedback('remoteResumeRequested');
  };

  return <div className="space-y-6">
    <div className="flex min-h-[116px] items-center gap-4 rounded-xl border border-border bg-surface px-4 py-[7px]">
      <div className="shrink-0 text-center">
        <div className="overflow-hidden rounded-lg border border-border bg-white"><QRCodeSVG value={entry.url} size={78} marginSize={2} bgColor="#FFFFFF" fgColor="#000000" title={`${t(isDownload ? 'remoteQrAppDownload' : 'remoteQrOfficialSite')}: ${entry.url}`} /></div>
        <p className="mt-[3px] max-w-20 text-[11px] leading-4 text-secondary">{t(isDownload ? 'remoteQrAppDownload' : 'remoteQrOfficialSiteCompact')}</p>
      </div>
      <div className="min-w-0 flex-1">
        <p className="mb-2 text-sm font-semibold">{t('remoteDevicesBannerTitle')}</p>
        <p className="text-xs leading-5 text-secondary">{t('remoteDevicesBannerBenefits')}</p>
        <p className="mt-1 text-[11px] leading-4 text-secondary">{t(isDownload ? 'remoteQrAppDownloadHint' : 'remoteQrDownloadPending')}</p>
      </div>
      <div aria-hidden="true" className="hidden h-20 w-20 shrink-0 items-center justify-center rounded-full bg-primary/5 text-primary/25 lg:flex">
        <RemoteControlIcon className="h-12 w-12" />
      </div>
    </div>
    <section aria-labelledby={`${id}-computer`}>
      <div className="mb-2.5 flex min-h-6 items-center justify-between gap-3">
        <h3 id={`${id}-computer`} className="text-xs font-medium">{t('remoteThisComputer')}</h3>
        {showConnections && <RemoteDeviceConnectionSummary snapshot={management} />}
      </div>
      <div className="flex min-h-16 items-center gap-3 rounded-xl border border-border bg-surface px-3.5 py-2.5">
        <span className="relative flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full border border-border">
          <ComputerDesktopIcon className="h-4 w-4 text-secondary" aria-hidden="true" />
          <span aria-hidden="true" className={`absolute -right-px -top-px h-1.5 w-1.5 rounded-full ring-2 ring-surface ${quotaBlocked ? 'bg-amber-500' : online && !signInRequired && !removed ? 'bg-emerald-500' : 'bg-gray-400'}`} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium leading-5" title={displayName} data-remote-device-name="true">{displayName || t('remoteThisComputer')}</p>
          <p className="mt-0.5 text-xs leading-4 text-secondary" role="status">
            <span className={quotaBlocked ? 'text-amber-700 dark:text-amber-400' : undefined}>{t(statusKey)}</span>
            {` · ${removed || quotaBlocked ? t('remoteSyncPaused') : contentLabel}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs">
          {quotaBlocked && showConnections && <button type="button" className={`${ACTION_CLASS} min-h-7`} onClick={() => { connectionsSection.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); connectionsSection.current?.focus(); }}>{t('remoteManageConnections')}</button>}
          {state && signInRequired && loginAllowed && <button type="button" disabled={busy} className={`${ACTION_CLASS} min-h-7`} onClick={() => { if (!busy) onLogin(); }}>{t('login')}</button>}
          {state?.owner && !state.enabled && !signInRequired && <button type="button" disabled={busy} className={`${ACTION_CLASS} min-h-7`} onClick={() => { void submit({ enabled: true }, DeviceAction.Enable); }}>{t('remoteEnableConnection')}</button>}
          {removed && !signInRequired && currentConnection && <button type="button" disabled={state?.deviceConnectionManagementClusterReady === false || currentConnection.canResume === false || Boolean(management.operations[currentConnection.deviceId]?.busy)} className={`${ACTION_CLASS} min-h-7`} onClick={() => { void resume(); }}>{t('remoteReconnect')}</button>}
          <button ref={renameButton} type="button" title={t('remoteRenameDevice')} aria-label={t('remoteRenameDevice')} disabled={!canRename}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-secondary hover:bg-surface-raised disabled:opacity-40"
            onClick={() => { if (!canRename) return; setNameDraft(displayName || ''); setNameError(''); setRenameOpen(true); }}>
            <PencilSquareIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="mt-2 space-y-1.5 text-xs leading-5 empty:hidden">
        {quotaBlocked && <p className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
          <InformationCircleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{t(slotAvailable ? 'remoteQuotaSlotAvailable' : 'remoteQuotaPausedWithoutCount')} {t('remoteLocalTasksUnaffected')}</span>
        </p>}
        {removed && <p className="text-secondary">{t('remoteRemovedCompactHelp')}</p>}
        {admissionDeferred && <p role="status" className="text-amber-700 dark:text-amber-400">{t('remoteHistoryAdmissionDeferred')}</p>}
        {!removed && !quotaBlocked && currentConnection?.slotOccupied && currentConnection.admissionState === RemoteDeviceAdmissionState.Reconnecting && <p className="text-secondary">{t('remoteReconnectSlotRetained')}</p>}
        {!removed && !quotaBlocked && connectionFailure && connectionFailure !== statusKey && <p role="alert" className="text-red-600 dark:text-red-400">{t(connectionFailure)}</p>}
        {online && state?.connectionReason === RemoteConnectionReason.WorkspaceUnavailable && <p className="text-secondary">{t('remoteWorkspaceUnavailable')}</p>}
        {online && state?.screenLocked && <p className="text-secondary">{t('remoteScreenLocked')}</p>}
        {namePending && <p className="text-secondary">{t('remoteNamePending')}</p>}
        {settingsPending && <p className="text-secondary">{t(state?.enabled ? 'remoteSavedPending' : 'remoteDisabledPending')}</p>}
        {feedback && <p role="status" className="text-secondary">{t(feedback)}</p>}
        {state && signInRequired && !loginAllowed && <p className="text-secondary">{t('remoteLoginUnavailable')}</p>}
        {removed && management.error && !showConnections && <p role="alert" className="text-amber-700 dark:text-amber-400">{t(management.error)}</p>}
        {state?.owner && state.enabled && !signInRequired && !removed
          && (online ? Boolean(connectionFailure) || admissionDeferred : state.connectionReason !== RemoteConnectionReason.Connecting)
          && <button type="button" disabled={busy || retryCooldown} className={ACTION_CLASS} onClick={() => { void submit({ retry: true }, DeviceAction.Retry); }}>
            {t(busy && activeAction === DeviceAction.Retry ? 'remoteReconnecting' : online && !admissionDeferred ? 'retry' : 'remoteReconnect')}
          </button>}
        {displayedError && <div role="alert" className="text-red-600 dark:text-red-400">
          <p>{t(displayedError)}</p>
          <button type="button" disabled={busy} className={ACTION_CLASS} onClick={refresh}>{t('retry')}</button>
        </div>}
      </div>
    </section>
    {taskIssues.length > 0 && <details key={identity} className="rounded-xl border border-border bg-surface px-3.5 py-2.5">
      <summary className="cursor-pointer text-xs font-medium text-secondary">{t('remoteTaskSyncDetails')}</summary>
      <p className="mt-2 text-xs leading-5 text-secondary">{t(contentStatus === 'remoteTasksSyncFailed' ? 'remoteTaskSyncLocalUnaffected' : 'remoteLocalTasksUnaffected')}</p>
      <ul className="mt-2 divide-y divide-border">
        {taskIssues.map(issue => <li key={issue.localSessionId} className="flex items-center gap-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium" title={issue.title}>{issue.title || t('remoteUnnamedTask')}</p>
            <p className="mt-0.5 text-[11px] leading-4 text-secondary">{t(TASK_STATUS_KEYS[issue.status])}</p>
            {Number.isFinite(issue.nextRetryAt) && (issue.nextRetryAt ?? 0) > Date.now() && <p className="mt-0.5 text-[11px] leading-4 text-secondary">
              {t('remoteTaskNextRetry').replace('{time}', new Date(issue.nextRetryAt ?? 0).toLocaleTimeString())}
            </p>}
          </div>
          <button type="button" disabled={busy || !issue.retryable || !state?.accountEpoch}
            className={`${ACTION_CLASS} min-h-7 shrink-0 text-xs`}
            onClick={() => { if (!issue.retryable) return; void submit({ retrySessionId: issue.localSessionId }, DeviceAction.RetryTask); }}>
            {t('remoteRetryTask')}
          </button>
        </li>)}
      </ul>
      {state?.syncHealth?.taskIssuesTruncated && <p className="mt-1 text-[11px] text-secondary">{t('remoteTaskIssuesTruncated')}</p>}
    </details>}
    {showConnections && <RemoteDeviceConnectionList snapshot={management} sectionRef={connectionsSection} />}
    <Modal isOpen={renameOpen} onClose={closeRename} onEscape={closeRename}
      overlayClassName="fixed inset-0 z-[60] modal-backdrop flex items-center justify-center p-4"
      className="w-full max-w-sm rounded-xl border border-border bg-background p-5 shadow-modal">
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
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={closeRename} className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-surface-raised">{t('cancel')}</button>
          <button type="button" disabled={!canRename} onClick={() => { void saveName(); }} className="rounded-lg bg-primary px-3 py-1.5 text-xs text-white hover:bg-primary-hover disabled:opacity-50">{t(busy ? 'saving' : 'save')}</button>
        </div>
      </div>
    </Modal>
  </div>;
}

export default RemoteDeviceSettings;
