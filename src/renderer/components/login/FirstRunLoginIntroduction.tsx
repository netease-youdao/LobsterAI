import { CloudIcon, ComputerDesktopIcon, KeyIcon, SparklesIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useState } from 'react';

import { authService } from '../../services/auth';
import { i18nService } from '../../services/i18n';
import { reportOnboardingAction } from '../../services/onboardingAnalytics';
import ChatLoginExperienceModal from '../cowork/ChatLoginExperienceModal';
import BrowserLoginWaitPanel from './BrowserLoginWaitPanel';
import { useBrowserLoginSession } from './useBrowserLoginSession';

const SERVICE_TERMS_URL = 'https://c.youdao.com/dict/hardware/lobsterai/lobsterai_service.html';

interface FirstRunLoginIntroductionProps {
  onContinueAsGuest: () => Promise<void>;
}

/** The first-run gate is completed by authentication or an explicit guest choice. */
const FirstRunLoginIntroduction: React.FC<FirstRunLoginIntroductionProps> = ({ onContinueAsGuest }) => {
  const session = useBrowserLoginSession();
  const [showGuest, setShowGuest] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [continueFailed, setContinueFailed] = useState(false);
  const t = i18nService.t.bind(i18nService);

  useEffect(() => {
    reportOnboardingAction('login_introduction_exposure', { source: 'first_run_gate' });
    // Exposure alone must never persist a completed first-run choice.
  }, []);

  const start = () => {
    reportOnboardingAction('guide_start_experience_click', { source: 'first_run_gate' });
    void authService.login().catch(() => {
      // The shared login session retains the inline error and retry action.
    });
  };

  const cancel = () => {
    reportOnboardingAction('login_cancel_click', { source: 'first_run_gate' });
    void authService.cancelLogin();
    setShowGuest(false);
  };

  const close = () => {
    if (continuing) return;
    if (session) {
      cancel();
    } else {
      setContinueFailed(false);
      setShowGuest(value => !value);
    }
  };

  const continueAsGuest = async () => {
    if (continuing) return;
    setContinuing(true);
    setContinueFailed(false);
    try {
      await onContinueAsGuest();
      reportOnboardingAction('login_introduction_skip_click', { source: 'first_run_gate' });
    } catch (error) {
      console.error('[Onboarding] failed to complete the guest choice:', error);
      setContinueFailed(true);
      setContinuing(false);
    }
  };

  const [noticeBefore, noticeAfter] = t('welcomeAgreementNotice').split('{link}');
  const agreement = (
    <p className="login-first-run-agreement">
      {noticeBefore}
      <button type="button" onClick={() => { void window.electron.shell.openExternal(SERVICE_TERMS_URL); }}>
        {t('welcomeAgreementLinkText')}
      </button>
      {noticeAfter}
    </p>
  );

  return (
    <ChatLoginExperienceModal
      loginPending={session !== null}
      onStart={start}
      onClose={close}
      showcasePaused={session !== null || showGuest}
      hideClose={session !== null || showGuest}
      dismissOnBackdrop={false}
    >
      {session ? <BrowserLoginWaitPanel session={session} onRetry={start} onCancel={cancel} /> : showGuest ? (
        <div className="login-first-run-panel" data-testid="first-run-guest">
          <div>
            <p className="login-first-run-eyebrow">{t('firstRunGuestEyebrow')}</p>
            <h1 className="login-first-run-title">{t('firstRunGuestTitle')}</h1>
            <p className="login-first-run-description">{t('firstRunGuestDescription')}</p>
          </div>
          <div className="login-first-run-benefits">
            <p><ComputerDesktopIcon aria-hidden="true" />{t('firstRunGuestLocal')}</p>
            <p><KeyIcon aria-hidden="true" />{t('firstRunGuestModels')}</p>
            <p className="login-first-run-note">{t('firstRunGuestLimitations')}</p>
          </div>
          <div className="login-first-run-actions">
            <button type="button" className="login-first-run-secondary" disabled={continuing} onClick={() => { void continueAsGuest(); }}>
              {t(continuing ? 'loading' : 'firstRunGuestContinue')}
            </button>
            <button type="button" className="login-first-run-text" disabled={continuing} onClick={close}>{t('firstRunBackToLogin')}</button>
            {continueFailed && <p role="alert" className="login-first-run-note">{t('firstRunContinueFailed')}</p>}
          </div>
          {agreement}
        </div>
      ) : (
        <div className="login-first-run-panel" data-testid="first-run-welcome">
          <div className="relative isolate">
            <div className="login-introduction-glow" aria-hidden="true" />
            <p className="login-first-run-eyebrow">{t('chatLoginExperienceTitlePrefix')}</p>
            <h1 className="login-introduction-brand flex items-center gap-2 font-semibold tracking-[-1px]">
              LobsterAI<img src="logo.png" alt="" width={28} height={28} className="shrink-0 rounded-lg" draggable={false} />
            </h1>
            <p className="login-first-run-description">{t('firstRunLoginDescription')}</p>
          </div>
          <div className="login-first-run-benefits">
            <p><SparklesIcon aria-hidden="true" />{t('firstRunAccountModels')}</p>
            <p><CloudIcon aria-hidden="true" />{t('firstRunCloudResources')}</p>
          </div>
          <div className="login-first-run-actions">
            <button type="button" className="login-first-run-primary" onClick={start}>{t('firstRunLoginStart')}</button>
            <p className="login-first-run-note text-center">{t('firstRunBrowserHandoffHint')}</p>
          </div>
          {agreement}
        </div>
      )}
    </ChatLoginExperienceModal>
  );
};

export default FirstRunLoginIntroduction;
