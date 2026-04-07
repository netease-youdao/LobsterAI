import React, { useState, useEffect, useRef } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import { ChatBubbleLeftRightIcon } from '@heroicons/react/24/outline';
import type { OpenClawEngineStatus } from '../../types/cowork';

/** Delay (ms) before showing cancel/view-logs buttons during startup. */
const SHOW_ACTIONS_DELAY_MS = 30_000;

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

/**
 * Global overlay shown when the OpenClaw gateway is starting up.
 * Renders on top of all views (cowork, skills, scheduled tasks, mcp).
 *
 * After {@link SHOW_ACTIONS_DELAY_MS} in the `starting` phase, "Cancel Startup"
 * and "View Logs" buttons appear so the user has an escape hatch if the
 * gateway is taking unusually long.
 */
const EngineStartupOverlay: React.FC = () => {
  const config = useSelector((state: RootState) => state.cowork.config);
  const isOpenClawEngine = config.agentEngine !== 'yd_cowork';
  const [status, setStatus] = useState<OpenClawEngineStatus | null>(null);
  const [showActions, setShowActions] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isOpenClawEngine) return;

    coworkService.getOpenClawEngineStatus().then((s) => {
      if (s) setStatus(s);
    });

    const unsubscribe = coworkService.onOpenClawEngineStatus((s) => {
      setStatus(s);
    });

    return unsubscribe;
  }, [isOpenClawEngine]);

  // Start / reset the delayed-actions timer whenever the phase changes.
  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setShowActions(false);

    if (status?.phase === 'starting') {
      timerRef.current = setTimeout(() => {
        setShowActions(true);
      }, SHOW_ACTIONS_DELAY_MS);
    }

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [status?.phase]);

  if (!isOpenClawEngine || !status || status.phase !== 'starting') {
    return null;
  }

  const progressPercent = typeof status.progressPercent === 'number'
    ? Math.max(0, Math.min(100, Math.round(status.progressPercent)))
    : null;

  const handleCancelStartup = async () => {
    setIsCancelling(true);
    try {
      await coworkService.cancelOpenClawStartup();
    } finally {
      setIsCancelling(false);
    }
  };

  const handleViewLogs = async () => {
    const logPath = await coworkService.getOpenClawGatewayLogPath();
    if (logPath) {
      window.electron?.shell?.showItemInFolder?.(logPath);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-2xl border border-border bg-surface p-6 shadow-card">
        <div className="flex flex-col items-center text-center gap-3">
          <div className="h-10 w-10 rounded-full bg-primary/15 text-primary flex items-center justify-center animate-pulse">
            <ChatBubbleLeftRightIcon className="h-5 w-5" />
          </div>
          <div className="text-sm text-foreground">
            {resolveEngineStatusText(status)}
          </div>
          {progressPercent !== null && (
            <div className="w-full space-y-1">
              <div className="h-1.5 w-full rounded-full bg-primary/15 overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              <div className="text-xs text-secondary">
                {progressPercent}%
              </div>
            </div>
          )}
          {showActions && (
            <div className="flex items-center gap-3 mt-2">
              <button
                type="button"
                disabled={isCancelling}
                onClick={handleCancelStartup}
                className="px-4 py-1.5 text-sm rounded-lg border border-border text-secondary hover:bg-surface-raised transition-colors disabled:opacity-50"
              >
                {i18nService.t('coworkOpenClawCancelStartup')}
              </button>
              <button
                type="button"
                onClick={handleViewLogs}
                className="px-4 py-1.5 text-sm rounded-lg border border-border text-secondary hover:bg-surface-raised transition-colors"
              >
                {i18nService.t('coworkOpenClawViewLogs')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default EngineStartupOverlay;
