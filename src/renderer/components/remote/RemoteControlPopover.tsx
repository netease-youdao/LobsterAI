import { XMarkIcon } from '@heroicons/react/24/outline';
import { QRCodeSVG } from 'qrcode.react';
import React, { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import type { RemoteConfigureRequest } from '../../../shared/remote/constants';
import { getMobileAppEntry, MobileAppEntryKind } from '../../services/endpoints';
import { i18nService } from '../../services/i18n';
import { remoteSettingsService } from '../../services/remoteSettings';
import { showToast } from '../../utils/localFileActions';
import {
  needsRemoteSignIn,
  remoteSettingsSwitchChecked,
} from '../settings/remoteControlState';
import SettingsSwitch from '../settings/SettingsSwitch';

interface RemoteControlPopoverProps {
  anchorRef: React.RefObject<HTMLButtonElement>;
  onClose: () => void;
  onLogin: () => void;
  loginAllowed: boolean;
}

const t = (key: string) => i18nService.t(key);
const RemoteSetting = { Connection: 'enabled', KeepAwake: 'keepAwakeEnabled' } as const;
type Setting = typeof RemoteSetting[keyof typeof RemoteSetting];
const ACTION_CLASS = 'text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50';

export const getRemotePopoverPosition = (
  anchor: Pick<DOMRect, 'left' | 'top'>,
  height: number,
  viewport: { width: number; height: number },
): { left: number; top: number; width: number; maxHeight: number } => {
  const margin = 12;
  const width = Math.max(0, Math.min(320, viewport.width - margin * 2));
  const maxHeight = Math.max(0, viewport.height - margin * 2);
  return {
    left: Math.max(margin, Math.min(anchor.left, viewport.width - width - margin)),
    top: Math.max(margin, Math.min(anchor.top - 8 - height, viewport.height - Math.min(height, maxHeight) - margin)),
    width,
    maxHeight,
  };
};

class MobileEntryQrBoundary extends React.Component<{ children: React.ReactNode; fallback: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  render(): React.ReactNode {
    return this.state.failed
      ? this.props.fallback
      : this.props.children;
  }
}

export function RemoteControlPopover({ anchorRef, onClose, onLogin, loginAllowed }: RemoteControlPopoverProps): React.ReactElement {
  const { state, busy, error } = useSyncExternalStore(
    remoteSettingsService.subscribe, remoteSettingsService.getSnapshot, remoteSettingsService.getSnapshot,
  );
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const mounted = useRef(false);
  const displayedEpoch = useRef<string>();
  const restoreFocus = useRef(true);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [activeSetting, setActiveSetting] = useState<Setting | null>(null);
  const [actionError, setActionError] = useState('');
  const [position, setPosition] = useState<React.CSSProperties>({ visibility: 'hidden' });
  const entry = getMobileAppEntry();
  const isDownload = entry.kind === MobileAppEntryKind.AppDownload;
  const signInRequired = needsRemoteSignIn(state);
  const enabled = remoteSettingsSwitchChecked(state, RemoteSetting.Connection);
  const keepAwake = remoteSettingsSwitchChecked(state, RemoteSetting.KeepAwake);
  const displayedError = error || actionError;

  useLayoutEffect(() => {
    if (displayedEpoch.current && displayedEpoch.current !== state?.accountEpoch) {
      onCloseRef.current();
      return;
    }
    displayedEpoch.current = state?.accountEpoch;
  }, [state?.accountEpoch]);

  useLayoutEffect(() => {
    const update = () => {
      const anchor = anchorRef.current;
      if (!anchor?.isConnected || !anchor.getClientRects().length) { onCloseRef.current(); return; }
      const rect = anchor.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) { onCloseRef.current(); return; }
      setPosition(getRemotePopoverPosition(rect, panelRef.current?.getBoundingClientRect().height ?? 0, {
        width: window.innerWidth, height: window.innerHeight,
      }));
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    if (anchorRef.current) observer?.observe(anchorRef.current);
    if (anchorRef.current?.parentElement) observer?.observe(anchorRef.current.parentElement);
    const sidebar = anchorRef.current?.closest('aside');
    if (sidebar) observer?.observe(sidebar);
    if (panelRef.current) observer?.observe(panelRef.current);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchorRef]);

  useEffect(() => {
    mounted.current = true;
    closeButton.current?.focus();
    const anchor = anchorRef.current;
    const outside = (target: EventTarget | null) => target instanceof Node
      && !panelRef.current?.contains(target) && !anchorRef.current?.contains(target);
    const onPointerDown = (event: PointerEvent) => {
      if (outside(event.target)) onCloseRef.current();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (!outside(event.target)) return;
      restoreFocus.current = false;
      onCloseRef.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      mounted.current = false;
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('keydown', onKeyDown);
      if (restoreFocus.current && anchor?.isConnected && anchor.getClientRects().length) anchor.focus();
    };
  }, [anchorRef]);

  const startLogin = () => {
    if (!loginAllowed || busy) return;
    restoreFocus.current = false;
    onClose();
    onLogin();
  };

  const submit = async (changes: Pick<RemoteConfigureRequest, Setting>, setting: Setting): Promise<void> => {
    const snapshot = remoteSettingsService.getSnapshot();
    if (!state?.accountEpoch || state.accountEpoch !== snapshot.state?.accountEpoch) {
      onCloseRef.current();
      return;
    }
    if (busy || snapshot.busy) return;
    const epoch = state.accountEpoch;
    setActiveSetting(setting); setActionError('');
    try {
      await remoteSettingsService.submit(changes);
    } catch {
      if (mounted.current && epoch === remoteSettingsService.getSnapshot().state?.accountEpoch) setActionError('remoteSaveFailed');
    } finally {
      if (mounted.current && epoch === remoteSettingsService.getSnapshot().state?.accountEpoch) setActiveSetting(null);
    }
  };

  const toggle = (setting: Setting) => {
    const checked = remoteSettingsSwitchChecked(state, setting);
    if (signInRequired && !checked) { startLogin(); return; }
    void submit({ [setting]: !checked }, setting);
  };

  const openEntry = async () => {
    try {
      const result = await window.electron.shell.openExternal(entry.url);
      if (!result.success) showToast(t('remoteOpenLinkFailed'));
    } catch { showToast(t('remoteOpenLinkFailed')); }
  };
  const renderSwitch = (setting: Setting, checked: boolean, label: string) => (
    <div className="flex min-h-11 items-center justify-between gap-3 py-2" aria-busy={busy && activeSetting === setting}>
      <span className="min-w-0 flex-1 text-sm font-medium text-foreground">{t(label)}</span>
      {busy && activeSetting === setting && <span role="status" className="text-xs text-secondary">{t('saving')}</span>}
      <SettingsSwitch label={t(label)} checked={checked} disabled={busy || !state || (signInRequired && !checked && !loginAllowed)} onClick={() => toggle(setting)} />
    </div>
  );

  const content = <div ref={panelRef} id="remote-control-popover" role="dialog" aria-labelledby={`${id}-title`}
      style={position}
      className="non-draggable fixed z-[110] w-80 max-w-[calc(100vw-24px)] max-h-[calc(100vh-24px)] overflow-y-auto overscroll-contain rounded-2xl border border-border bg-surface p-5 text-foreground shadow-xl"
      onClick={event => event.stopPropagation()}>
      <div className="flex items-start justify-between gap-2">
        <h2 id={`${id}-title`} className="min-w-0 text-sm font-semibold leading-5">{t('remoteTitle')}</h2>
        <button ref={closeButton} type="button" aria-label={t('close')} onClick={onClose}
          className="-mr-1 -mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-secondary hover:bg-surface-raised">
          <XMarkIcon className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <div className="mt-3 text-center">
        <div className="mx-auto w-fit max-w-full rounded-xl bg-white p-1">
          <MobileEntryQrBoundary fallback={
            <div className="flex h-[184px] flex-col items-center justify-center gap-2 px-4 text-center text-xs text-gray-600">
              <p role="status">{t('remoteQrUnavailable')}</p>
              <a href={entry.url} className={`${ACTION_CLASS} break-all`} aria-label={`${t(isDownload ? 'remoteEntryDownloadLink' : 'remoteEntryLink')}: ${entry.url}`}
                onClick={event => { event.preventDefault(); void openEntry(); }}>{entry.url}</a>
            </div>
          }>
            <QRCodeSVG value={entry.url} size={184} marginSize={4} bgColor="#FFFFFF" fgColor="#000000" title={`${t(isDownload ? 'remoteQrAppDownload' : 'remoteQrOfficialSite')}: ${entry.url}`} />
          </MobileEntryQrBoundary>
        </div>
        <p className="mt-2 text-xs font-medium leading-5">{t(isDownload ? 'remoteQrAppDownload' : 'remoteQrOfficialSite')}</p>
        <p className="text-xs leading-5 text-secondary">{t(isDownload ? 'remoteQrAppDownloadHint' : 'remoteQrDownloadPending')}</p>
      </div>
      <div className="mt-4 border-t border-border pt-2">
        {renderSwitch(RemoteSetting.Connection, enabled, 'remoteAllowConnection')}
        {renderSwitch(RemoteSetting.KeepAwake, keepAwake, 'remoteKeepAwake')}
      </div>
      {state && signInRequired && !loginAllowed && <p className="mt-1 text-xs text-secondary">{t('remoteLoginUnavailable')}</p>}
      {!state && !displayedError && <p role="status" className="mt-1 text-xs text-secondary">{t('remoteLoading')}</p>}
      {displayedError && <div role="alert" className="mt-2 text-xs leading-5 text-red-600 dark:text-red-400">
        <p>{t(displayedError)}</p>
        <button type="button" disabled={busy} className={ACTION_CLASS} onClick={() => { setActionError(''); void remoteSettingsService.refresh(); }}>{t('retry')}</button>
      </div>}
      {state?.keepAwakeError && <div role="alert" className="mt-2 text-xs leading-5 text-amber-700 dark:text-amber-400">
        <p>{t(state.keepAwakeEnabled ? 'remoteKeepAwakeFailed' : 'remoteKeepAwakeDisableFailed')}</p>
        {!signInRequired && <button type="button" disabled={busy} className={ACTION_CLASS}
          onClick={() => { void submit({ keepAwakeEnabled: state.keepAwakeEnabled ?? true }, RemoteSetting.KeepAwake); }}>{t('retry')}</button>}
      </div>}
    </div>;
  return typeof document === 'undefined' ? content : createPortal(content, document.body);
}
