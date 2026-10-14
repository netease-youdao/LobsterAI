import { ArrowPathIcon, ChevronDownIcon, ExclamationTriangleIcon, ShieldCheckIcon, WrenchScrewdriverIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useState } from 'react';

import { OpenClawEngineErrorCode, OpenClawEnginePhase, OpenClawLoopbackRepairOutcome } from '../../../shared/openclawEngine/constants';
import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import { LogReporterAction, reportYdAnalyzer } from '../../services/logReporter';
import { resolveOpenClawLoopbackRepairMessage, resolveOpenClawRepairError } from '../../services/openclawRepair';
import type { OpenClawEngineStatus } from '../../types/cowork';
import type { SettingsOpenOptions } from '../Settings';

interface EngineFailureOverlayProps {
  onRequestAppSettings?: (options?: SettingsOpenOptions) => void;
  suspended?: boolean;
}

const EngineFailureOverlay: React.FC<EngineFailureOverlayProps> = ({
  onRequestAppSettings,
  suspended = false,
}) => {
  const [status, setStatus] = useState<OpenClawEngineStatus | null>(
    () => coworkService.getOpenClawEngineStatusSnapshot()
  );
  const [isRestartingGateway, setIsRestartingGateway] = useState(false);
  const [isRepairingGateway, setIsRepairingGateway] = useState(false);
  const [isAllowingLoopback, setIsAllowingLoopback] = useState(false);
  const [gatewayRepairError, setGatewayRepairError] = useState<string | null>(null);
  const [isDeferred, setIsDeferred] = useState(false);
  const [isStallExpanded, setIsStallExpanded] = useState(false);

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
    if (status?.phase === OpenClawEnginePhase.Running) {
      setGatewayRepairError(null);
    }
    if (status?.phase !== OpenClawEnginePhase.Error) {
      setIsDeferred(false);
    }
  }, [status?.phase]);

  // The gateway still runs and tasks proceed, so a stalled config is a notice, not a failure.
  const isConfigStalled = Boolean(status?.configApplyStalled) && status?.phase !== OpenClawEnginePhase.Error;
  useEffect(() => {
    if (!isConfigStalled) setIsStallExpanded(false);
  }, [isConfigStalled]);

  const isActionRunning = isRestartingGateway || isRepairingGateway || isAllowingLoopback;

  const handleRestartGateway = async () => {
    if (isActionRunning) return;
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

  // Same backed-up Doctor and compatibility repair flow as Settings.
  const handleQuickRepairGateway = async () => {
    if (isActionRunning) return;
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
        setGatewayRepairError(resolveOpenClawRepairError(result));
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

  // Adds the loopback firewall rule behind a UAC prompt; once the self-test
  // passes, the main process restarts the gateway.
  const handleAllowLoopback = async () => {
    if (isActionRunning) return;
    setIsAllowingLoopback(true);
    setGatewayRepairError(null);
    try {
      const result = await coworkService.repairOpenClawLoopbackFirewall();
      const repaired = result.outcome === OpenClawLoopbackRepairOutcome.Repaired;
      void reportYdAnalyzer({
        action: LogReporterAction.AgentEngineMaintenanceAction,
        actionType: 'allow_loopback_firewall',
        result: repaired ? 'success' : 'failed',
        errorCode: repaired ? undefined : result.outcome,
        source: 'cowork_engine_failure_overlay',
      });
      setGatewayRepairError(resolveOpenClawLoopbackRepairMessage(result) ?? null);
    } catch (error) {
      console.error('[EngineFailureOverlay] Failed to allow loopback connections:', error);
      setGatewayRepairError(i18nService.t('coworkOpenClawAllowLoopbackFailed'));
    } finally {
      setIsAllowingLoopback(false);
    }
  };

  if (suspended || !status || (status.phase !== OpenClawEnginePhase.Error && !isRepairingGateway && !isConfigStalled)) {
    return null;
  }

  // Incomplete installation (runtime files missing): rebuilding the OpenClaw
  // config cannot help. Quick repair still retries recovery from leftover
  // installer resources, but the honest fix is allowlist + reinstall.
  const isRuntimeMissing = status.errorCode === OpenClawEngineErrorCode.RuntimeEntryMissing;
  const isRuntimeDamaged = status.errorCode === OpenClawEngineErrorCode.RuntimeFilesMissing;
  const needsMediaMigration = status.errorCode === OpenClawEngineErrorCode.AgentMediaMigrationRequired;
  const migrationRefused = status.errorCode === OpenClawEngineErrorCode.StartupMigrationRefused;
  // Config repair cannot help a firewall block; the primary action adds the
  // loopback rule instead, and restarting re-runs the self-test.
  const isLoopbackBlocked = status.errorCode === OpenClawEngineErrorCode.LoopbackBlocked;
  const titleKey = isRepairingGateway ? 'openClawRepairRunning' : isLoopbackBlocked ? 'coworkOpenClawLoopbackBlockedTitle'
    : isRuntimeDamaged ? 'coworkOpenClawRuntimeDamagedError'
      : isRuntimeMissing ? 'coworkOpenClawRuntimeMissingError' : needsMediaMigration ? 'openClawAgentMediaMigrationTitle'
        : isConfigStalled ? 'coworkOpenClawConfigStalledTitle' : 'coworkOpenClawError';
  const hintKey = isLoopbackBlocked ? 'coworkOpenClawLoopbackBlockedHint' : isRuntimeDamaged ? 'coworkOpenClawRuntimeDamagedRepairHint'
    : isRuntimeMissing ? 'coworkOpenClawRuntimeMissingRepairHint' : needsMediaMigration ? 'openClawAgentMediaMigrationHint'
      : migrationRefused ? 'openClawStartupMigrationRefusedHint'
        : isConfigStalled ? 'coworkOpenClawConfigStalledHint' : 'coworkOpenClawErrorRepairHint';
  const primaryAction = isLoopbackBlocked
    ? {
      onClick: handleAllowLoopback,
      running: isAllowingLoopback,
      Icon: ShieldCheckIcon,
      labelKey: isAllowingLoopback ? 'coworkOpenClawAllowLoopbackRunning' : 'coworkOpenClawAllowLoopback',
    }
    : {
      onClick: handleQuickRepairGateway,
      running: isRepairingGateway,
      Icon: WrenchScrewdriverIcon,
      labelKey: isRepairingGateway ? 'openClawRepairRunning' : 'coworkOpenClawQuickRepair',
    };

  // A stall starts collapsed because it blocks nothing; a failed repair opens it to show why.
  const isCollapsed = isConfigStalled ? !isStallExpanded && !gatewayRepairError : isDeferred;
  const shortLabelKey = isConfigStalled ? 'coworkOpenClawConfigStalledShort'
    : isLoopbackBlocked ? 'coworkOpenClawLoopbackBlockedShort' : 'coworkOpenClawErrorShort';
  const detail = gatewayRepairError || (isConfigStalled ? status.configApplyStalled?.detail : status.message);

  if (isCollapsed) {
    return (
      <div className="pointer-events-none fixed inset-x-0 top-4 z-[90] flex justify-center px-4">
        <div className="non-draggable pointer-events-auto flex max-w-[calc(100vw-2rem)] items-center gap-1.5 rounded-full border border-red-200 bg-surface py-1 pl-3 pr-1 shadow-lg animate-fade-in-down dark:border-red-900/60">
          <button
            type="button"
            onClick={() => (isConfigStalled ? setIsStallExpanded(true) : setIsDeferred(false))}
            className="inline-flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground transition-colors hover:text-red-600 dark:hover:text-red-400"
          >
            <ExclamationTriangleIcon className="h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400" />
            <span className="truncate">
              {i18nService.t(shortLabelKey)}
            </span>
            <ChevronDownIcon className="h-3 w-3 shrink-0 text-secondary" />
          </button>
          {!isRuntimeDamaged && <button
            type="button"
            onClick={primaryAction.onClick}
            disabled={isActionRunning}
            className="inline-flex h-6 shrink-0 items-center justify-center gap-1 rounded-full bg-primary px-2.5 text-xs font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60 active:scale-[0.98]"
          >
            {primaryAction.running
              ? <ArrowPathIcon className="h-3 w-3 animate-spin" />
              : <primaryAction.Icon className="h-3 w-3" />}
            {i18nService.t(primaryAction.labelKey)}
          </button>}
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
            {i18nService.t(titleKey)}
          </h3>
          <p className="mt-2 text-[13px] leading-5 text-secondary">
            {i18nService.t(hintKey)}
          </p>
          {!isRepairingGateway && detail && (
            <p className="mt-2 max-h-36 max-w-full overflow-y-auto whitespace-pre-wrap break-words text-left text-xs leading-5 text-red-600 dark:text-red-400 [overflow-wrap:anywhere]">
              {detail}
            </p>
          )}
        </div>
        {!isRuntimeDamaged && <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={handleRestartGateway}
            disabled={isActionRunning}
            className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl border border-border bg-surface px-3 text-sm font-medium text-foreground transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-60 active:scale-[0.98]"
          >
            {isRestartingGateway && (
              <ArrowPathIcon className="h-4 w-4 animate-spin" />
            )}
            {i18nService.t(isLoopbackBlocked ? 'coworkOpenClawLoopbackRecheck' : 'coworkOpenClawRestartGateway')}
          </button>
          <button
            type="button"
            onClick={primaryAction.onClick}
            disabled={isActionRunning}
            className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl bg-primary px-3 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60 active:scale-[0.98]"
          >
            {primaryAction.running
              ? <ArrowPathIcon className="h-4 w-4 animate-spin" />
              : <primaryAction.Icon className="h-4 w-4" />}
            {i18nService.t(primaryAction.labelKey)}
          </button>
        </div>}
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
            onClick={() => {
              if (isConfigStalled) {
                setIsStallExpanded(false);
                setGatewayRepairError(null);
              } else {
                setIsDeferred(true);
              }
            }}
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
