import React, { useEffect, useRef, useState } from 'react';

import { reportOnboardingAction } from '../../services/onboardingAnalytics';
import ChatLoginExperienceModal from '../cowork/ChatLoginExperienceModal';

const INTRODUCTION_SEEN_STORAGE_KEY = 'login_introduction_seen';

interface FirstRunLoginIntroductionProps {
  children: React.ReactNode;
  onStartExperience: () => Promise<void>;
}

/** Mounted only for a new device, after the existing startup gates resolve. */
const FirstRunLoginIntroduction: React.FC<FirstRunLoginIntroductionProps> = ({
  children,
  onStartExperience,
}) => {
  const [hasSeenIntroduction, setHasSeenIntroduction] = useState<boolean | null>(null);
  const [loginPending, setLoginPending] = useState(false);
  const loginPendingRef = useRef(false);

  useEffect(() => {
    let active = true;
    void window.electron.store.get(INTRODUCTION_SEEN_STORAGE_KEY)
      .then((seen) => {
        if (active) setHasSeenIntroduction(seen === true);
      })
      .catch((error) => {
        console.warn('[Onboarding] failed to read login introduction state:', error);
        if (active) setHasSeenIntroduction(false);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (hasSeenIntroduction !== false) return;
    reportOnboardingAction('login_introduction_exposure', { source: 'first_run_gate' });
    // Record exposure, so restarting without clicking an action also counts as seen.
    void window.electron.store.set(INTRODUCTION_SEEN_STORAGE_KEY, true)
      .catch((error) => {
        console.warn('[Onboarding] failed to persist login introduction state:', error);
      });
  }, [hasSeenIntroduction]);

  if (hasSeenIntroduction === null) return null;
  if (hasSeenIntroduction) return <>{children}</>;

  return (
    <ChatLoginExperienceModal
      loginPending={loginPending}
      onClose={() => {
        reportOnboardingAction('login_introduction_skip_click', { source: 'first_run_gate' });
        setHasSeenIntroduction(true);
      }}
      onStart={() => {
        if (loginPendingRef.current) return;
        loginPendingRef.current = true;
        setLoginPending(true);
        void onStartExperience().finally(() => {
          loginPendingRef.current = false;
          setLoginPending(false);
        });
      }}
    />
  );
};

export default FirstRunLoginIntroduction;
