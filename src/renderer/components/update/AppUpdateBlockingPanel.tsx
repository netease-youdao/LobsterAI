import { SparklesIcon } from '@heroicons/react/24/outline';
import React, { useEffect } from 'react';

import { type AppUpdateRuntimeState, AppUpdateStatus } from '../../../shared/appUpdate/constants';
import { i18nService } from '../../services/i18n';

interface AppUpdateBlockingPanelProps {
  updateState: AppUpdateRuntimeState;
}

const logBlockingPanelStatus = (status: string, version: string): void => {
  const message = `blocking panel rendered status=${status} version=${version}`;
  console.debug(`[AppUpdatePanel] ${message}`);
  try {
    window.electron?.log?.fromRenderer?.('debug', 'AppUpdatePanel', message);
  } catch {
    // Best-effort diagnostic only.
  }
};

/**
 * Full-screen panel shown from the moment the user confirms an install until
 * the app quits for the installer. Styled after EngineStartupOverlay so the
 * update screen and the relaunch splash that follows it read as one flow.
 */
const AppUpdateBlockingPanel: React.FC<AppUpdateBlockingPanelProps> = ({ updateState }) => {
  const updateInfo = updateState.info;
  const isInstalling = updateState.status === AppUpdateStatus.Installing;
  const title = isInstalling
    ? i18nService.t('updateInstallingTitle')
    : i18nService.t('updateReadyCardTitle');
  const hint = i18nService.t('updateInstallingHint');
  const currentLog = updateInfo?.changeLog?.[i18nService.getLanguage()];
  const releaseNotes = (currentLog?.content ?? []).filter(
    (item): item is string => typeof item === 'string' && item.trim().length > 0,
  );
  const notesLabel = currentLog?.title?.trim() || i18nService.t('updateReleaseNotesLabel');
  const version = updateInfo?.latestVersion ?? 'unknown';
  const versionText = updateInfo
    ? `v${updateInfo.latestVersion}${updateInfo.date ? ` · ${updateInfo.date}` : ''}`
    : null;

  useEffect(() => {
    logBlockingPanelStatus(updateState.status, version);
  }, [updateState.status, version]);

  return (
    <section
      className="mx-auto flex max-h-full w-full max-w-[420px] animate-fade-in-up flex-col items-center"
      aria-label={updateInfo ? `${title} v${updateInfo.latestVersion}` : title}
      aria-busy="true"
      aria-modal="true"
      role="dialog"
    >
      {/* logo with breathing glow, same as EngineStartupOverlay */}
      <div className="relative mb-5 shrink-0">
        <div className="absolute -inset-2 animate-pulse rounded-3xl bg-primary/20 blur-xl" aria-hidden="true" />
        <img
          src="logo.png"
          alt="LobsterAI"
          width={72}
          height={72}
          className="relative select-none rounded-2xl"
          draggable={false}
        />
      </div>

      <h2 className="shrink-0 text-center text-2xl font-bold text-foreground">{title}</h2>
      <p className="mt-2 shrink-0 text-balance text-center text-sm leading-relaxed text-secondary">{hint}</p>

      {/* indeterminate shimmer: the installer takes over from here */}
      <div className="mt-8 h-1.5 w-full shrink-0 overflow-hidden rounded-full bg-primary/15">
        <div className="relative h-full overflow-hidden">
          <div
            className="absolute inset-0 animate-shimmer bg-gradient-to-r from-transparent via-primary to-transparent"
            aria-hidden="true"
          />
        </div>
      </div>

      {/* release notes, styled like the startup tips card */}
      {updateInfo && (
        <div className="mt-8 flex min-h-0 w-full flex-col rounded-xl border border-border-subtle bg-surface-raised/60 px-4 py-3">
          <div className="flex shrink-0 items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-primary">
              <SparklesIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{notesLabel}</span>
            </span>
            {versionText && (
              <span className="shrink-0 text-xs tabular-nums text-muted">{versionText}</span>
            )}
          </div>
          {releaseNotes.length > 0 && (
            <ul className="mt-2 min-h-0 space-y-1.5 overflow-y-auto pr-1">
              {releaseNotes.map((item, index) => (
                <li key={index} className="flex items-start gap-2 text-sm leading-relaxed text-secondary">
                  <span
                    className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-primary/60"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 break-words">{item}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
};

export default AppUpdateBlockingPanel;
