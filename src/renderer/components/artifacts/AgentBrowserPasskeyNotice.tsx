import { KeyIcon, XMarkIcon } from '@heroicons/react/24/outline';
import {
  BrowserPasskeyAction,
  type BrowserPasskeyNotice,
  BrowserPasskeyStatus,
  BrowserPasskeyUiEvent,
} from '@shared/browserWebAccess/passkeys';
import React, { useState } from 'react';

import { i18nService } from '@/services/i18n';

interface Props {
  notice: BrowserPasskeyNotice;
  onResolve: (action: BrowserPasskeyAction) => Promise<boolean>;
}

const AgentBrowserPasskeyNotice: React.FC<Props> = ({ notice, onResolve }) => {
  const [busy, setBusy] = useState(false);
  const waiting = notice.status === BrowserPasskeyStatus.Waiting;
  const resolve = async (action: BrowserPasskeyAction, openSettings = false) => {
    if (busy) return;
    setBusy(true);
    try {
      if (await onResolve(action) && openSettings) {
        window.dispatchEvent(new CustomEvent(BrowserPasskeyUiEvent.OpenBrowserSettings));
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="status" className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2">
      <div className="flex items-start gap-2">
        <KeyIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" />
        <div className="min-w-0 flex-1 text-xs">
          <p className="font-medium text-foreground">{i18nService.t(waiting
            ? 'agentBrowserPasskeyWaiting'
            : 'agentBrowserPasskeyIncomplete')}</p>
          <p className="mt-1 break-words text-foreground">{i18nService.t(notice.platformAuthenticatorAvailable === false
            ? 'agentBrowserPasskeyUnavailable'
            : 'agentBrowserPasskeyHelp')}</p>
          <p className="mt-1 text-[11px] text-secondary">{i18nService.t('agentBrowserPasskeyExternalHelp')}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {waiting ? (
              <button type="button" disabled={busy} onClick={() => void resolve(BrowserPasskeyAction.Cancel)}
                className="rounded-md border border-border bg-surface px-2 py-1 text-foreground hover:bg-surface-raised disabled:opacity-50">
                {i18nService.t('agentBrowserPasskeyCancel')}
              </button>
            ) : null}
            <button type="button" disabled={busy} onClick={() => void resolve(BrowserPasskeyAction.Cancel, true)}
              className="rounded-md border border-border bg-surface px-2 py-1 text-foreground hover:bg-surface-raised disabled:opacity-50">
              {i18nService.t('agentBrowserPasskeySettings')}
            </button>
          </div>
        </div>
        <button type="button" disabled={busy} onClick={() => void resolve(BrowserPasskeyAction.Dismiss)}
          aria-label={i18nService.t('close')} title={i18nService.t('close')}
          className="rounded p-0.5 text-secondary hover:bg-surface-raised disabled:opacity-50">
          <XMarkIcon className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
};

export default AgentBrowserPasskeyNotice;
