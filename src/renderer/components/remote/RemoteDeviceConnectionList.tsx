import { ArrowPathIcon, ComputerDesktopIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

import { RemoteConnectionReleaseState, RemoteDeviceAdmissionState, type RemoteDeviceConnection } from '../../../shared/remote/connections';
import { i18nService } from '../../services/i18n';
import { type DeviceConnectionsState, remoteDeviceConnectionsService } from '../../services/remoteDeviceConnections';
import Modal from '../common/Modal';

const t = (key: string) => i18nService.t(key);
const ACTION_CLASS = 'rounded-md px-2 py-1.5 text-secondary hover:bg-surface-raised hover:text-primary disabled:cursor-not-allowed disabled:opacity-50';

export function RemoteDeviceConnectionSummary({ snapshot }: {
  snapshot: DeviceConnectionsState;
}): React.ReactElement | null {
  const data = snapshot.data;
  if (data && !data.supported) return null;
  return <div className="flex items-center gap-2 text-xs text-secondary">
    <button type="button" disabled={snapshot.loading}
      className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-surface-raised hover:text-foreground disabled:opacity-50"
      onClick={() => { void remoteDeviceConnectionsService.refresh(); }}
      aria-label={t('remoteRefreshConnections')} title={t('remoteRefreshConnections')}>
      <ArrowPathIcon className={`h-3.5 w-3.5 ${snapshot.loading ? 'animate-spin' : ''}`} aria-hidden="true" />
    </button>
  </div>;
}

export function RemoteDeviceConnectionList({ snapshot, sectionRef }: {
  snapshot: DeviceConnectionsState;
  sectionRef: React.RefObject<HTMLElement>;
}): React.ReactElement | null {
  const id = useId();
  const [target, setTarget] = useState<RemoteDeviceConnection | null>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const dialogGeneration = useRef(0);
  const [feedback, setFeedback] = useState('');
  const data = snapshot.data;
  useLayoutEffect(() => { dialogGeneration.current++; setTarget(null); setFeedback(''); }, [snapshot.accountEpoch]);
  useEffect(() => { if (target) cancelButton.current?.focus(); }, [target]);
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(''), 3000);
    return () => clearTimeout(timer);
  }, [feedback]);
  if (data && !data.supported) return null;
  const close = () => { dialogGeneration.current++; setTarget(null); trigger.current?.focus(); };
  const remove = async () => {
    if (!target) return;
    const epoch = snapshot.accountEpoch;
    const generation = dialogGeneration.current;
    const success = await remoteDeviceConnectionsService.remove(target, epoch);
    const latest = remoteDeviceConnectionsService.getSnapshot();
    if (latest.accountEpoch !== epoch) return;
    if (success) {
      const result = latest.operations[target.deviceId]?.result;
      setFeedback(result?.releaseState === RemoteConnectionReleaseState.Pending ? 'remoteRemovingConnection' : 'remoteConnectionRemovedToast');
      if (generation === dialogGeneration.current) close();
    }
  };
  const rows = data?.connections.filter(device => device.deviceId !== data.currentDevice?.deviceId) ?? [];
  const stale = Boolean(snapshot.error || (data && !data.presenceAvailable));
  const busy = target ? Boolean(snapshot.operations[target.deviceId]?.busy) : false;
  if (!rows.length && !stale && !feedback && !target) return null;
  return <section ref={sectionRef} tabIndex={-1} className="space-y-2.5 outline-none" aria-labelledby={rows.length ? `${id}-title` : undefined}>
    {rows.length > 0 && <>
      <h3 id={`${id}-title`} className="text-xs font-medium">{t('remoteOtherConnectedComputers')}</h3>
      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
        {rows.map(device => {
          const operation = snapshot.operations[device.deviceId];
          const releasing = device.releaseState === RemoteConnectionReleaseState.Pending;
          const name = device.name || device.hostName || t('remoteComputer');
          const duplicateLabel = rows.filter(row => (row.name || row.hostName || t('remoteComputer')) === name
            && (row.instanceLabel || '') === (device.instanceLabel || '')).length > 1;
          const instanceLabel = [device.instanceLabel, duplicateLabel ? t('remoteConnectionInstance').replace('{id}', device.deviceId.slice(-6)) : ''].filter(Boolean).join(' · ');
          const stateKey = releasing || operation?.busy ? 'remoteRemovingConnection'
            : device.admissionState === RemoteDeviceAdmissionState.Online ? 'remoteOnline'
            : device.admissionState === RemoteDeviceAdmissionState.Reconnecting ? 'remoteConnectionReconnecting' : 'remoteConnectionUnknown';
          return <div key={device.deviceId} className="flex min-h-16 items-center gap-3 px-4 py-2.5">
            <span className="relative flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full border border-border text-secondary">
              <ComputerDesktopIcon className="h-4 w-4" aria-hidden="true" />
              {!stale && device.admissionState === RemoteDeviceAdmissionState.Online && !releasing && !operation?.busy
                && <span className="absolute -right-px -top-px h-1.5 w-1.5 rounded-full bg-emerald-500 ring-2 ring-surface" />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium leading-5" title={name}>{name}</p>
              <p className="mt-0.5 truncate text-xs leading-4 text-secondary" title={instanceLabel || undefined}>{t(stale ? 'remoteConnectionUnknown' : stateKey)}
                {instanceLabel && ` · ${instanceLabel}`}
              </p>
            </div>
            <button type="button" className={`${ACTION_CLASS} shrink-0 text-xs`} disabled={!device.canRemove || Boolean(operation?.busy) || releasing || stale}
              aria-label={t('remoteRemoveConnectionLabel').replace('{name}', name)}
              onClick={event => { dialogGeneration.current++; trigger.current = event.currentTarget; setTarget(device); }}>
              {t('remoteRemoveConnection')}
            </button>
          </div>;
        })}
      </div>
    </>}
    {stale && <p role="alert" className="text-xs leading-5 text-amber-700 dark:text-amber-400">{t(snapshot.error || 'remoteConnectionsUnavailable')}
      {data?.observedAt && Number.isFinite(Date.parse(data.observedAt)) && <span className="block">{t('remoteConnectionsLastUpdated').replace('{time}', new Date(data.observedAt).toLocaleTimeString())}</span>}
    </p>}
    {feedback && <p role="status" className="text-xs text-secondary">{t(feedback)}</p>}
    <Modal isOpen={Boolean(target)} onClose={close} onEscape={close}
      overlayClassName="fixed inset-0 z-[60] modal-backdrop flex items-center justify-center p-4"
      className="w-full max-w-md rounded-2xl border border-border bg-background p-6 shadow-modal">
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={`${id}-remove-title`} aria-describedby={`${id}-remove-description`}
        onKeyDown={event => {
          if (event.key !== 'Tab') return;
          const elements = dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
          if (!elements?.length) { event.preventDefault(); return; }
          const first = elements[0]; const last = elements[elements.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }}>
        <h3 id={`${id}-remove-title`} className="break-words text-base font-semibold">{t('remoteRemoveConnectionTitle').replace('{name}', target?.name || target?.hostName || t('remoteComputer'))}</h3>
        <div id={`${id}-remove-description`} className="mt-4 space-y-2 text-sm leading-6 text-secondary">
          <p>{t('remoteRemoveConnectionDescription')}</p><p>{t('remoteRemoveConnectionResumeHelp')}</p>
          {target?.resumeRequiresUpgrade && <p className="rounded-lg bg-amber-500/10 p-3 text-amber-800 dark:text-amber-300">{t('remoteConnectionUpgradeWarning')}</p>}
        </div>
        {snapshot.error && <p role="alert" className="mt-3 text-xs leading-5 text-red-600 dark:text-red-400">{t(snapshot.error)}</p>}
        <div className="mt-6 flex justify-end gap-3">
          <button ref={cancelButton} type="button" className="rounded-xl border border-border px-4 py-2 text-sm hover:bg-surface-raised" onClick={close}>{t('cancel')}</button>
          <button type="button" disabled={busy} className="rounded-xl bg-primary px-4 py-2 text-sm text-white hover:bg-primary-hover disabled:opacity-50" onClick={() => { void remove(); }}>{t(busy ? 'remoteRemovingConnection' : 'remoteRemoveConnection')}</button>
        </div>
      </div>
    </Modal>
  </section>;
}
