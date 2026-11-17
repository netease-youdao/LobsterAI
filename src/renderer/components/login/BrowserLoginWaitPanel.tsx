import { ArrowTopRightOnSquareIcon, CheckIcon } from '@heroicons/react/24/outline';
import { useEffect, useState } from 'react';

import { authService } from '../../services/auth';
import { type BrowserLoginSessionState, BrowserLoginStatus } from '../../services/browserLoginSession';
import { i18nService } from '../../services/i18n';
import { useCopyLoginLink } from './useBrowserLoginSession';

const LOGIN_HELP_DELAY_MS = 30_000;

export default function BrowserLoginWaitPanel({ session, onRetry, onCancel }: {
  session: BrowserLoginSessionState;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkedWithoutLogin, setCheckedWithoutLogin] = useState(false);
  const { copied, copy } = useCopyLoginLink('first_run_gate');
  const t = i18nService.t.bind(i18nService);
  const opening = session.status === BrowserLoginStatus.Opening;
  const verifying = session.status === BrowserLoginStatus.Verifying;
  const openFailed = session.status === BrowserLoginStatus.OpenFailed;
  const expired = session.status === BrowserLoginStatus.Expired;
  const failed = session.status === BrowserLoginStatus.Failed;
  const busy = opening || verifying;
  const waiting = session.status === BrowserLoginStatus.Waiting;
  const needsRetry = expired || failed;
  const step = opening || openFailed ? 0 : verifying ? 2 : 1;
  const title = opening ? 'firstRunOpeningTitle' : verifying ? 'firstRunVerifyingTitle'
    : expired ? 'firstRunExpiredTitle' : failed ? 'firstRunFailedTitle'
      : openFailed ? 'browserLoginOpenFailedTitle' : 'browserLoginWaitingTitle';
  const hint = opening ? 'firstRunOpeningHint' : verifying ? 'firstRunVerifyingHint'
    : expired ? 'firstRunExpiredHint' : failed ? 'firstRunFailedHint'
      : openFailed ? 'firstRunOpenFailedHint' : 'firstRunWaitingHint';
  const status = opening ? 'chatLoginExperienceStarting' : verifying ? 'firstRunVerifyingStatus'
    : expired ? 'firstRunExpiredStatus' : failed ? 'firstRunFailedStatus'
      : openFailed ? 'browserLoginOpenFailedTitle' : 'firstRunWaitingStatus';

  useEffect(() => {
    setHelpOpen(false);
    setCheckedWithoutLogin(false);
    if (!waiting) return;
    const timer = window.setTimeout(() => setHelpOpen(true), LOGIN_HELP_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [session, waiting]);

  const checkLogin = async () => {
    setChecking(true);
    try {
      const result = await authService.refreshAuthState();
      setCheckedWithoutLogin(!result.isLoggedIn);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="login-first-run-panel" data-testid="first-run-login-wait" data-state={session.status}>
      <div>
        <p className="login-first-run-eyebrow">{t('firstRunConnectingAccount')}</p>
        <h1 className="login-first-run-title">{t(title)}</h1>
        <p className="login-first-run-description">{t(hint)}</p>
      </div>
      <ol className="login-first-run-steps" aria-label={t('firstRunLoginProgress')}>
        {['firstRunStepBrowser', 'firstRunStepWeb', 'firstRunStepClient'].map((label, index) => (
          <li key={label} aria-current={index === step ? 'step' : undefined} data-complete={index < step}>
            <span className="login-first-run-step-number">{index < step ? <CheckIcon aria-hidden="true" /> : index + 1}</span>
            <span>{t(label)}</span>
          </li>
        ))}
      </ol>
      <div className="login-first-run-status" role="status" aria-live="polite">
        {(busy || waiting) && <span className="login-first-run-spinner" aria-hidden="true" />}
        <span>{t(status)}</span>
      </div>
      <div className="login-first-run-actions">
        {openFailed && session.url ? (
          <button type="button" className="login-first-run-primary" onClick={() => { void copy(session.url!); }}>
            {t(copied ? 'copied' : 'browserLoginCopyLoginLink')}
          </button>
        ) : (
          <button type="button" className="login-first-run-secondary" disabled={busy} onClick={onRetry}>
            <ArrowTopRightOnSquareIcon aria-hidden="true" />{t(busy ? status : needsRetry ? 'firstRunLoginRetry' : 'firstRunReopenLogin')}
          </button>
        )}
        <button type="button" className="login-first-run-text" onClick={onCancel}>{t('browserLoginDismiss')}</button>
      </div>
      {(waiting || openFailed) && (
        <div className="login-first-run-help">
          <button type="button" className="login-first-run-text" aria-expanded={helpOpen || openFailed} onClick={() => setHelpOpen(value => !value)}>{t('firstRunLoginHelp')}</button>
          {(helpOpen || openFailed) && <div className="flex flex-wrap justify-center gap-x-4">
            {openFailed ? <button type="button" className="login-first-run-text" onClick={onRetry}>{t('firstRunReopenLogin')}</button>
              : session.url && <button type="button" className="login-first-run-text" onClick={() => { void copy(session.url!); }}>{t(copied ? 'copied' : 'browserLoginCopyLoginLink')}</button>}
            <button type="button" className="login-first-run-text" disabled={checking} onClick={() => { void checkLogin(); }}>{t(checking ? 'firstRunCheckingLogin' : 'firstRunCheckLogin')}</button>
          </div>}
          {checkedWithoutLogin && <p role="status" className="login-first-run-note">{t('firstRunLoginNotConfirmed')}</p>}
        </div>
      )}
    </div>
  );
}
