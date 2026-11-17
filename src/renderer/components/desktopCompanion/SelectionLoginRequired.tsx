import { useEffect, useRef, useState } from 'react';

import {
  CompanionAnalyticsAction, CompanionAnalyticsInteraction, CompanionAnalyticsReason, type CompanionAnalyticsSource,
} from '../../../shared/desktopCompanion/analytics';
import type { DesktopCompanionLoginStart } from '../../../shared/desktopCompanion/constants';
import type { LanguageToolQuota, LanguageToolResume } from '../../../shared/desktopCompanion/languageTools';
import { authService } from '../../services/auth';
import { configService } from '../../services/config';
import { i18nService } from '../../services/i18n';
import { reportCompanionAnalytics } from './analytics';

const t = (key: string) => i18nService.t(key);

interface SelectionLoginRequiredProps {
  source: CompanionAnalyticsSource;
  tool: DesktopCompanionLoginStart['tool'];
  /** The feature's name as the card or toolbar shows it. */
  feature: string;
  /** Changes with each request, so its prompt is counted as shown once. */
  contextId: string;
  /** What a language tools card picks up again after the sign-in. */
  resume?: LanguageToolResume;
  /** Present only when the server reports an exhausted anonymous translation allowance. */
  translationQuota?: LanguageToolQuota;
}

/**
 * Says what signing in unlocks and keeps the card open through the browser sign-in, so the request
 * continues once the user is back. Uses the same portal resolution and callback flow as the main window.
 */
export default function SelectionLoginRequired({ source, tool, feature, contextId, resume, translationQuota }: SelectionLoginRequiredProps) {
  const [opening, setOpening] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [failed, setFailed] = useState(false);
  const journey = useRef<{ key: string; id: string } | null>(null);
  const reason = translationQuota ? CompanionAnalyticsReason.AnonymousTranslationDailyLimit : undefined;

  useEffect(() => {
    const key = `${contextId}:${tool}:${reason ?? ''}`;
    if (journey.current?.key === key) return;
    journey.current = { key, id: crypto.randomUUID() };
    setWaiting(false);
    setFailed(false);
    reportCompanionAnalytics({
      action: CompanionAnalyticsAction.Action, source, interactionType: CompanionAnalyticsInteraction.LoginShown,
      tool, journeyId: journey.current.id,
      ...(reason ? { reason } : {}),
    });
  }, [contextId, source, tool, reason]);

  const login = async () => {
    if (opening) return;
    setOpening(true);
    setFailed(false);
    try {
      // Pin the card before the browser takes focus, or it closes and loses the request.
      await window.electron.desktopCompanion.startLogin({
        tool, journeyId: journey.current?.id, ...(resume ? { resume } : {}),
        ...(reason ? { reason } : {}),
      }).catch(() => undefined);
      await configService.init();
      const result = await authService.login();
      setFailed(!result.success);
      setWaiting(result.success);
    } catch {
      setFailed(true);
      setWaiting(false);
    } finally {
      setOpening(false);
    }
  };

  const title = translationQuota
    ? t('desktopToolsGuestTranslationExhausted').replace('{limit}', String(translationQuota.limitRequests))
    : t('desktopToolsLoginTitle').replace('{feature}', feature);
  const benefit = translationQuota
    ? t(translationQuota.unlimitedAfterLogin === true ? 'desktopToolsTranslationUnlimitedAfterLogin' : 'desktopToolsTranslationContinueAfterLogin')
    : t('loginIntroductionPromo');
  const state = failed ? 'failed' : waiting ? 'waiting' : 'idle';
  // The card header already carries the LobsterAI mark; the prompt stays a quiet row of text and one button.
  return (
    <div className="sel-login" role="group" aria-label={title} data-state={state}>
      <div className="sel-login-text">
        <strong>{title}</strong>
        <span role={failed ? 'alert' : waiting ? 'status' : undefined}>
          {state === 'waiting' && <span className="sel-dots" aria-hidden="true"><i /><i /><i /></span>}
          {failed ? t('desktopToolsLoginFailed') : waiting ? t('desktopToolsLoginWaiting') : benefit}
        </span>
      </div>
      <button type="button" className="sel-login-button" data-waiting={waiting} disabled={opening}
        onClick={() => { void login(); }}>
        {t(waiting ? 'desktopToolsLoginReopen' : translationQuota ? 'desktopToolsLoginTranslate' : 'desktopToolsLoginAction')}
      </button>
    </div>
  );
}
