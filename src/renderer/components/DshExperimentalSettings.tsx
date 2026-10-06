import React, { useCallback, useEffect, useRef, useState } from 'react';

import { DshEngineErrorCode, DshEnginePhase, DshInstallStage } from '../../shared/dshEngine/constants';
import {
  DshAnalyticsResult,
  reportDshEnabledChanged,
  reportDshOpenWorkbench,
  resolveDshOpenWorkbenchErrorCode,
} from '../services/dshAnalytics';
import { i18nService } from '../services/i18n';

interface DshInstallView {
  stage: string;
  receivedBytes: number;
  totalBytes: number;
}

interface DshEngineStateView {
  phase: string;
  version: string | null;
  errorCode: string | null;
  sessionStoreShared?: boolean;
  install?: DshInstallView | null;
}

const PHASE_LABEL_KEY: Record<string, string> = {
  [DshEnginePhase.Ready]: 'dshStatusReady',
  [DshEnginePhase.Starting]: 'dshStatusStarting',
  [DshEnginePhase.Stopped]: 'dshStatusStopped',
  [DshEnginePhase.Installing]: 'dshStatusInstalling',
  [DshEnginePhase.Failed]: 'dshStatusFailed',
  [DshEnginePhase.NotInstalled]: 'dshStatusNotInstalled',
};

const ERROR_LABEL_KEY: Record<string, string> = {
  [DshEngineErrorCode.PluginLoadFailed]: 'dshErrorPluginLoadFailed',
};

