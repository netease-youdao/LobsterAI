import {
  HtmlShareAccessMode,
  type HtmlShareAccessMode as HtmlShareAccessModeValue,
  type HtmlShareConfigurableStatus,
  HtmlShareDisabledSource,
  type HtmlShareDisabledSource as HtmlShareDisabledSourceValue,
  HtmlShareStatus,
  type HtmlShareStatus as HtmlShareStatusValue,
} from '@shared/htmlShare/constants';
import {
  ShareDeploymentKind,
  type ShareDeploymentPersistence,
  type ShareDeploymentRecord,
  ShareDeploymentStatus,
  type ShareDeploymentStatus as ShareDeploymentStatusValue,
} from '@shared/shareDeployment/constants';

export const LocalServiceDeploymentPermission = {
  Public: HtmlShareAccessMode.Public,
  Code: HtmlShareAccessMode.Code,
  Stopped: HtmlShareStatus.Disabled,
} as const;

export type LocalServiceDeploymentPermission =
  (typeof LocalServiceDeploymentPermission)[keyof typeof LocalServiceDeploymentPermission];

export const LocalServiceDeploymentPermissionSubmitAction = {
  None: 'none',
  UpdatePermission: 'update_permission',
  RedeployAndEnable: 'redeploy_and_enable',
  Blocked: 'blocked',
} as const;

export type LocalServiceDeploymentPermissionSubmitAction =
  (typeof LocalServiceDeploymentPermissionSubmitAction)[
    keyof typeof LocalServiceDeploymentPermissionSubmitAction
  ];

export interface LocalServiceDeploymentPermissionState {
  accessMode: HtmlShareAccessModeValue;
  targetStatus: HtmlShareConfigurableStatus;
}

export const LocalServiceDeploymentPermissionChangeAction = {
  UpdateAccess: 'update_access',
  UpdateStatus: 'update_status',
  RequireRedeploy: 'require_redeploy',
  Blocked: 'blocked',
} as const;

export type LocalServiceDeploymentPermissionChangeStep =
  | {
      action: typeof LocalServiceDeploymentPermissionChangeAction.UpdateAccess;
      accessMode: HtmlShareAccessModeValue;
    }
  | {
      action: typeof LocalServiceDeploymentPermissionChangeAction.UpdateStatus;
      status: HtmlShareConfigurableStatus;
    }
  | {
      action: typeof LocalServiceDeploymentPermissionChangeAction.RequireRedeploy;
      accessMode: HtmlShareAccessModeValue;
    }
  | {
      action: typeof LocalServiceDeploymentPermissionChangeAction.Blocked;
      disabledSource: HtmlShareDisabledSourceValue;
    };

export interface LocalServiceDeploymentShareUpdate {
  shareId?: string;
  url?: string;
  accessMode?: HtmlShareAccessModeValue;
  shareCode?: string;
  shareCodeUnavailable?: boolean;
  status?: HtmlShareStatusValue;
  disabledSource?: HtmlShareDisabledSourceValue | null;
}

function normalizeAccessMode(
  accessMode?: HtmlShareAccessModeValue,
): HtmlShareAccessModeValue {
  return accessMode === HtmlShareAccessMode.Public
    ? HtmlShareAccessMode.Public
    : HtmlShareAccessMode.Code;
}

export function getLocalServiceDeploymentPermission(
  accessMode?: HtmlShareAccessModeValue,
  targetStatus?: HtmlShareStatusValue,
): LocalServiceDeploymentPermission {
  if (targetStatus === HtmlShareStatus.Disabled) {
    return LocalServiceDeploymentPermission.Stopped;
  }
  return normalizeAccessMode(accessMode) === HtmlShareAccessMode.Public
    ? LocalServiceDeploymentPermission.Public
    : LocalServiceDeploymentPermission.Code;
}

