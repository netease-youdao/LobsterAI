import { ArrowRightCircleIcon, LightBulbIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useRef, useState } from 'react';

import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import type { OpenClawEngineStatus } from '../../types/cowork';

const TIP_KEYS = [
  'engineStartingTip1',
  'engineStartingTip2',
  'engineStartingTip3',
  'engineStartingTip4',
  'engineStartingTip5',
  'engineStartingTip6',
] as const;

const TIP_ROTATE_MS = 5000;
const SLOW_HINT_AFTER_MS = 15000;
// Matches the root's `duration-200`: how long the screen stays mounted while it fades out.
const EXIT_FADE_MS = 200;

// sessionStorage key written by index.html's static splash so the overlay
// continues from the same tip instead of jumping to a different one.
const SPLASH_TIP_INDEX_STORAGE_KEY = 'lobster-splash-tip-index';

const readInitialTipIndex = (): number => {
  try {
    const raw = sessionStorage.getItem(SPLASH_TIP_INDEX_STORAGE_KEY);
    const parsed = raw === null ? Number.NaN : Number(raw);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed < TIP_KEYS.length) {
      return parsed;
    }
  } catch { /* storage unavailable */ }
  // Default to the first tip so every launch reads in order
  return 0;
};

// Module-level so tip position and visibility survive the remount when App
// switches from the bootstrap tree to the main tree.
let persistedTipIndex: number | null = null;
// index.html's static splash shows this same page before React mounts, so the
// overlay must not fade in on app start — only when it appears mid-session.
let overlayWasVisible = true;

const resolveEngineStatusText = (status: OpenClawEngineStatus): string => {
  switch (status.phase) {
    case 'not_installed':
      return i18nService.t('coworkOpenClawNotInstalledNotice');
    case 'installing':
      return i18nService.t('coworkOpenClawInstalling');
    case 'ready':
      return i18nService.t('coworkOpenClawReadyNotice');
    case 'starting':
      return i18nService.t('coworkOpenClawStarting');
    case 'error':
      return i18nService.t('coworkOpenClawError');
    case 'running':
    default:
      return i18nService.t('coworkOpenClawRunning');
  }
};

interface EngineStartupOverlayProps {
  /**
   * Keep the overlay visible while the renderer is still initializing, before
   * engine status gating applies. Lets App render it from the very first
   * frame so startup is one continuous screen.
   */
  bootstrapping?: boolean;
  /**
   * Name of the page an in-app link asked for while this screen covers the app
   * (e.g. a launch ad clicked before the gateway is up). The page is already
   * open underneath; the row tells the user it is waiting for them.
   */
  destinationLabel?: string | null;
  /** Lets the user call that navigation off; the row has no cancel control without it. */
  onCancelDestination?: () => void;
}

/**
 * Global overlay shown when the OpenClaw gateway is starting up.
 * Renders on top of all views (cowork, skills, scheduled tasks, mcp).
 * Styled after WelcomeDialog so first-run flows feel continuous, with
 * rotating feature tips to keep the (10s-2min) wait from feeling idle.
 * index.html contains a static pre-React replica of this page; keep the
 * layout in sync so the handoff between the two is invisible.
 */