function localizeOpenError(message: string): string {
  const knownError = Object.entries(ERROR_LABEL_KEY).find(([errorCode]) => message.includes(`error=${errorCode}`));
  const detail = knownError?.[1] ? i18nService.t(knownError[1]) : message;
  return i18nService.t('dshOpenFailed').replace('{error}', detail);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function installPercent(install: DshInstallView): number {
  if (install.totalBytes <= 0) return 0;
  return Math.min(100, Math.floor((install.receivedBytes / install.totalBytes) * 100));
}

function installLabel(install: DshInstallView): string {
  switch (install.stage) {
    case DshInstallStage.Download:
      return i18nService
        .t('dshInstallDownloading')
        .replace('{percent}', String(installPercent(install)))
        .replace('{received}', formatBytes(install.receivedBytes))
        .replace('{total}', formatBytes(install.totalBytes));
    case DshInstallStage.Verify:
      return i18nService.t('dshInstallVerifying');
    case DshInstallStage.Extract:
      return i18nService.t('dshInstallExtracting');
    default:
      return i18nService.t('dshInstallPreparing');
  }
}

// Best-effort reads for analytics context; the bridge may be missing on an
// older main process, in which case the caller's fallback is used.
async function readEngineState(): Promise<DshEngineStateView | null> {
  try {
    return await window.electron.dsh.getState();
  } catch {
    return null;
  }
}

async function readEnginePhase(fallback: string): Promise<string> {
  return (await readEngineState())?.phase ?? fallback;
}

export const DshExperimentalSettings: React.FC = () => {
  const [enabled, setEnabled] = useState(false);
  const [engineState, setEngineState] = useState<DshEngineStateView>({ phase: DshEnginePhase.Stopped, version: null, errorCode: null });
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const [config, state] = await Promise.all([window.electron.dsh.getConfig(), window.electron.dsh.getState()]);
      if (!mountedRef.current) return;
      setEnabled(config.enabled);
      setEngineState(state);
    } catch {
      // Bridge unavailable (old main process) — leave defaults.
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The first open downloads and unpacks the runtime, which takes tens of
  // seconds and is only visible through this poll, so it ticks faster while
  // something is in flight and drops back to idle pace once it settles.
  const busy =
    opening || engineState.phase === DshEnginePhase.Installing || engineState.phase === DshEnginePhase.Starting;

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), busy ? 1000 : 3000);
    return () => window.clearInterval(timer);
  }, [refresh, busy]);

  const handleToggle = useCallback(async () => {
    const previous = enabled;
    const next = !previous;
    setEnabled(next);
    setOpenError(null);
    try {
      await window.electron.dsh.setEnabled(next);
      reportDshEnabledChanged(previous, next);
    } finally {
      void refresh();
    }
  }, [enabled, refresh]);

  const handleOpenWorkbench = useCallback(async () => {
    setOpening(true);
    setOpenError(null);
    // Read the phase fresh rather than from the polled copy: a first open
    // right after enabling is the case where the two most often differ.
    const phaseBefore = await readEnginePhase(engineState.phase);
    try {
      await window.electron.dsh.openWorkbench();
      reportDshOpenWorkbench({ phaseBefore, result: DshAnalyticsResult.Success });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setOpenError(localizeOpenError(message));
      const stateAfter = await readEngineState();
      reportDshOpenWorkbench({
        phaseBefore,
        result: DshAnalyticsResult.Failed,
        errorCode: resolveDshOpenWorkbenchErrorCode(stateAfter, error),
        error,
      });
    } finally {
      if (mountedRef.current) setOpening(false);
      void refresh();
    }
  }, [engineState.phase, refresh]);

  const install = engineState.install ?? null;
  const phaseLabel = i18nService.t(PHASE_LABEL_KEY[engineState.phase] ?? 'dshStatusStopped');
  const errorLabelKey = engineState.errorCode ? ERROR_LABEL_KEY[engineState.errorCode] : undefined;
  const engineError = errorLabelKey ? i18nService.t(errorLabelKey) : null;
  const phaseDotClass =
    engineState.phase === DshEnginePhase.Ready
      ? 'bg-emerald-500'
      : engineState.phase === DshEnginePhase.Starting || engineState.phase === DshEnginePhase.Installing
        ? 'bg-amber-400'
        : engineState.phase === DshEnginePhase.Failed
          ? 'bg-red-500'
          : 'bg-muted-foreground/40';

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h4 className="text-sm font-semibold text-foreground">{i18nService.t('dshSettingsTitle')}</h4>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">{i18nService.t('dshSettingsDesc')}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={i18nService.t('dshEnableLabel')}
            onClick={() => void handleToggle()}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
              enabled ? 'bg-primary' : 'bg-muted'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                enabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>

        {enabled && (
          <p className="mt-4 border-t border-border pt-4 text-[11px] leading-4 text-muted-foreground">
            {i18nService.t('dshSharedDataNote')}
          </p>
        )}

        {enabled && engineState.sessionStoreShared === false && (
          <p className="mt-2 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-[11px] leading-4 text-amber-700 dark:text-amber-400">
            {i18nService.t('dshSessionStoreIsolatedNote')}
          </p>
        )}

        {enabled && install && (
          <div className="mt-4 border-t border-border pt-4">
            <div className="h-1.5 overflow-hidden rounded-full bg-primary/20">
              {install.stage === DshInstallStage.Download ? (
                <div
                  className="h-full rounded-full bg-primary transition-all duration-300"
                  style={{ width: `${installPercent(install)}%` }}
                />
              ) : (
                <div className="h-full w-full animate-pulse rounded-full bg-primary/60" />
              )}
            </div>
            <p className="mt-2 text-[11px] leading-4 text-muted-foreground">{installLabel(install)}</p>
            <p className="mt-1 text-[11px] leading-4 text-muted-foreground/70">
              {i18nService.t('dshInstallFirstRunNote')}
            </p>
          </div>
        )}

        {enabled && (
          <div className="mt-4 flex items-center justify-between gap-4 border-t border-border pt-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className={`h-2 w-2 rounded-full ${phaseDotClass}`} />
              <span>{phaseLabel}</span>
              {engineState.version && <span className="text-muted-foreground/60">dsh {engineState.version}</span>}
            </div>
            <button
              type="button"
              onClick={() => void handleOpenWorkbench()}
              disabled={opening}
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {opening ? i18nService.t('dshOpening') : i18nService.t('dshOpenWorkbench')}
            </button>
          </div>
        )}

        {openError && <p className="mt-3 text-xs text-red-500">{openError}</p>}
        {!openError && engineError && <p className="mt-3 text-xs text-red-500">{engineError}</p>}
      </div>
    </div>
  );
};

export default DshExperimentalSettings;