export function getLocalServiceDeploymentPermissionState(
  selection: LocalServiceDeploymentPermission,
  currentAccessMode?: HtmlShareAccessModeValue,
): LocalServiceDeploymentPermissionState {
  if (selection === LocalServiceDeploymentPermission.Stopped) {
    return {
      accessMode: normalizeAccessMode(currentAccessMode),
      targetStatus: HtmlShareStatus.Disabled,
    };
  }
  return {
    accessMode:
      selection === LocalServiceDeploymentPermission.Public
        ? HtmlShareAccessMode.Public
        : HtmlShareAccessMode.Code,
    targetStatus: HtmlShareStatus.Live,
  };
}

export function getCommittedLocalServiceDeploymentPermission(
  deployment?: Pick<
    ShareDeploymentRecord,
    'accessMode' | 'shareStatus' | 'status'
  > | null,
): LocalServiceDeploymentPermission | undefined {
  if (!deployment) return undefined;
  return getLocalServiceDeploymentPermission(
    deployment.accessMode,
    isLocalServiceDeploymentStopped(deployment.shareStatus, deployment.status)
      ? HtmlShareStatus.Disabled
      : HtmlShareStatus.Live,
  );
}

export function isLocalServiceDeploymentPermissionDirty(
  deployment: Pick<
    ShareDeploymentRecord,
    'accessMode' | 'shareStatus' | 'status'
  > | null | undefined,
  selectedPermission: LocalServiceDeploymentPermission,
): boolean {
  const committedPermission = getCommittedLocalServiceDeploymentPermission(deployment);
  return committedPermission !== undefined && committedPermission !== selectedPermission;
}

export function isLocalServiceDeploymentPermissionLocked(
  disabledSource?: HtmlShareDisabledSourceValue | null,
): boolean {
  return (
    disabledSource === HtmlShareDisabledSource.Admin ||
    disabledSource === HtmlShareDisabledSource.Moderation ||
    disabledSource === HtmlShareDisabledSource.System
  );
}

export function buildLocalServiceDeploymentPermissionPlan(
  deployment: Pick<
    ShareDeploymentRecord,
    'accessMode' | 'deploymentKind' | 'disabledSource' | 'shareStatus' | 'status'
  >,
  target: LocalServiceDeploymentPermission,
): LocalServiceDeploymentPermissionChangeStep[] {
  const isStopped = isLocalServiceDeploymentStopped(
    deployment.shareStatus,
    deployment.status,
  );
  const current = getLocalServiceDeploymentPermission(
    deployment.accessMode,
    isStopped ? HtmlShareStatus.Disabled : HtmlShareStatus.Live,
  );
  if (current === target) return [];

  if (isStopped && isLocalServiceDeploymentPermissionLocked(deployment.disabledSource)) {
    return [{
      action: LocalServiceDeploymentPermissionChangeAction.Blocked,
      disabledSource: deployment.disabledSource as HtmlShareDisabledSourceValue,
    }];
  }

  if (target === LocalServiceDeploymentPermission.Stopped) {
    return [{
      action: LocalServiceDeploymentPermissionChangeAction.UpdateStatus,
      status: HtmlShareStatus.Disabled,
    }];
  }

  const targetState = getLocalServiceDeploymentPermissionState(
    target,
    deployment.accessMode,
  );
  if (isStopped && deployment.deploymentKind !== ShareDeploymentKind.StaticSite) {
    return [{
      action: LocalServiceDeploymentPermissionChangeAction.RequireRedeploy,
      accessMode: targetState.accessMode,
    }];
  }

  const steps: LocalServiceDeploymentPermissionChangeStep[] = [];
  if (normalizeAccessMode(deployment.accessMode) !== targetState.accessMode) {
    steps.push({
      action: LocalServiceDeploymentPermissionChangeAction.UpdateAccess,
      accessMode: targetState.accessMode,
    });
  }
  if (isStopped) {
    steps.push({
      action: LocalServiceDeploymentPermissionChangeAction.UpdateStatus,
      status: HtmlShareStatus.Live,
    });
  }
  return steps;
}

