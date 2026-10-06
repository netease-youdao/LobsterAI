import {
  HtmlShareAccessMode,
  type HtmlShareConfigurableStatus,
  HtmlShareStatus,
} from '../../../shared/htmlShare/constants';
import {
  type ShareDeploymentRecord,
  ShareDeploymentStatus,
} from '../../../shared/shareDeployment/constants';
import type { HtmlShareCreateResult } from '../htmlShare/htmlShareClient';

export const ShareDeploymentAccessSyncOperation = {
  AccessMode: 'access_mode',
  Status: 'status',
} as const;

export type ShareDeploymentAccessSyncOperation =
  (typeof ShareDeploymentAccessSyncOperation)[keyof typeof ShareDeploymentAccessSyncOperation];

export interface ShareDeploymentAccessSyncFailure {
  operation: ShareDeploymentAccessSyncOperation;
  error?: string;
}

export interface ShareDeploymentAccessSyncIntent {
  accessMode: HtmlShareAccessMode;
  previousAccessMode?: HtmlShareAccessMode;
  targetShareStatus: HtmlShareConfigurableStatus;
}

export interface ShareDeploymentAccessUpdater {
  updateAccessMode: (
    shareId: string,
    accessMode: HtmlShareAccessMode,
  ) => Promise<HtmlShareCreateResult>;
  updateStatus: (
    shareId: string,
    status: HtmlShareConfigurableStatus,
  ) => Promise<HtmlShareCreateResult>;
}

export interface ShareDeploymentAccessSyncResult {
  deployment: ShareDeploymentRecord;
  failures: ShareDeploymentAccessSyncFailure[];
}

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

function normalizeAccessMode(
  value: HtmlShareCreateResult['accessMode'],
  fallback: HtmlShareAccessMode,
): HtmlShareAccessMode {
  return value === HtmlShareAccessMode.Public || value === HtmlShareAccessMode.Code
    ? value
    : fallback;
}

function isPendingDeploymentStatus(status: ShareDeploymentStatus): boolean {
  return status === ShareDeploymentStatus.Queued || status === ShareDeploymentStatus.Deploying;
}

function mergeShareUpdate(
  deployment: ShareDeploymentRecord,
  result: HtmlShareCreateResult,
  fallbackAccessMode: HtmlShareAccessMode,
): ShareDeploymentRecord {
  const accessMode = normalizeAccessMode(result.accessMode, fallbackAccessMode);
  return {
    ...deployment,
    shareId: result.shareId ?? deployment.shareId,
    url: result.url || deployment.url,
    accessMode,
    shareCode:
      accessMode === HtmlShareAccessMode.Code
        ? result.shareCode ?? deployment.shareCode
        : undefined,
    shareCodeUnavailable:
      result.shareCodeUnavailable ?? deployment.shareCodeUnavailable,
    shareStatus: result.status ?? deployment.shareStatus,
    disabledSource:
      result.disabledSource !== undefined
        ? result.disabledSource
        : deployment.disabledSource,
  };
}

export async function reconcileShareDeploymentAccess(
  initialDeployment: ShareDeploymentRecord,
  intent: ShareDeploymentAccessSyncIntent,
  updater: ShareDeploymentAccessUpdater,
): Promise<ShareDeploymentAccessSyncResult> {
  let deployment = initialDeployment;
  const failures: ShareDeploymentAccessSyncFailure[] = [];
  const shareId = deployment.shareId;
  if (!shareId) {
    return { deployment, failures };
  }

  const currentAccessMode = normalizeAccessMode(deployment.accessMode, HtmlShareAccessMode.Code);
  const shouldUpdateAccessMode =
    currentAccessMode !== intent.accessMode ||
    (intent.previousAccessMode !== undefined &&
      intent.previousAccessMode !== intent.accessMode);
  if (shouldUpdateAccessMode) {
    try {
      const accessResult = await updater.updateAccessMode(shareId, intent.accessMode);
      if (!accessResult.success) {
        failures.push({
          operation: ShareDeploymentAccessSyncOperation.AccessMode,
          error: accessResult.error,
        });
      } else {
        deployment = mergeShareUpdate(deployment, accessResult, intent.accessMode);
      }
    } catch (error) {
      failures.push({
        operation: ShareDeploymentAccessSyncOperation.AccessMode,
        error: errorMessage(error),
      });
    }
  }

  if (
    (failures.length === 0 || intent.targetShareStatus === HtmlShareStatus.Disabled) &&
    (intent.targetShareStatus === HtmlShareStatus.Disabled ||
      deployment.shareStatus !== intent.targetShareStatus)
  ) {
    try {
      const statusResult = await updater.updateStatus(
        deployment.shareId ?? shareId,
        intent.targetShareStatus,
      );
      if (!statusResult.success) {
        failures.push({
          operation: ShareDeploymentAccessSyncOperation.Status,
          error: statusResult.error,
        });
      } else {
        deployment = mergeShareUpdate(
          deployment,
          statusResult,
          normalizeAccessMode(deployment.accessMode, intent.accessMode),
        );
        deployment = {
          ...deployment,
          shareStatus: statusResult.status ?? intent.targetShareStatus,
        };
        if (
          intent.targetShareStatus === HtmlShareStatus.Disabled &&
          !isPendingDeploymentStatus(deployment.status)
        ) {
          deployment = {
            ...deployment,
            status: ShareDeploymentStatus.Stopped,
          };
        }
      }
    } catch (error) {
      failures.push({
        operation: ShareDeploymentAccessSyncOperation.Status,
        error: errorMessage(error),
      });
    }
  }

  return { deployment, failures };
}

export class ShareDeploymentOperationCoordinator {
  private readonly operationTails = new Map<string, Promise<void>>();

  async run<T>(sourceKey: string, operation: () => Promise<T>): Promise<T> {
    const previousTail = this.operationTails.get(sourceKey) ?? Promise.resolve();
    let releaseCurrent: () => void = () => undefined;
    const currentBarrier = new Promise<void>(resolve => {
      releaseCurrent = resolve;
    });
    const currentTail = previousTail
      .catch((): void => undefined)
      .then(() => currentBarrier);
    this.operationTails.set(sourceKey, currentTail);

    await previousTail.catch((): void => undefined);
    try {
      return await operation();
    } finally {
      releaseCurrent();
      if (this.operationTails.get(sourceKey) === currentTail) {
        this.operationTails.delete(sourceKey);
      }
    }
  }
}
