import { ArrowPathIcon, ExclamationTriangleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { AuthCallbackTransport } from '@shared/auth/constants';
import React, { useState } from 'react';
import { useSelector } from 'react-redux';

import { authService, PastedLoginUrlOutcome } from '../../services/auth';
import { i18nService } from '../../services/i18n';
import type { RootState } from '../../store';
import { type BrowserLoginState, BrowserLoginStatus } from '../../store/slices/authSlice';

const pastedUrlErrorKeys: Partial<Record<PastedLoginUrlOutcome, string>> = {
  [PastedLoginUrlOutcome.Invalid]: 'browserLoginPasteInvalid',
  [PastedLoginUrlOutcome.Expired]: 'browserLoginPasteExpired',
  [PastedLoginUrlOutcome.ExchangeFailed]: 'browserLoginPasteFailed',
};

const BrowserLoginNoticeCard: React.FC<{ browserLogin: BrowserLoginState }> = ({ browserLogin }) => {
  const [isBusy, setIsBusy] = useState(false);
  const [isPasteOpen, setIsPasteOpen] = useState(false);
  const [pastedUrl, setPastedUrl] = useState('');
  const [pasteErrorKey, setPasteErrorKey] = useState<string | null>(null);

  const isTimedOut = browserLogin.status === BrowserLoginStatus.TimedOut;
  const hintKey = browserLogin.transport === AuthCallbackTransport.DeepLink
    ? 'browserLoginDeepLinkHint'
    : 'browserLoginLoopbackHint';

  const runBusy = (action: () => Promise<unknown>) => {
    if (isBusy) return;
    setIsBusy(true);
    void action()
      .catch((error) => {
        console.warn('[BrowserLoginNotice] browser login action failed:', error);
      })
      .finally(() => setIsBusy(false));
  };

  const submitPastedUrl = (event: React.FormEvent) => {
    event.preventDefault();
    if (!pastedUrl.trim()) return;
    setPasteErrorKey(null);
    runBusy(async () => {
      const outcome = await authService.completeBrowserLoginWithUrl(pastedUrl);
      setPasteErrorKey(pastedUrlErrorKeys[outcome] ?? null);
    });
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="non-draggable pointer-events-auto flex w-full max-w-md items-start gap-2.5 rounded-xl border border-border-subtle bg-surface px-3.5 py-3 text-foreground shadow-elevated animate-fade-in-down"
    >
      {isTimedOut ? (
        <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />
      ) : (
        <ArrowPathIcon className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium leading-5">
          {i18nService.t(isTimedOut ? 'browserLoginTimedOutTitle' : 'browserLoginWaitingTitle')}
        </p>
        <p className="mt-0.5 text-xs leading-5 text-secondary">{i18nService.t(hintKey)}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <button
            type="button"
            disabled={isBusy}
            onClick={() => runBusy(() => authService.loginWithAlternateTransport())}
            className="text-xs font-medium text-primary transition-colors hover:text-primary-hover disabled:cursor-wait disabled:opacity-60"
          >
            {i18nService.t('browserLoginSwitchTransport')}
          </button>
          {!isPasteOpen && (
            <button
              type="button"
              onClick={() => setIsPasteOpen(true)}
              className="text-xs font-medium text-primary transition-colors hover:text-primary-hover"
            >
              {i18nService.t('browserLoginPasteUrl')}
            </button>
          )}
          {isTimedOut && (
            <button
              type="button"
              disabled={isBusy}
              onClick={() => runBusy(() => authService.login())}
              className="text-xs font-medium text-secondary transition-colors hover:text-foreground disabled:cursor-wait disabled:opacity-60"
            >
              {i18nService.t('browserLoginRetry')}
            </button>
          )}
        </div>
        {isPasteOpen && (
          <form className="mt-2" onSubmit={submitPastedUrl}>
            <div className="flex items-center gap-2">
              <input
                type="text"
                autoFocus
                value={pastedUrl}
                onChange={(event) => {
                  setPastedUrl(event.target.value);
                  setPasteErrorKey(null);
                }}
                placeholder={i18nService.t('browserLoginPastePlaceholder')}
                aria-label={i18nService.t('browserLoginPastePlaceholder')}
                spellCheck={false}
                className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-surface px-2.5 py-1.5 text-xs text-foreground transition-colors placeholder:text-secondary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
              />
              <button
                type="submit"
                disabled={isBusy || !pastedUrl.trim()}
                className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
              >
                {i18nService.t('browserLoginPasteSubmit')}
              </button>
            </div>
            {pasteErrorKey && (
              <p className="mt-1 text-xs leading-5 text-red-600 dark:text-red-400">{i18nService.t(pasteErrorKey)}</p>
            )}
          </form>
        )}
      </div>
      <button
        type="button"
        onClick={() => authService.dismissBrowserLogin()}
        aria-label={i18nService.t('close')}
        title={i18nService.t('close')}
        className="-mr-1 -mt-0.5 shrink-0 rounded-full p-1 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
      >
        <XMarkIcon className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
};

/**
 * Shown while the portal login runs in the system browser. Offers the other
 * callback transport for browsers that never hand the login code back, e.g.
 * when an extension blocks the portal's jump to http://127.0.0.1, and a paste
 * box for browsers that block both transports.
 */
const BrowserLoginNotice: React.FC = () => {
  const browserLogin = useSelector((state: RootState) => state.auth.browserLogin);
  const isLoggedIn = useSelector((state: RootState) => state.auth.isLoggedIn);

  if (isLoggedIn || browserLogin.status === BrowserLoginStatus.Idle) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-[10060] flex justify-center px-4">
      {/* Keyed by attempt so a new login starts with a closed, empty paste box. */}
      <BrowserLoginNoticeCard key={browserLogin.attemptId} browserLogin={browserLogin} />
    </div>
  );
};

export default BrowserLoginNotice;
