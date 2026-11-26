import { InformationCircleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useSelector } from 'react-redux';

import { i18nService } from '../../services/i18n';
import { remoteSettingsService } from '../../services/remoteSettings';
import type { RootState } from '../../store';
import {
  createModalEscapeLayerId,
  isDismissEscapeEvent,
  isTopModalEscapeLayer,
  registerModalEscapeLayer,
  unregisterModalEscapeLayer,
} from '../common/modalEscape';

const t = (key: string) => i18nService.t(key);

/** Read-only help for the device-management heading. */
export function RemoteDeviceHelp(): React.ReactElement {
  const { state } = useSyncExternalStore(remoteSettingsService.subscribe, remoteSettingsService.getSnapshot, remoteSettingsService.getSnapshot);
  const accountGeneration = useSelector((root: RootState) => root.auth.accountGeneration);
  const identity = JSON.stringify([accountGeneration, state?.accountEpoch, state?.owner?.userId, state?.owner?.scopeKey]);
  const [openIdentity, setOpenIdentity] = useState<string | null>(null);
  const open = openIdentity === identity;
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const [layerId] = useState(createModalEscapeLayerId);

  useLayoutEffect(() => { setOpenIdentity(null); }, [identity]);

  useEffect(() => {
    if (!open) return;
    registerModalEscapeLayer(layerId);
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpenIdentity(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isDismissEscapeEvent(event) || !isTopModalEscapeLayer(layerId)) return;
      // Consume Escape before the parent settings dialog can dismiss itself.
      event.preventDefault();
      event.stopPropagation();
      setOpenIdentity(null);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      unregisterModalEscapeLayer(layerId);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, layerId]);

  return <div ref={root} className="relative flex shrink-0 items-center">
    <button ref={trigger} type="button" aria-label={t('remoteDeviceHelpLabel')} title={t('remoteDeviceHelpLabel')}
      aria-expanded={open} aria-controls={`${id}-help`} aria-haspopup="dialog"
      className="flex h-7 w-7 items-center justify-center rounded-md text-secondary hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
      onClick={() => setOpenIdentity(open ? null : identity)}>
      <InformationCircleIcon className="h-4 w-4" aria-hidden="true" />
    </button>
    {open && <div id={`${id}-help`} role="dialog" aria-labelledby={`${id}-title`}
      className="absolute left-0 top-9 z-30 w-[308px] max-w-[calc(100vw-48px)] rounded-xl border border-border bg-surface p-4 shadow-lg">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 id={`${id}-title`} className="text-sm font-medium text-foreground">{t('remoteDeviceHelpLabel')}</h3>
        <button type="button" aria-label={t('close')} className="-mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-secondary hover:bg-surface-raised hover:text-foreground"
          onClick={() => { setOpenIdentity(null); trigger.current?.focus(); }}>
          <XMarkIcon className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      <div className="space-y-3 text-xs leading-5 text-secondary">
        <section>
          <h4 className="mb-1 font-medium text-foreground">{t('remoteDeviceHelpConnections')}</h4>
          <p>{t('remoteDeviceHelpConnectionsFallback')} {t('remoteDeviceHelpSlotDetails')}</p>
        </section>
        <section>
          <h4 className="mb-1 font-medium text-foreground">{t('remoteDeviceHelpRemoval')}</h4>
          <p>{t('remoteRemoveConnectionDescription')} {t('remoteRemoveConnectionResumeHelp')}</p>
        </section>
        <section>
          <h4 className="mb-1 font-medium text-foreground">{t('remoteDeviceHelpSync')}</h4>
          <p>{t('remoteHistoryHelp')} {t('remoteDeviceHelpSwitches')}</p>
        </section>
      </div>
    </div>}
  </div>;
}