export function getLocalServiceDeploymentPermissionSubmitAction(
  deployment: Pick<
    ShareDeploymentRecord,
    'accessMode' | 'deploymentKind' | 'disabledSource' | 'shareStatus' | 'status'
  > | null | undefined,
  selectedPermission: LocalServiceDeploymentPermission,
): LocalServiceDeploymentPermissionSubmitAction {
  if (!deployment) return LocalServiceDeploymentPermissionSubmitAction.None;
  const plan = buildLocalServiceDeploymentPermissionPlan(deployment, selectedPermission);
  if (plan.length === 0) return LocalServiceDeploymentPermissionSubmitAction.None;
  if (plan.some(step => step.action === LocalServiceDeploymentPermissionChangeAction.Blocked)) {
    return LocalServiceDeploymentPermissionSubmitAction.Blocked;
  }
  if (plan.some(
    step => step.action === LocalServiceDeploymentPermissionChangeAction.RequireRedeploy,
  )) {
    return LocalServiceDeploymentPermissionSubmitAction.RedeployAndEnable;
  }
  return LocalServiceDeploymentPermissionSubmitAction.UpdatePermission;
}

export function mergeLocalServiceDeploymentShareUpdate(
  deployment: ShareDeploymentRecord,
  update: LocalServiceDeploymentShareUpdate,
  fallbackAccessMode: HtmlShareAccessModeValue,
  fallbackStatus: HtmlShareConfigurableStatus,
): ShareDeploymentRecord {
  const accessMode = normalizeAccessMode(update.accessMode ?? fallbackAccessMode);
  const shareStatus = update.status ?? fallbackStatus;
  let deploymentStatus = deployment.status;
  if (
    shareStatus === HtmlShareStatus.Disabled &&
    deploymentStatus !== ShareDeploymentStatus.Queued &&
    deploymentStatus !== ShareDeploymentStatus.Deploying
  ) {
    deploymentStatus = ShareDeploymentStatus.Stopped;
  } else if (
    shareStatus === HtmlShareStatus.Live &&
    deploymentStatus === ShareDeploymentStatus.Stopped
  ) {
    deploymentStatus = ShareDeploymentStatus.Live;
  }

  return {
    ...deployment,
    status: deploymentStatus,
    shareId: update.shareId ?? deployment.shareId,
    url: update.url || deployment.url,
    accessMode,
    shareCode:
      accessMode === HtmlShareAccessMode.Code
        ? update.shareCode ?? (
            deployment.accessMode === HtmlShareAccessMode.Code
              ? deployment.shareCode
              : undefined
          )
        : undefined,
    shareCodeUnavailable:
      update.shareCodeUnavailable ?? deployment.shareCodeUnavailable,
    shareStatus,
    disabledSource:
      update.disabledSource !== undefined
        ? update.disabledSource
        : deployment.disabledSource,
  };
}

export function isLocalServiceDeploymentStopped(
  shareStatus?: HtmlShareStatusValue,
  deploymentStatus?: ShareDeploymentStatusValue,
): boolean {
  return shareStatus === HtmlShareStatus.Disabled ||
    deploymentStatus === ShareDeploymentStatus.Stopped;
}

export function canCopyLocalServiceDeploymentLink(
  deployment?: Pick<ShareDeploymentRecord, 'status' | 'url'> | null,
  isOperationPending = false,
): boolean {
  if (!deployment?.url?.trim() || isOperationPending) return false;
  return (
    deployment.status === ShareDeploymentStatus.Live ||
    deployment.status === ShareDeploymentStatus.Stopped
  );
}

export function getLocalServiceDeploymentProjectName(
  directory: string | null | undefined,
  fallback = '',
): string {
  const normalized = directory?.trim().replace(/\\/g, '/').replace(/\/+$/, '') ?? '';
  if (!normalized || /^[A-Za-z]:$/.test(normalized)) {
    return fallback;
  }
  const separatorIndex = normalized.lastIndexOf('/');
  const projectName = separatorIndex >= 0
    ? normalized.slice(separatorIndex + 1)
    : normalized;
  return projectName || fallback;
}

export function hasConfiguredLocalServiceCloudData(
  persistence?: ShareDeploymentPersistence | null,
): boolean {
  return Boolean(persistence?.enabled && persistence.bindings.length > 0);
}
