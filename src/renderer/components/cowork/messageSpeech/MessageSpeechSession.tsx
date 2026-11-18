import { useCallback, useEffect, useState } from 'react';
import { useSelector } from 'react-redux';

import { LanguageToolCode } from '../../../../shared/desktopCompanion/languageTools';
import { i18nService } from '../../../services/i18n';
import { messageSpeechService } from '../../../services/messageSpeech';
import type { RootState } from '../../../store';
import { ModelAccessPromptKind, ModelAccessPromptModal } from '../../ModelSelector';
import Toast from '../../Toast';

const ERROR_KEYS: Record<number, string> = {
  [LanguageToolCode.TooLong]: 'coworkReadAloudTooLong',
  [LanguageToolCode.InvalidInput]: 'desktopToolsInvalidInput',
  [LanguageToolCode.DailyLimit]: 'desktopToolsDailyLimit',
  [LanguageToolCode.RateLimit]: 'desktopToolsRateLimit',
  [LanguageToolCode.Duplicate]: 'desktopToolsDuplicate',
  [LanguageToolCode.Unavailable]: 'coworkReadAloudUnavailable',
};

/** Mounted once in the main chat, outside the virtualized turns. Login never queues playback. */
export default function MessageSpeechSession({ sessionId }: { sessionId: string }) {
  const isLoggedIn = useSelector((state: RootState) => state.auth.isLoggedIn);
  const accountGeneration = useSelector((state: RootState) => state.auth.accountGeneration);
  const [showLogin, setShowLogin] = useState(false);
  const [toast, setToast] = useState('');
  const onError = useCallback((code: number) => {
    if (code === LanguageToolCode.Unauthorized) setShowLogin(true);
    else setToast(i18nService.t(ERROR_KEYS[code] ?? 'coworkReadAloudFailed'));
  }, []);

  useEffect(() => {
    setShowLogin(false);
    setToast('');
    return messageSpeechService.connect(sessionId, onError);
  }, [sessionId, accountGeneration, onError]);
  useEffect(() => { if (isLoggedIn) setShowLogin(false); }, [isLoggedIn]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 4_000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  return (
    <>
      {showLogin && (
        <ModelAccessPromptModal
          promptKind={ModelAccessPromptKind.Login}
          titleKey="coworkReadAloudLoginTitle"
          descriptionKey="coworkReadAloudLoginDesc"
          showLearnMore={false}
          onClose={() => setShowLogin(false)}
        />
      )}
      {toast && <Toast message={toast} closeLabel={i18nService.t('close')} onClose={() => setToast('')} />}
    </>
  );
}
