import { EnvelopeIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { useEffect, useRef, useState } from 'react';

import { NeteaseMailFailure, NeteaseMailScope } from '../../../shared/neteaseMail/constants';
import type { NeteaseMailAvailability, NeteaseMailBridge } from '../../../shared/neteaseMail/types';
import { i18nService } from '../../services/i18n';
import { neteaseMailService } from '../../services/neteaseMail';
import { getNeteaseMailErrorKey } from '../../services/neteaseMailPresentation';
import Modal from '../common/Modal';

const DOMAINS = ['163.com', '126.com', 'yeah.net', 'vip.163.com', 'vip.126.com', '188.com'];

export function NeteaseMailConnectionPanel({ onClose, service = neteaseMailService }: {
  onClose?: () => void; service?: NeteaseMailBridge;
}) {
  const t = i18nService.t.bind(i18nService);
  const [availability, setAvailability] = useState<NeteaseMailAvailability>({ authorization: false, confirmation: false });
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);
  const [allowDelete, setAllowDelete] = useState(false);
  const busyRef = useRef(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setLoading(true);
    void service.getAvailability().then(value => {
      if (active) {
        setAvailability(value);
        setAllowDelete(value.scopes?.includes(NeteaseMailScope.Delete) ?? false);
      }
    })
      .catch(() => { if (active) setErrorKey('neteaseMailUnavailable'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; if (busyRef.current) void service.cancelAuthorization?.(); };
  }, [service]);

  const connect = async () => {
    if (!availability.authorization || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setErrorKey(null);
    try {
      const result = await service.authorize({ allowDelete });
      if (!result.success) setErrorKey(result.code === NeteaseMailFailure.NotReady ? 'neteaseMailConnectionPending' : getNeteaseMailErrorKey(result.code));
      else {
        const value = await service.getAvailability();
        setAvailability(value);
        setAllowDelete(value.scopes?.includes(NeteaseMailScope.Delete) ?? false);
      }
    } catch {
      setErrorKey('neteaseMailUnavailable');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (busyRef.current || !service.disconnect) return;
    busyRef.current = true;
    setBusy(true);
    setDisconnecting(true);
    setErrorKey(null);
    try {
      const result = await service.disconnect();
      if (!result.success) setErrorKey(getNeteaseMailErrorKey(result.code));
      setAvailability(await service.getAvailability());
    } catch { setErrorKey('neteaseMailUnavailable'); }
    finally { busyRef.current = false; setBusy(false); setDisconnecting(false); }
  };

  return <section className="relative rounded-2xl border border-border bg-surface p-6 text-foreground" aria-label={t('neteaseMailConnect')}>
    {onClose && <button type="button" onClick={onClose} className="absolute right-4 top-4 rounded-md p-1 text-secondary hover:bg-surface-raised" aria-label={t('close')}><XMarkIcon className="h-5 w-5" /></button>}
    <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-red-500/10 text-red-600 dark:text-red-400"><EnvelopeIcon className="h-6 w-6" aria-hidden="true" /></div>
    <h2 className="text-lg font-semibold">{t('neteaseMailName')}</h2>
    <p className="mt-2 text-sm leading-6 text-secondary">{t('neteaseMailConnectionHelp')}</p>
    <p className="mb-2 mt-5 text-xs font-medium text-secondary">{t('neteaseMailSupportedDomains')}</p>
    <div className="flex flex-wrap gap-2">{DOMAINS.map(domain => <span key={domain} className="rounded-md bg-surface-raised px-2 py-1 text-xs text-secondary">{domain}</span>)}</div>
    <div className="mt-5 space-y-1 rounded-xl border border-border p-3 text-xs leading-5 text-secondary">
      <p>{t('neteaseMailAttachmentLimit')}</p><p>{t('neteaseMailQuota')}</p>
    </div>
    <label className="mt-4 flex cursor-pointer items-start gap-2 text-xs leading-5 text-secondary">
      <input type="checkbox" className="mt-1" checked={allowDelete} disabled={busy || loading} onChange={event => setAllowDelete(event.target.checked)} />
      <span>{t('neteaseMailRequestDelete')}</span>
    </label>
    <div className="mt-4 text-sm leading-6" aria-live="polite">
      {errorKey ? <p className="text-red-600 dark:text-red-400" role="alert">{t(errorKey)}</p>
        : loading ? <p className="text-secondary">{t('neteaseMailChecking')}</p>
          : busy ? <p className="text-secondary">{t(disconnecting ? 'neteaseMailDisconnecting' : 'neteaseMailWaitingAuthorization')}</p>
          : availability.connected ? <div className="text-green-600 dark:text-green-400">
            <p>{t(availability.scopes?.includes(NeteaseMailScope.Send) ? 'neteaseMailWriteConnected' : 'neteaseMailReadConnected')}</p>
            {availability.scopes?.includes(NeteaseMailScope.Delete) && <p className="text-xs">{t('neteaseMailDeleteGranted')}</p>}
          </div>
            : availability.account ? <p>{t('neteaseMailConnected').replace('{account}', availability.account)}</p>
          : !availability.authorization && <p className="text-secondary">{t('neteaseMailConnectionPending')}</p>}
    </div>
    <button type="button" onClick={() => void connect()} disabled={!availability.authorization || busy} className="mt-5 w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white transition-colors hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-45">
      {t(disconnecting ? 'neteaseMailDisconnecting' : busy ? 'neteaseMailConnecting' : availability.connected ? 'neteaseMailReconnect' : 'neteaseMailConnect')}
    </button>
    {busy && !disconnecting && service.cancelAuthorization && <button type="button" onClick={() => void service.cancelAuthorization?.()} className="mt-2 w-full rounded-lg border border-border px-4 py-2 text-sm text-secondary">{t('neteaseMailCancel')}</button>}
    {!busy && availability.connected && service.disconnect && <button type="button" onClick={() => void disconnect()} className="mt-2 w-full rounded-lg border border-border px-4 py-2 text-sm text-secondary">{t('neteaseMailDisconnect')}</button>}
  </section>;
}

export default function NeteaseMailConnectionDialog({ onClose }: { onClose: () => void }) {
  return <Modal onClose={onClose} onEscape={onClose} className="mx-4 w-full max-w-md" overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
    <NeteaseMailConnectionPanel onClose={onClose} />
  </Modal>;
}
