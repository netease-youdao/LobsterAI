import React, { useCallback, useEffect, useRef, useState } from 'react';

import { DshEngineErrorCode, DshEnginePhase, DshInstallStage } from '../../shared/dshEngine/constants';
import {
  DshAnalyticsResult,
  reportDshEnabledChanged,
  reportDshOpenWorkbench,
  resolveDshOpenWorkbenchErrorCode,
} from '../services/dshAnalytics';
import { i18nService } from '../services/i18n';
import DeepSeekIcon from './icons/providers/DeepSeekIcon';
import {
  SETTINGS_ACTION_BUTTON_CLASS,
  SettingsCard,
  SettingsItem,
  SettingsSection,
  SettingsStatusBadge,
  SettingsStatusTone,
} from './settings/SettingsLayout';
import { SETTINGS_DESCRIPTION_TEXT, SETTINGS_ITEM_TITLE_TEXT, SETTINGS_META_TEXT } from './settings/settingsTypography';

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

const PHASE_BADGE: Record<string, { labelKey: string; tone: SettingsStatusTone }> = {
  [DshEnginePhase.Ready]: { labelKey: 'dshStatusReady', tone: SettingsStatusTone.Success },
  [DshEnginePhase.Starting]: { labelKey: 'dshStatusStarting', tone: SettingsStatusTone.Progress },
  [DshEnginePhase.Stopped]: { labelKey: 'dshStatusStopped', tone: SettingsStatusTone.Neutral },
  [DshEnginePhase.Installing]: { labelKey: 'dshStatusInstalling', tone: SettingsStatusTone.Progress },
  [DshEnginePhase.Failed]: { labelKey: 'dshStatusFailed', tone: SettingsStatusTone.Danger },
  [DshEnginePhase.NotInstalled]: { labelKey: 'dshStatusNotInstalledShort', tone: SettingsStatusTone.Neutral },
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
  const phaseBadge = PHASE_BADGE[engineState.phase] ?? PHASE_BADGE[DshEnginePhase.Stopped];
  const errorLabelKey = engineState.errorCode ? ERROR_LABEL_KEY[engineState.errorCode] : undefined;
  const engineError = errorLabelKey ? i18nService.t(errorLabelKey) : null;
  const visibleError = openError ?? engineError;
  // The badge carries the phase, so the row only adds what the badge can't.
  const workbenchDescription = engineState.phase === DshEnginePhase.NotInstalled
    ? i18nService.t('dshStatusNotInstalled')
    : engineState.version ? `dsh ${engineState.version}` : undefined;

  return (
    <SettingsSection
      icon={<DeepSeekIcon />}
      title={i18nService.t('dshSettingsTitle')}
      description={i18nService.t('dshSettingsDesc')}
      action={enabled ? (
        <SettingsStatusBadge tone={phaseBadge.tone} label={i18nService.t(phaseBadge.labelKey)} />
      ) : null}
    >
      <SettingsCard>
        <SettingsItem
          title={i18nService.t('dshEnableLabel')}
          control={(
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
          )}
        />

        {enabled && (
          <div className="px-4 py-3">
            <div className="flex items-center justify-between gap-6">
              <div className="min-w-0 flex-1">
                <div className={`${SETTINGS_ITEM_TITLE_TEXT} font-medium text-foreground`}>
                  {i18nService.t('dshWorkbenchLabel')}
                </div>
                {workbenchDescription && (
                  <div className={`mt-0.5 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>{workbenchDescription}</div>
                )}
              </div>
              <button
                type="button"
                onClick={() => void handleOpenWorkbench()}
                disabled={opening}
                className={SETTINGS_ACTION_BUTTON_CLASS}
              >
                {opening ? i18nService.t('dshOpening') : i18nService.t('dshOpenWorkbench')}
              </button>
            </div>

            {install && (
              <div className="mt-3">
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
                <p className={`mt-2 ${SETTINGS_META_TEXT} text-secondary`}>{installLabel(install)}</p>
                <p className={`mt-1 ${SETTINGS_META_TEXT} text-secondary/70`}>
                  {i18nService.t('dshInstallFirstRunNote')}
                </p>
              </div>
            )}

            {visibleError && <p className={`mt-2 ${SETTINGS_META_TEXT} text-red-500`}>{visibleError}</p>}
          </div>
        )}

        {enabled && engineState.sessionStoreShared === false && (
          <div className={`px-4 py-3 ${SETTINGS_META_TEXT} text-amber-700 dark:text-amber-400`}>
            {i18nService.t('dshSessionStoreIsolatedNote')}
          </div>
        )}
      </SettingsCard>

      {enabled && (
        <p className={`px-1 ${SETTINGS_META_TEXT} text-secondary`}>{i18nService.t('dshSharedDataNote')}</p>
      )}
    </SettingsSection>
  );
};

export default DshExperimentalSettings;
