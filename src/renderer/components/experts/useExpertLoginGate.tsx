import { ExpertUiEvent } from '@shared/agent/presets';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { authService } from '../../services/auth';
import { canResumeExpertAfterLogin, needsExpertLogin } from '../../services/expertLogin';
import { i18nService } from '../../services/i18n';
import { type RootState, store } from '../../store';
import ChatLoginExperienceModal from '../cowork/ChatLoginExperienceModal';

/** Keep an explicit summon intent while the browser login and model load finish. */
export function useExpertLoginGate() {
  const [showPrompt, setShowPrompt] = useState(false);
  const [openingLogin, setOpeningLogin] = useState(false);
  const pending = useRef<(() => void) | null>(null);
  const opening = useRef(false);
  const mounted = useRef(false);
  const ready = useSelector((state: RootState) => canResumeExpertAfterLogin(state));

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pending.current = null; };
  }, []);

  useEffect(() => {
    if (!ready || !pending.current) return;
    const resume = pending.current;
    pending.current = null;
    setShowPrompt(false);
    resume();
  }, [ready]);

  const requestLogin = useCallback((resume: () => void): boolean => {
    // Read at invocation time, including when an older callback resumes.
    if (!needsExpertLogin(store.getState())) return false;
    window.dispatchEvent(new Event(ExpertUiEvent.Preparing));
    pending.current = resume;
    setShowPrompt(true);
    return true;
  }, []);

  const startLogin = async () => {
    if (opening.current) return;
    opening.current = true;
    setOpeningLogin(true);
    try {
      const result = await authService.login();
      if (!mounted.current) return;
      if (result.success) setShowPrompt(false);
      else if (!result.redirectUrl) {
        window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('welcomeLoginFailed') }));
      }
    } catch (error) {
      console.warn('[ExpertLogin] Failed to open login:', error);
      if (mounted.current) window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('welcomeLoginFailed') }));
    } finally {
      opening.current = false;
      if (mounted.current) setOpeningLogin(false);
    }
  };

  const loginPrompt = showPrompt ? <ChatLoginExperienceModal
    loginPending={openingLogin}
    onStart={() => { void startLogin(); }}
    onClose={() => { pending.current = null; setShowPrompt(false); }}
  /> : null;
  return { requestLogin, loginPrompt };
}