const EngineStartupOverlay: React.FC<EngineStartupOverlayProps> = ({
  bootstrapping = false,
  destinationLabel = null,
  onCancelDestination,
}) => {
  const [status, setStatus] = useState<OpenClawEngineStatus | null>(
    () => coworkService.getOpenClawEngineStatusSnapshot()
  );
  const [tipIndex, setTipIndex] = useState(() => {
    if (persistedTipIndex === null) {
      persistedTipIndex = readInitialTipIndex();
    }
    return persistedTipIndex;
  });
  const [showSlowHint, setShowSlowHint] = useState(false);
  const hasRotatedTipRef = useRef(false);

  useEffect(() => {
    coworkService.getOpenClawEngineStatus()
      .then((s) => {
        if (s) setStatus(s);
      })
      .catch(() => { /* keep last known status */ });

    const unsubscribe = coworkService.onOpenClawEngineStatus((s) => {
      setStatus(s);
    });

    return unsubscribe;
  }, []);

  const isStarting = status?.phase === 'starting';
  const visible = bootstrapping || isStarting;

  // Fade in only when the overlay appears mid-session (e.g. engine restart),
  // not on app start where the static splash / bootstrap tree already showed it.
  const wasVisibleRef = useRef(overlayWasVisible);
  const animateIn = visible && !wasVisibleRef.current;
  wasVisibleRef.current = visible;
  overlayWasVisible = visible;

  // The row keeps its last label while it collapses, and stays as it was during the
  // fade-out: the parent clears the destination the moment the engine is ready.
  const [destinationRow, setDestinationRow] = useState(() => ({
    label: destinationLabel ?? '',
    open: Boolean(destinationLabel),
  }));
  useEffect(() => {
    if (!visible) return;
    setDestinationRow((previous) => {
      if (destinationLabel) return { label: destinationLabel, open: true };
      return previous.open ? { ...previous, open: false } : previous;
    });
  }, [visible, destinationLabel]);

  // Stay mounted for a short fade-out so the app underneath is revealed rather than cut to.
  const [present, setPresent] = useState(visible);
  useEffect(() => {
    if (visible) {
      setPresent(true);
      return undefined;
    }
    const exitTimer = window.setTimeout(() => {
      setPresent(false);
      // Start the next appearance (e.g. a later gateway restart) without a stale row.
      setDestinationRow((previous) => (previous.open ? { ...previous, open: false } : previous));
    }, EXIT_FADE_MS);
    return () => window.clearTimeout(exitTimer);
  }, [visible]);
  const exiting = !visible && present;

  useEffect(() => {
    if (!visible) {
      setShowSlowHint(false);
      return;
    }

    const slowHintTimer = setTimeout(() => {
      setShowSlowHint(true);
    }, SLOW_HINT_AFTER_MS);

    return () => {
      clearTimeout(slowHintTimer);
    };
  }, [visible]);

  // Auto-rotate tips; keyed on tipIndex so a manual dot click resets the timer
  useEffect(() => {
    if (!visible) {
      return;
    }

    const tipTimer = setInterval(() => {
      hasRotatedTipRef.current = true;
      setTipIndex((prev) => {
        const next = (prev + 1) % TIP_KEYS.length;
        persistedTipIndex = next;
        return next;
      });
    }, TIP_ROTATE_MS);

    return () => {
      clearInterval(tipTimer);
    };
  }, [visible, tipIndex]);

  const handleSelectTip = (idx: number) => {
    if (idx === tipIndex) {
      return;
    }
    hasRotatedTipRef.current = true;
    persistedTipIndex = idx;
    setTipIndex(idx);
  };

  if (!visible && !present) {
    return null;
  }

  const progressPercent = typeof status?.progressPercent === 'number'
    ? Math.max(0, Math.min(100, Math.round(status.progressPercent)))
    : null;

  return (
    <div
      aria-hidden={exiting || undefined}
      className={`fixed inset-0 z-[100] flex items-center justify-center bg-surface transition-opacity duration-200 motion-reduce:transition-none ${
        animateIn ? 'animate-fade-in' : ''
      } ${exiting ? 'pointer-events-none opacity-0' : 'opacity-100'}`}
    >
      {/* brand gradient, same as WelcomeDialog */}
      <div
        className="absolute inset-0"
        style={{ background: 'linear-gradient(360deg, rgba(255, 0, 77, 0) 5.5%, rgba(255, 0, 77, 0.05) 100%)' }}
        aria-hidden="true"
      />

      <div className="relative z-10 flex w-[420px] flex-col items-center px-6" role="status">
        {/* logo with breathing glow */}
        <div className="relative mb-5">
          <div className="absolute -inset-2 rounded-3xl bg-primary/20 blur-xl animate-pulse" aria-hidden="true" />
          <img
            src="logo.png"
            alt="LobsterAI"
            width={72}
            height={72}
            className="relative rounded-2xl select-none"
            draggable={false}
          />
        </div>

        <h1 className="text-2xl font-bold text-foreground mb-2 text-center">
          {i18nService.t('engineStartingTitle')}
        </h1>
        <p className="text-sm text-secondary mb-8 text-center">
          {status ? resolveEngineStatusText(status) : i18nService.t('loading')}
        </p>

        {/* progress bar with shimmer */}
        <div className="w-full h-1.5 rounded-full bg-primary/15 overflow-hidden">
          {progressPercent !== null ? (
            <div
              className="relative h-full rounded-full bg-primary overflow-hidden transition-all duration-500 ease-smooth"
              style={{ width: `${Math.max(progressPercent, 4)}%` }}
            >
              <div
                className="absolute inset-0 animate-shimmer bg-gradient-to-r from-transparent via-white/40 to-transparent"
                aria-hidden="true"
              />
            </div>
          ) : (
            <div className="relative h-full overflow-hidden">
              <div
                className="absolute inset-0 animate-shimmer bg-gradient-to-r from-transparent via-primary to-transparent"
                aria-hidden="true"
              />
            </div>
          )}
        </div>
        <div className="mt-1.5 flex w-full items-center justify-between gap-3 min-h-[1rem]">
          <span className={`text-xs text-muted transition-opacity duration-500 ${showSlowHint ? 'opacity-100' : 'opacity-0'}`}>
            {i18nService.t('engineStartingSlowHint')}
          </span>
          {progressPercent !== null && (
            <span className="text-xs tabular-nums text-secondary shrink-0">{progressPercent}%</span>
          )}
        </div>

        {/* where a link clicked during startup lands once the engine is ready */}
        <div
          className={`grid w-full transition-[grid-template-rows,opacity,visibility] duration-300 ease-smooth motion-reduce:transition-none ${
            destinationRow.open ? 'visible grid-rows-[1fr] opacity-100' : 'invisible grid-rows-[0fr] opacity-0'
          }`}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="mt-5 flex items-center gap-2 rounded-xl border border-primary/25 bg-primary/5 px-4 py-2.5">
              <ArrowRightCircleIcon className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                {i18nService.t('engineStartingDestination').replace('{name}', () => destinationRow.label)}
              </span>
              {onCancelDestination && (
                <button
                  type="button"
                  onClick={onCancelDestination}
                  className="shrink-0 rounded text-xs text-secondary transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  {i18nService.t('cancel')}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* rotating feature tips */}
        <div className="mt-10 w-full rounded-xl border border-border-subtle bg-surface-raised/60 px-4 py-3">
          <div key={tipIndex} className={hasRotatedTipRef.current ? 'animate-fade-in-up' : ''}>
            <div className="flex items-center gap-1.5 text-xs font-medium text-primary mb-1">
              <LightBulbIcon className="h-3.5 w-3.5" />
              {i18nService.t('engineStartingTipLabel')}
            </div>
            <p className="text-sm text-secondary leading-relaxed min-h-[2.5rem]">
              {i18nService.t(TIP_KEYS[tipIndex])}
            </p>
          </div>
          <div className="mt-2 flex justify-center gap-1.5">
            {TIP_KEYS.map((key, idx) => (
              <button
                key={key}
                type="button"
                onClick={() => handleSelectTip(idx)}
                aria-label={`${i18nService.t('engineStartingTipLabel')} ${idx + 1}`}
                className={`relative h-1 rounded-full transition-all duration-300 cursor-pointer after:content-[''] after:absolute after:-inset-y-1.5 after:-inset-x-0.5 ${
                  idx === tipIndex ? 'w-3 bg-primary' : 'w-1 bg-primary/25 hover:bg-primary/50'
                }`}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default EngineStartupOverlay;
