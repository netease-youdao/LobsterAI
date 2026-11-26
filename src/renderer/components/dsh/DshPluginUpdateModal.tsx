import {
  ArrowPathIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import React, { useEffect, useRef, useState } from 'react';

import {
  DshPluginUpdateOutcomeKind,
  DshPluginUpdateStep,
} from '../../../shared/dshEngine/hostConstants';
import {
  dshHostService,
  type DshPluginUpdateOutcome,
} from '../../services/dshHost';
import { i18nService } from '../../services/i18n';
import Modal from '../common/Modal';
import {
  SETTINGS_DESCRIPTION_TEXT,
  SETTINGS_META_TEXT,
} from '../settings/settingsTypography';
import {
  mergeSettledUpdateSteps,
  PluginUpdateStepVisualState,
  resolveUpdateFailureDetail,
  resolveUpdateRestartReasonText,
  resolveUpdateStepVisualState,
} from './pluginUpdateViewModel';
import { formatPluginVersion, formatRegistryDisplayName } from './pluginViewModel';

export interface DshPluginUpdateTarget {
  name: string;
  title: string;
  fromVersion: string;
  toVersion: string;
  registry?: string | null;
}

const UpdateModalPhase = {
  Confirm: 'confirm',
  Running: 'running',
  Done: 'done',
} as const;
type UpdateModalPhase = typeof UpdateModalPhase[keyof typeof UpdateModalPhase];

interface DshPluginUpdateModalProps {
  target: DshPluginUpdateTarget | null;
  onClose: () => void;
  onSettled: (outcome: DshPluginUpdateOutcome) => void;
  onRestartHost?: () => Promise<void> | void;
}

export const DshPluginUpdateModal: React.FC<DshPluginUpdateModalProps> = ({
  target,
  onClose,
  onSettled,
  onRestartHost,
}) => {
  const t = (key: string) => i18nService.t(key);
  const [phase, setPhase] = useState<UpdateModalPhase>(UpdateModalPhase.Confirm);
  const [steps, setSteps] = useState<DshPluginUpdateStep[]>([]);
  const [outcome, setOutcome] = useState<DshPluginUpdateOutcome | null>(null);
  const [showLogDetails, setShowLogDetails] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const activeRequestIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!target) {
      activeRequestIdRef.current = null;
      return;
    }
    setPhase(UpdateModalPhase.Confirm);
    setSteps([]);
    setOutcome(null);
    setShowLogDetails(false);
    setRestarting(false);
    activeRequestIdRef.current = null;
  }, [target]);

  useEffect(() => {
    if (!target || phase !== UpdateModalPhase.Running) return undefined;
    return dshHostService.onPluginUpdateState((progress) => {
      if (!activeRequestIdRef.current || progress.requestId !== activeRequestIdRef.current) return;
      setSteps((prev) => (prev.includes(progress.step) ? prev : [...prev, progress.step]));
    });
  }, [target, phase]);

  if (!target) return null;

  const isRunning = phase === UpdateModalPhase.Running;
  const fromLabel = formatPluginVersion(target.fromVersion) ?? target.fromVersion;
  const toLabel = formatPluginVersion(target.toVersion) ?? target.toVersion;
  const registryLabel = formatRegistryDisplayName(target.registry, t);

  const handleGuardedClose = () => {
    if (isRunning || restarting) return;
    onClose();
  };

  const handleRunUpdate = async () => {
    if (isRunning) return;
    const requestId = `update-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    activeRequestIdRef.current = requestId;
    setSteps([DshPluginUpdateStep.Checking]);
    setOutcome(null);
    setShowLogDetails(false);
    setPhase(UpdateModalPhase.Running);

    let settledOutcome: DshPluginUpdateOutcome;
    try {
      settledOutcome = await dshHostService.updatePlugin({
        name: target.name,
        version: target.toVersion,
        requestId,
        ...(target.registry !== undefined ? { registry: target.registry } : {}),
      });
    } catch (error) {
      settledOutcome = {
        ok: false,
        outcome: DshPluginUpdateOutcomeKind.TransportLost,
        from: target.fromVersion,
        to: target.toVersion,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (!mountedRef.current) return;
    activeRequestIdRef.current = null;
    setOutcome(settledOutcome);
    setPhase(UpdateModalPhase.Done);
    onSettled(settledOutcome);
  };

  const handleRestartNow = async () => {
    if (!onRestartHost || restarting) return;
    setRestarting(true);
    try {
      await onRestartHost();
      if (mountedRef.current) {
        onClose();
      }
    } finally {
      if (mountedRef.current) {
        setRestarting(false);
      }
    }
  };

  const resolveStepLabel = (step: DshPluginUpdateStep): string => {
    switch (step) {
      case DshPluginUpdateStep.Checking:
        return t('dshPluginsUpdateStepChecking').replace('{version}', toLabel);
      case DshPluginUpdateStep.Removing:
        return t('dshPluginsUpdateStepRemoving').replace('{version}', fromLabel);
      case DshPluginUpdateStep.Installing:
        return t('dshPluginsUpdateStepInstalling')
          .replace('{version}', toLabel)
          .replace('{source}', registryLabel);
      case DshPluginUpdateStep.Restoring:
        return t('dshPluginsUpdateStepRestoring').replace('{version}', fromLabel);
    }
  };

  const resolveOutcomeSummary = (
    res: DshPluginUpdateOutcome,
  ): { tone: 'success' | 'warn' | 'error'; title: string; detail: string } => {
    switch (res.outcome) {
      case DshPluginUpdateOutcomeKind.Applied:
        return {
          tone: 'success',
          title: t('dshPluginsUpdateDoneTitle').replace('{version}', toLabel),
          detail: t('dshPluginsUpdateDoneDesc'),
        };
      case DshPluginUpdateOutcomeKind.RestartRequired:
        return {
          tone: 'warn',
          title: t('dshPluginsUpdateRestartTitle').replace('{version}', toLabel),
          detail: resolveUpdateRestartReasonText(res.restartReason, t),
        };
      case DshPluginUpdateOutcomeKind.CheckRefused:
        return {
          tone: 'error',
          title: t('dshPluginsUpdateRefusedTitle').replace('{version}', toLabel),
          detail: resolveUpdateFailureDetail(res, t),
        };
      case DshPluginUpdateOutcomeKind.RemoveFailed:
        return {
          tone: 'error',
          title: t('dshPluginsUpdateRemoveFailedTitle').replace('{version}', fromLabel),
          detail: resolveUpdateFailureDetail(res, t),
        };
      case DshPluginUpdateOutcomeKind.InstallFailedKept:
        return {
          tone: 'error',
          title: t('dshPluginsUpdateKeptTitle').replace('{version}', toLabel),
          detail: t('dshPluginsUpdateKeptDesc')
            .replace('{from}', fromLabel)
            .replace('{reason}', resolveUpdateFailureDetail(res, t)),
        };
      case DshPluginUpdateOutcomeKind.InstallFailedRestored: {
        const typedReason =
          res.errorCode && res.errorCode !== 'operation-error'
            ? resolveUpdateFailureDetail(res, t)
            : res.pendingBuilds && res.pendingBuilds.length > 0
              ? resolveUpdateFailureDetail(res, t)
              : '';
        const baseDetail = t('dshPluginsUpdateRestoredDesc')
          .replace('{from}', fromLabel)
          .replace('{to}', toLabel);
        return {
          tone: 'error',
          title: t('dshPluginsUpdateRestoredTitle').replace('{version}', fromLabel),
          detail: typedReason ? `${baseDetail} ${typedReason}` : baseDetail,
        };
      }
      case DshPluginUpdateOutcomeKind.InstallFailedBroken:
        return {
          tone: 'error',
          title: t('dshPluginsUpdateBrokenTitle'),
          detail: t('dshPluginsUpdateBrokenDesc')
            .replace('{name}', target.title)
            .replace('{from}', fromLabel)
            .replace('{to}', toLabel),
        };
      case DshPluginUpdateOutcomeKind.TransportLost:
        return {
          tone: 'error',
          title: t('dshPluginsUpdateLostTitle'),
          detail: t('dshPluginsUpdateLostDesc').replace(
            '{reason}',
            res.error || t('dshPluginsUpdateGenericFailed'),
          ),
        };
    }
  };

  const renderedSteps = isRunning ? steps : mergeSettledUpdateSteps(steps, outcome);
  const outcomeSummary = phase === UpdateModalPhase.Done && outcome ? resolveOutcomeSummary(outcome) : null;
  const logText = outcome?.output?.trim() || '';

  return (
    <Modal
      isOpen={target !== null}
      onClose={handleGuardedClose}
      onEscape={handleGuardedClose}
      overlayClassName="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      className="w-full max-w-lg rounded-2xl border border-border bg-surface shadow-modal"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <h3 className="truncate text-base font-semibold text-foreground">
          {t('dshPluginsUpdateModalTitle').replace('{name}', target.title)}
        </h3>
        <button
          type="button"
          onClick={handleGuardedClose}
          disabled={isRunning || restarting}
          aria-label={t('close')}
          className="rounded-lg p-1 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <XMarkIcon className="h-5 w-5" />
        </button>
      </div>

      {/* Confirm Phase */}
      {phase === UpdateModalPhase.Confirm && (
        <div className="space-y-4 px-5 py-4">
          <div className="rounded-xl border border-border bg-background/60 p-3.5 space-y-2">
            <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
              <span className="rounded-md bg-surface-raised px-2 py-0.5 text-secondary">
                {fromLabel}
              </span>
              <ChevronRightIcon className="h-3.5 w-3.5 text-secondary" />
              <span className="rounded-md bg-action/15 px-2 py-0.5 font-semibold text-foreground">
                {toLabel}
              </span>
            </div>
            <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 ${SETTINGS_META_TEXT} text-secondary`}>
              <span className="font-mono">{target.name}</span>
              <span>
                {t('dshPluginsUpdateSourceLabel')}: {registryLabel}
              </span>
            </div>
          </div>

          <p className={`${SETTINGS_DESCRIPTION_TEXT} text-secondary leading-relaxed`}>
            {t('dshPluginsUpdateConfirmDesc')
              .replace('{from}', fromLabel)
              .replace('{to}', toLabel)}
          </p>

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={handleGuardedClose}
              className="rounded-xl border border-border px-3.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised"
            >
              {t('cancel')}
            </button>
            <button
              type="button"
              onClick={() => void handleRunUpdate()}
              className="rounded-xl bg-action px-4 py-1.5 text-xs font-medium text-action-foreground transition-colors hover:bg-action-hover"
            >
              {t('dshPluginsUpdateStartBtn')}
            </button>
          </div>
        </div>
      )}

      {/* Running & Done Phases */}
      {phase !== UpdateModalPhase.Confirm && (
        <div className="space-y-4 px-5 py-4">
          {outcomeSummary && (
            <div
              role="status"
              className={`flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-xs ${
                outcomeSummary.tone === 'success'
                  ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200'
                  : outcomeSummary.tone === 'warn'
                    ? 'border-amber-400/50 bg-amber-50/80 text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-200'
                    : 'border-red-300/70 bg-red-50 text-red-700 dark:border-red-800/70 dark:bg-red-950/35 dark:text-red-300'
              }`}
            >
              {outcomeSummary.tone === 'success' ? (
                <CheckCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              ) : outcomeSummary.tone === 'warn' ? (
                <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              ) : (
                <ExclamationCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
              )}
              <div className="min-w-0 space-y-1">
                <div className="font-semibold">{outcomeSummary.title}</div>
                <p className="leading-relaxed opacity-90 break-words">{outcomeSummary.detail}</p>
              </div>
            </div>
          )}

          {/* Step timeline */}
          <ol className="space-y-2 rounded-xl border border-border bg-background/50 px-3.5 py-3">
            {renderedSteps.map((step, index) => {
              const state = resolveUpdateStepVisualState(
                step,
                isRunning,
                index === renderedSteps.length - 1,
                outcome,
              );
              return (
                <li key={step} className="flex items-center gap-2.5 text-xs">
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                    {state === PluginUpdateStepVisualState.Running ? (
                      <ArrowPathIcon className="h-3.5 w-3.5 animate-spin text-foreground" />
                    ) : state === PluginUpdateStepVisualState.Done ? (
                      <CheckCircleIcon className="h-4 w-4 text-emerald-500" />
                    ) : state === PluginUpdateStepVisualState.Failed ? (
                      <ExclamationCircleIcon className="h-4 w-4 text-red-500" />
                    ) : (
                      <ExclamationTriangleIcon className="h-4 w-4 text-amber-500" />
                    )}
                  </span>
                  <span
                    className={
                      state === PluginUpdateStepVisualState.Failed
                        ? 'text-red-600 dark:text-red-400'
                        : state === PluginUpdateStepVisualState.Running
                          ? 'font-medium text-foreground'
                          : 'text-secondary'
                    }
                  >
                    {resolveStepLabel(step)}
                  </span>
                </li>
              );
            })}
          </ol>

          {/* Optional failure log output */}
          {logText && (
            <div className="rounded-xl border border-border bg-background/60">
              <button
                type="button"
                onClick={() => setShowLogDetails((prev) => !prev)}
                className="flex w-full items-center gap-1.5 px-3 py-2 text-xs font-medium text-secondary hover:text-foreground"
              >
                {showLogDetails ? (
                  <ChevronDownIcon className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRightIcon className="h-3.5 w-3.5" />
                )}
                {t('dshPluginsUpdateViewLog')}
              </button>
              {showLogDetails && (
                <pre className="max-h-48 overflow-auto border-t border-border p-3 font-mono text-[11px] leading-relaxed text-secondary whitespace-pre-wrap break-all">
                  {logText}
                </pre>
              )}
            </div>
          )}

          {/* Footer */}
          <div className="flex justify-end gap-2 pt-1">
            {isRunning ? (
              <button
                type="button"
                disabled
                className="inline-flex items-center gap-1.5 rounded-xl border border-border px-3.5 py-1.5 text-xs font-medium text-secondary opacity-75"
              >
                <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" />
                {t('dshPluginsUpdateRunningBtn')}
              </button>
            ) : (
              <>
                {outcome?.restartRequired && onRestartHost && (
                  <button
                    type="button"
                    disabled={restarting}
                    onClick={() => void handleRestartNow()}
                    className="rounded-xl border border-amber-500/40 bg-amber-500/15 px-3.5 py-1.5 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-500/25 disabled:opacity-50 dark:text-amber-200"
                  >
                    {restarting ? t('dshPluginsRestarting') : t('dshPluginsRestartNow')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleGuardedClose}
                  className="rounded-xl bg-action px-4 py-1.5 text-xs font-medium text-action-foreground transition-colors hover:bg-action-hover"
                >
                  {t('dshPluginsUpdateFinishBtn')}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
};
