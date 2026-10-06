import { ArrowPathIcon, CheckCircleIcon, ExclamationCircleIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useState } from 'react';

import { i18nService } from '@/services/i18n';

const t = (key: string) => i18nService.t(key);

const LONG_RUNNING_THRESHOLD_SECONDS = 90;

export const NodeDeploymentPersistenceOperationAction = {
  Download: 'download',
} as const;

export type NodeDeploymentPersistenceOperationAction =
  (typeof NodeDeploymentPersistenceOperationAction)[keyof typeof NodeDeploymentPersistenceOperationAction];

export const NodeDeploymentPersistenceOperationPhase = {
  Running: 'running',
  Succeeded: 'succeeded',
  Failed: 'failed',
} as const;

export type NodeDeploymentPersistenceOperationPhase =
  (typeof NodeDeploymentPersistenceOperationPhase)[keyof typeof NodeDeploymentPersistenceOperationPhase];

export interface NodeDeploymentPersistenceOperationState {
  deploymentId: string;
  action: NodeDeploymentPersistenceOperationAction;
  phase: NodeDeploymentPersistenceOperationPhase;
  startedAt: number;
  archivePath?: string;
  empty?: boolean;
  error?: string;
}

interface NodeDeploymentPersistenceOperationStatusProps {
  operation: NodeDeploymentPersistenceOperationState;
  onRetry: () => void;
}

function getElapsedSeconds(startedAt: number): number {
  return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
}

const NodeDeploymentPersistenceOperationStatus: React.FC<
  NodeDeploymentPersistenceOperationStatusProps
> = ({ operation, onRetry }) => {
  const [elapsedSeconds, setElapsedSeconds] = useState(() =>
    getElapsedSeconds(operation.startedAt),
  );

  useEffect(() => {
    if (operation.phase !== NodeDeploymentPersistenceOperationPhase.Running) return undefined;

    const timer = window.setInterval(() => {
      setElapsedSeconds(getElapsedSeconds(operation.startedAt));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [operation.phase, operation.startedAt]);

  if (operation.phase === NodeDeploymentPersistenceOperationPhase.Running) {
    const progressLabel = t('nodeDeploymentPersistenceDownloadInProgress');

    return (
      <div className="mt-2 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-2 text-xs">
        <div className="flex items-center justify-between gap-3">
          <div
            className="flex min-w-0 items-center gap-1.5 font-medium text-foreground"
            role="status"
          >
            <ArrowPathIcon
              className="h-3.5 w-3.5 shrink-0 text-primary motion-safe:animate-spin"
              aria-hidden="true"
            />
            <span>{progressLabel}</span>
          </div>
          <span className="shrink-0 text-muted" aria-hidden="true">
            {t('nodeDeploymentPersistenceElapsed').replace('{seconds}', String(elapsedSeconds))}
          </span>
        </div>
        <div
          className="persistence-operation-progress mt-2"
          role="progressbar"
          aria-label={progressLabel}
        />
        {elapsedSeconds >= LONG_RUNNING_THRESHOLD_SECONDS && (
          <div className="mt-1.5 text-secondary">{t('nodeDeploymentPersistenceLongRunning')}</div>
        )}
      </div>
    );
  }

  if (operation.phase === NodeDeploymentPersistenceOperationPhase.Failed) {
    const failureMessage = operation.error || t('nodeDeploymentPersistenceDownloadFailed');

    return (
      <div
        className="mt-2 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200"
        role="alert"
      >
        <ExclamationCircleIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 break-words leading-5">{failureMessage}</span>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-current/30 px-2 font-medium transition-colors hover:bg-red-100 dark:hover:bg-red-500/10"
        >
          <ArrowPathIcon className="h-3.5 w-3.5" aria-hidden="true" />
          {t('nodeDeploymentPersistenceRetry')}
        </button>
      </div>
    );
  }

  return (
    <div
      className="mt-2 flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-2 text-xs text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200"
      role="status"
    >
      <CheckCircleIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span>
        {operation.empty
          ? t('nodeDeploymentPersistenceEmpty')
          : t('nodeDeploymentPersistenceDownloadSucceeded')}
      </span>
    </div>
  );
};

export default NodeDeploymentPersistenceOperationStatus;
