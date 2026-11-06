import {
  ArrowTopRightOnSquareIcon, ChevronDownIcon, FilmIcon, PhotoIcon, VideoCameraIcon,
} from '@heroicons/react/24/outline';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  ConfirmationBehavior,
  MediaConfirmationAction,
  type MediaConfirmationCommand,
  MediaConfirmationStatus,
  readMediaConfirmationState,
  readVideoConfirmationDetails,
  VideoReferenceKind,
} from '../../../../shared/media/confirmation';
import { i18nService } from '../../../services/i18n';
import type { DockRequest } from './questionDockModel';

const smallIcon = '!h-3.5 !w-3.5';
const buttonClass = 'inline-flex h-9 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-4 text-[13px] font-medium transition-colors disabled:cursor-default disabled:opacity-40';
const formatCredits = (credits: number) => credits.toLocaleString(undefined, { maximumFractionDigits: 1 });

/**
 * Paid video confirmation, docked where questions appear. Cost and the primary
 * action sit together in the footer; the request reads as a description,
 * its references and parameter chips instead of one paragraph of prose.
 * There is no deadline: confirming re-checks a stale price in the main process.
 */
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
  const rawQuestions = request.permission.toolInput?.questions;
  const details = readVideoConfirmationDetails(Array.isArray(rawQuestions) ? (rawQuestions[0] as { video?: unknown } | undefined)?.video : undefined);
  const card = useRef<HTMLElement>(null);
  const promptText = useRef<HTMLParagraphElement>(null);
  const flight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const t = (key: string) => i18nService.t(key);
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
  useLayoutEffect(() => {
    const element = promptText.current;
    if (element && !expanded) setClamped(element.scrollHeight > element.clientHeight + 1);
  }, [details?.prompt, expanded, hidden]);

  const visible = state.status === MediaConfirmationStatus.Visible;
  const repricing = state.status === MediaConfirmationStatus.Refreshing;
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
  const heading = question.heading ?? question.title;
  const specs = details ? [
    [t('mediaVideoConfirmModel'), details.model],
    details.resolution && [t('mediaVideoConfirmResolution'), details.resolution],
    details.durationSeconds !== undefined && [t('mediaVideoConfirmDuration'), t('mediaVideoConfirmDurationValue').replace('{seconds}', String(details.durationSeconds))],
    details.aspectRatio && [t('mediaVideoConfirmAspectRatio'), details.aspectRatio],
  ].filter((spec): spec is string[] => Array.isArray(spec)) : [];
  const credits = details?.estimatedCredits;
  const previousCredits = state.repriced?.previousCredits;
  const [finePrintBefore, finePrintAfter = ''] = t('mediaVideoConfirmFinePrint').split('{link}');
  return (
    <section
      ref={card}
      className="cowork-question-dock"
      aria-label={heading}
      data-media-confirmation={state.status}
      hidden={hidden}
      style={hidden ? { display: 'none' } : undefined}
    >
      <header className="!items-center !gap-3 !pb-3">
        <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <FilmIcon className="!h-5 !w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2>{heading}</h2>
          <p className="text-xs leading-5 text-secondary">{t('mediaVideoConfirmSummary')}</p>
        </div>
        {queueCount > 1 && <span className="shrink-0 rounded-full bg-surface-raised px-2 py-0.5 text-xs text-secondary">{queueCount}</span>}
      </header>
      <div className="cowork-question-page space-y-3 px-3 pb-1">
        {details ? (
          <>
            <div className="rounded-2xl bg-surface-raised px-4 py-3">
              <div className="mb-1 text-xs font-medium text-secondary">{t('mediaVideoConfirmPrompt')}</div>
              <p ref={promptText} className={`whitespace-pre-wrap break-words text-sm leading-6 ${expanded ? '' : 'line-clamp-3'}`}>{details.prompt}</p>
              {(clamped || expanded) && (
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setExpanded(value => !value)}
                  className="mt-1 inline-flex items-center gap-0.5 text-xs text-secondary hover:text-foreground"
                >
                  {t(expanded ? 'mediaVideoConfirmShowLess' : 'mediaVideoConfirmShowMore')}
                  <ChevronDownIcon className={`${smallIcon} transition-transform ${expanded ? 'rotate-180' : ''}`} />
                </button>
              )}
            </div>
            {details.references.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="mr-1 text-xs text-secondary">{t('mediaVideoConfirmReferences')}</span>
                {details.references.map((reference, index) => {
                  const label = t(reference.kind === VideoReferenceKind.Video ? 'mediaVideoConfirmReferenceVideo' : 'mediaVideoConfirmReferenceImage');
                  return reference.thumbnail
                    ? <img key={index} src={reference.thumbnail} alt={label} title={label} draggable={false}
                      className="h-12 w-12 rounded-lg object-cover ring-1 ring-border" />
                    : <span key={index} role="img" aria-label={label} title={label}
                      className="flex h-12 w-12 items-center justify-center rounded-lg bg-surface-raised text-secondary ring-1 ring-border">
                      {reference.kind === VideoReferenceKind.Video ? <VideoCameraIcon /> : <PhotoIcon />}
                    </span>;
                })}
              </div>
            )}
            <ul className="flex flex-wrap gap-1.5">
              {specs.map(([label, value]) => (
                <li key={label} className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs">
                  <span className="shrink-0 text-secondary">{label}</span>
                  <span className="truncate font-medium" title={value}>{value}</span>
                </li>
              ))}
              {details.audio && (
                <li className="inline-flex items-center rounded-lg border border-border px-2.5 py-1 text-xs font-medium">{t('mediaVideoConfirmAudio')}</li>
              )}
            </ul>
          </>
        ) : (
          <p className="cowork-question-description !px-0">{question.title}</p>
        )}
      </div>
      {state.repriced && (
        <p role="status" className="mx-3 mt-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-300">
          {t('mediaVideoConfirmRepriced')}
        </p>
      )}
      <footer className="mx-3 mt-3 border-t border-border !px-0 !pt-3">
        <div className="min-w-0 flex-1">
          {details ? (
            <>
              <div className="text-[11px] leading-4 text-secondary">{t('mediaVideoConfirmEstimateLabel')}</div>
              <div className="flex flex-wrap items-baseline gap-x-2">
                {previousCredits !== undefined && credits !== undefined && previousCredits !== credits && (
                  <s className="text-xs tabular-nums text-secondary">{formatCredits(previousCredits)}</s>
                )}
                <span className="text-base font-semibold tabular-nums">
                  {credits !== undefined
                    ? t('mediaVideoConfirmCredits').replace('{credits}', formatCredits(credits))
                    : t('mediaVideoConfirmCostUnavailable')}
                </span>
                <span className="text-[11px] text-secondary">{credits !== undefined ? t('mediaVideoConfirmCreditsNote') : details.pricingNote}</span>
              </div>
            </>
          ) : (
            question.subtitle && <p className="whitespace-pre-wrap text-xs leading-5 text-secondary">{question.subtitle}</p>
          )}
        </div>
        <button
          type="button"
          className={`${buttonClass} border border-border hover:bg-surface-raised`}
          disabled={busy}
          onClick={() => {
            void act(MediaConfirmationAction.Respond, false);
          }}
        >
          {t('mediaVideoConfirmCancel')}
        </button>
        <button
          type="button"
          className={`${buttonClass} bg-foreground text-background hover:bg-foreground/90`}
          disabled={busy || !visible}
          aria-busy={repricing}
          onClick={() => {
            void act(MediaConfirmationAction.Respond, true);
          }}
        >
          {repricing && <span aria-hidden="true" className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
          {repricing ? t('mediaVideoConfirmRepricing') : question.options[0].label}
        </button>
      </footer>
      {failed && (
        <p className="cowork-question-hint !text-red-500" role="alert">
          {t('mediaVideoConfirmActionFailed')}
        </p>
      )}
      {details && (
        <p className="cowork-question-hint !pt-2">
          {finePrintBefore}
          <button
            type="button"
            className="inline-flex items-center gap-0.5 text-secondary underline decoration-border underline-offset-2 hover:text-foreground"
            onClick={() => { void window.electron?.shell?.openExternal(details.portalUrl); }}
          >
            {t('mediaVideoConfirmPortal')}<ArrowTopRightOnSquareIcon className="!h-3 !w-3" />
          </button>
          {finePrintAfter}
        </p>
      )}
    </section>
  );
}
