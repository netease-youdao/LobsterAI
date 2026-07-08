import { ArrowPathIcon, ChevronDownIcon, ExclamationTriangleIcon, WrenchScrewdriverIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useState } from 'react';

import { OpenClawGatewayRepairErrorCode } from '../../../shared/openclawEngine/constants';
import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import { LogReporterAction, reportYdAnalyzer } from '../../services/logReporter';
import type { OpenClawEngineStatus, OpenClawGatewayRepairResult } from '../../types/cowork';
import type { SettingsOpenOptions } from '../Settings';

interface EngineFailureOverlayProps {
  onRequestAppSettings?: (options?: SettingsOpenOptions) => void;
  suspended?: boolean;
}

const resolveGatewayRepairErrorText = (result: OpenClawGatewayRepairResult): string => {
  if (result.errorCode === OpenClawGatewayRepairErrorCode.Busy) {
    return i18nService.t('openClawRepairBusyError');
  }
  if (result.errorCode === OpenClawGatewayRepairErrorCode.ConfigApplyPending) {
    return i18nService.t('openClawRepairConfigApplyPendingError');
  }
  return result.error?.trim() || i18nService.t('openClawRepairFailed');
};

const EngineFailureOverlay: React.FC<EngineFailureOverlayProps> = ({
  onRequestAppSettings,
  suspended = false,
}) => {
  const [status, setStatus] = useState<OpenClawEngineStatus | null>(
    () => coworkService.getOpenClawEngineStatusSnapshot()
  );
  const [isRestartingGateway, setIsRestartingGateway] = useState(false);
  const [isRepairingGateway, setIsRepairingGateway] = useState(false);
  const [gatewayRepairError, setGatewayRepairError] = useState<string | null>(null);
  const [isDeferred, setIsDeferred] = useState(false);

  useEffect(() => {
    coworkService.getOpenClawEngineStatus()
      .then((nextStatus) => {
        if (nextStatus) setStatus(nextStatus);
      })
      .catch(() => { /* keep last known status */ });

    return coworkService.onOpenClawEngineStatus((nextStatus) => {
      setStatus(nextStatus);
    });
  }, []);

  useEffect(() => {
    if (status?.phase === 'running') {
      setGatewayRepairError(null);
    }
    if (status?.phase !== 'error') {
      setIsDeferred(false);
    }
  }, [status?.phase]);

  const handleRestartGateway = async () => {
    if (isRestartingGateway || isRepairingGateway) return;
    setIsRestartingGateway(true);
    setGatewayRepairError(null);
    try {
      await coworkService.restartOpenClawGateway();
    } catch (error) {
      console.error('[EngineFailureOverlay] Failed to restart gateway:', error);
    } finally {
      setIsRestartingGateway(false);
    }
  };

  // Same repair flow as Settings > Agent Engine > Repair Startup: back up
  // openclaw.json, regenerate config, restart the gateway.
  const handleQuickRepairGateway = async () => {
    if (isRepairingGateway || isRestartingGateway) return;
    setIsRepairingGateway(true);
    setGatewayRepairError(null);
    try {
      const result = await coworkService.repairOpenClawGatewayState();
      void reportYdAnalyzer({
        action: LogReporterAction.AgentEngineMaintenanceAction,
        actionType: 'repair_gateway_state',
        result: result.success ? 'success' : 'failed',
        errorCode: result.success ? undefined : result.errorCode ?? 'unknown',
        source: 'cowork_engine_failure_overlay',
      });
      if (!result.success) {
        setGatewayRepairError(resolveGatewayRepairErrorText(result));
      }
    } catch (error) {
      console.error('[EngineFailureOverlay] Failed to repair gateway state:', error);
      const message = error instanceof Error ? error.message.trim() : '';
      setGatewayRepairError(message || i18nService.t('openClawRepairFailed'));
      void reportYdAnalyzer({
        action: LogReporterAction.AgentEngineMaintenanceAction,
        actionType: 'repair_gateway_state',
        result: 'failed',
        errorCode: 'unknown',
        source: 'cowork_engine_failure_overlay',
      });
    } finally {
      setIsRepairingGateway(false);
    }
  };

  if (suspended || status?.phase !== 'error') {
    return null;
  }

  if (isDeferred) {
    return (
      <div className="pointer-events-none fixed inset-x-0 top-4 z-[90] flex justify-center px-4">
        <div className="pointer-events-auto flex max-w-[calc(100vw-2rem)] items-center gap-1.5 rounded-full border border-red-200 bg-surface py-1 pl-3 pr-1 shadow-lg animate-fade-in-down dark:border-red-900/60">
          <button
            type="button"
            onClick={() => setIsDeferred(false)}
            className="inline-flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground transition-colors hover:text-red-600 dark:hover:text-red-400"
          >
            <ExclamationTriangleIcon className="h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400" />
            <span className="truncate">{i18nService.t('coworkOpenClawErrorShort')}</span>
            <ChevronDownIcon className="h-3 w-3 shrink-0 text-secondary" />
          </button>
          <button
            type="button"
            onClick={handleQuickRepairGateway}
            disabled={isRepairingGateway || isRestartingGateway}
            className="inline-flex h-6 shrink-0 items-center justify-center gap-1 rounded-full bg-primary px-2.5 text-xs font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60 active:scale-[0.98]"
          >
            {isRepairingGateway
              ? <ArrowPathIcon className="h-3 w-3 animate-spin" />
              : <WrenchScrewdriverIcon className="h-3 w-3" />}
            {isRepairingGateway
              ? i18nService.t('openClawRepairRunning')
              : i18nService.t('coworkOpenClawQuickRepair')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm animate-fade-in">
      <div
        className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-xl animate-fade-in-up"
        role="dialog"
        aria-modal="true"
        aria-labelledby="openclaw-gateway-failure-title"
      >
        <div className="flex flex-col items-center text-center">
          <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-400">
            <ExclamationTriangleIcon className="h-6 w-6" />
          </span>
          <h3 id="openclaw-gateway-failure-title" className="mt-3 text-base font-semibold text-foreground">
            {i18nService.t('coworkOpenClawError')}
          </h3>
          <p className="mt-2 text-[13px] leading-5 text-secondary">
            {i18nService.t('coworkOpenClawErrorRepairHint')}
          </p>
          {gatewayRepairError && (
            <p className="mt-2 text-[13px] leading-5 text-red-600 dark:text-red-400">
              {gatewayRepairError}
            </p>
          )}
        </div>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={handleRestartGateway}
            disabled={isRestartingGateway || isRepairingGateway}
            className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl border border-border bg-surface px-3 text-sm font-medium text-foreground transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-60 active:scale-[0.98]"
          >
            {isRestartingGateway && (
              <ArrowPathIcon className="h-4 w-4 animate-spin" />
            )}
            {i18nService.t('coworkOpenClawRestartGateway')}
          </button>
          <button
            type="button"
            onClick={handleQuickRepairGateway}
            disabled={isRepairingGateway || isRestartingGateway}
            className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl bg-primary px-3 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60 active:scale-[0.98]"
          >
            {isRepairingGateway
              ? <ArrowPathIcon className="h-4 w-4 animate-spin" />
              : <WrenchScrewdriverIcon className="h-4 w-4" />}
            {isRepairingGateway
              ? i18nService.t('openClawRepairRunning')
              : i18nService.t('coworkOpenClawQuickRepair')}
          </button>
        </div>
        <div className="mt-4 flex items-center justify-between gap-4">
          {onRequestAppSettings ? (
            <button
              type="button"
              onClick={() => onRequestAppSettings({ initialTab: 'coworkAgentEngine' })}
              className="text-xs text-secondary underline-offset-2 transition-colors hover:text-foreground hover:underline"
            >
              {i18nService.t('coworkOpenClawGoToSettingsInstall')}
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={() => setIsDeferred(true)}
            className="text-xs text-secondary underline-offset-2 transition-colors hover:text-foreground hover:underline"
          >
            {i18nService.t('coworkOpenClawErrorDefer')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default EngineFailureOverlay;
