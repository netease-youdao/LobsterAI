import { ArrowPathIcon, ExclamationTriangleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { AuthCallbackTransport } from '@shared/auth/constants';
import React, { useState } from 'react';
import { useSelector } from 'react-redux';

import { authService } from '../../services/auth';
import { i18nService } from '../../services/i18n';
import type { RootState } from '../../store';
import { BrowserLoginStatus } from '../../store/slices/authSlice';

/**
 * Shown while the portal login runs in the system browser. Offers the other
 * callback transport for browsers that never hand the login code back, e.g.
 * when an extension blocks the portal's jump to http://127.0.0.1.
 */
const BrowserLoginNotice: React.FC = () => {
  const browserLogin = useSelector((state: RootState) => state.auth.browserLogin);
  const isLoggedIn = useSelector((state: RootState) => state.auth.isLoggedIn);
  const [isReopening, setIsReopening] = useState(false);

  if (isLoggedIn || browserLogin.status === BrowserLoginStatus.Idle) return null;

  const isTimedOut = browserLogin.status === BrowserLoginStatus.TimedOut;
  const hintKey = browserLogin.transport === AuthCallbackTransport.DeepLink
    ? 'browserLoginDeepLinkHint'
    : 'browserLoginLoopbackHint';

  const reopenLogin = (login: () => Promise<unknown>) => {
    if (isReopening) return;
    setIsReopening(true);
    void login()
      .catch((error) => {
        console.warn('[BrowserLoginNotice] failed to reopen the browser login:', error);
      })
      .finally(() => setIsReopening(false));
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-[10060] flex justify-center px-4">
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
              disabled={isReopening}
              onClick={() => reopenLogin(() => authService.loginWithAlternateTransport())}
              className="text-xs font-medium text-primary transition-colors hover:text-primary-hover disabled:cursor-wait disabled:opacity-60"
            >
              {i18nService.t('browserLoginSwitchTransport')}
            </button>
            {isTimedOut && (
              <button
                type="button"
                disabled={isReopening}
                onClick={() => reopenLogin(() => authService.login())}
                className="text-xs font-medium text-secondary transition-colors hover:text-foreground disabled:cursor-wait disabled:opacity-60"
              >
                {i18nService.t('browserLoginRetry')}
              </button>
            )}
          </div>
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
    </div>
  );
};

export default BrowserLoginNotice;
