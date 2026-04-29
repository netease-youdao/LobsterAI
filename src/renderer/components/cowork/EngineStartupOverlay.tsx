import { ChatBubbleLeftRightIcon } from '@heroicons/react/24/outline';
import React, { useEffect,useState } from 'react';

import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import type { OpenClawEngineStatus } from '../../types/cowork';

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
 */
const EngineStartupOverlay: React.FC = () => {
  const [status, setStatus] = useState<OpenClawEngineStatus | null>(null);

  useEffect(() => {
    coworkService.getOpenClawEngineStatus().then((s) => {
      if (s) setStatus(s);
    });

    const unsubscribe = coworkService.onOpenClawEngineStatus((s) => {
      setStatus(s);
    });

    return unsubscribe;
  }, []);

  if (!status || status.phase !== 'starting') {
    return null;
  }

  const progressPercent = typeof status.progressPercent === 'number'
    ? Math.max(0, Math.min(100, Math.round(status.progressPercent)))
    : null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/90 backdrop-blur-sm">
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
        </div>
      </div>
    </div>
  );
};

export default EngineStartupOverlay;
