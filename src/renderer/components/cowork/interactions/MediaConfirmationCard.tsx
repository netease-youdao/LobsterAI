import { useEffect, useRef, useState } from 'react';

import {
  ConfirmationBehavior,
  MediaConfirmationAction,
  type MediaConfirmationCommand,
  MediaConfirmationPolicy,
  MediaConfirmationStatus,
  readMediaConfirmationState,
} from '../../../../shared/media/confirmation';
import { i18nService } from '../../../services/i18n';
import type { DockRequest } from './questionDockModel';

export default function MediaConfirmationCard({
  request,
  queueCount = 1,
  hidden = false,
}: {
  request: DockRequest;
  queueCount?: number;
  hidden?: boolean;
}) {
  const state = readMediaConfirmationState(request.permission.toolInput?.mediaConfirmation)!;
  const question = request.questions[0];
  const card = useRef<HTMLElement>(null);
  const flight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(Date.now);
  const t = (key: string) => i18nService.t(key);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (hidden || state.status !== MediaConfirmationStatus.Waiting) return;
    let sending = false;
    let disposed = false;
    const shown = async () => {
      const element = card.current;
      if (
        !element ||
        disposed ||
        sending ||
        document.visibilityState !== 'visible' ||
        !document.hasFocus()
      )
        return;
      const box = element.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0 || box.bottom <= 0 || box.top >= window.innerHeight)
        return;
      const api = window.electron?.cowork?.mediaConfirmation;
      if (!api) return;
      sending = true;
      try {
        await api({
          requestId: request.requestId,
          revision: state.revision,
          action: MediaConfirmationAction.Shown,
        });
      } catch {
        /* Retry on the next visibility/focus change. */
      } finally {
        sending = false;
      }
    };
    const observer = new IntersectionObserver(() => {
      void shown();
    });
    if (card.current) observer.observe(card.current);
    document.addEventListener('visibilitychange', shown);
    window.addEventListener('focus', shown);
    void shown();
    return () => {
      disposed = true;
      observer.disconnect();
      document.removeEventListener('visibilitychange', shown);
      window.removeEventListener('focus', shown);
    };
  }, [hidden, request.requestId, state.revision, state.status]);

  const expired =
    state.status === MediaConfirmationStatus.Expired ||
    (state.status === MediaConfirmationStatus.Visible && (state.expiresAt ?? 0) <= now);
  const refreshing = state.status === MediaConfirmationStatus.Refreshing;
  const act = async (action: MediaConfirmationAction, approve?: boolean) => {
    if (flight.current) return;
    const api = window.electron?.cowork?.mediaConfirmation;
    if (!api) {
      setFailed(true);
      return;
    }
    flight.current = true;
    setBusy(true);
    setFailed(false);
    const command: MediaConfirmationCommand = {
      requestId: request.requestId,
      revision: state.revision,
      action,
    };
    if (action === MediaConfirmationAction.Respond)
      command.response = approve
        ? {
            behavior: ConfirmationBehavior.Allow,
            answers: { [question.title]: question.options[0].label },
          }
        : { behavior: ConfirmationBehavior.Deny };
    try {
      setFailed(!(await api(command)).success);
    } catch {
      setFailed(true);
    } finally {
      flight.current = false;
      setBusy(false);
    }
  };
  return (
    <section
      ref={card}
      className="cowork-question-dock"
      aria-label={question.heading ?? question.title}
      hidden={hidden}
      style={hidden ? { display: 'none' } : undefined}
    >
      <header>
        <h2>{question.heading ?? question.title}</h2>
        {queueCount > 1 && <span>{queueCount}</span>}
      </header>
      {question.subtitle && (
        <p className="cowork-question-hint cowork-question-subtitle">{question.subtitle}</p>
      )}
      <div className="cowork-question-page">
        <p className="cowork-question-description">{question.title}</p>
      </div>
      <p className="cowork-question-hint" role="status">
        {refreshing
          ? t('mediaVideoConfirmRefreshing')
          : expired
            ? t('mediaVideoConfirmExpired')
            : state.status === MediaConfirmationStatus.Visible
              ? t('mediaVideoConfirmRemaining').replace(
                  '{seconds}',
                  String(Math.min(MediaConfirmationPolicy.ReviewMs / 1000, Math.max(0, Math.ceil(((state.expiresAt ?? now) - now) / 1000)))),
                )
              : t('mediaVideoConfirmWaiting')}
      </p>
      {failed && (
        <p className="cowork-question-hint" role="alert">
          {t('mediaVideoConfirmActionFailed')}
        </p>
      )}
      <footer>
        {expired || refreshing ? (
          <button
            type="button"
            className="cowork-question-option"
            disabled={busy || refreshing}
            onClick={() => {
              void act(MediaConfirmationAction.Renew);
            }}
          >
            {t('mediaVideoConfirmRenew')}
          </button>
        ) : (
          <button
            type="button"
            className="cowork-question-option"
            disabled={busy || state.status !== MediaConfirmationStatus.Visible}
            onClick={() => {
              void act(MediaConfirmationAction.Respond, true);
            }}
          >
            {question.options[0].label}
          </button>
        )}
        <button
          type="button"
          className="cowork-question-option"
          disabled={busy}
          onClick={() => {
            void act(MediaConfirmationAction.Respond, false);
          }}
        >
          {t('mediaVideoConfirmCancel')}
        </button>
      </footer>
    </section>
  );
}
