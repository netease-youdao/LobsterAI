import {
  HtmlShareAccessMode,
  type HtmlShareAccessMode as HtmlShareAccessModeValue,
} from '@shared/htmlShare/constants';

import {
  type ArtifactFileSharePermission,
  ArtifactFileSharePermission as ArtifactFileSharePermissionValue,
} from './artifactFileSharePermission';

export const ArtifactFileShareIntent = {
  Create: 'create',
  Manage: 'manage',
} as const;

export type ArtifactFileShareIntent =
  (typeof ArtifactFileShareIntent)[keyof typeof ArtifactFileShareIntent];

export const ArtifactFileSharePrimaryAction = {
  None: 'none',
  Create: 'create',
  UpdatePermission: 'update_permission',
  Copy: 'copy',
} as const;

export type ArtifactFileSharePrimaryAction =
  (typeof ArtifactFileSharePrimaryAction)[keyof typeof ArtifactFileSharePrimaryAction];

export function isArtifactFileSharePermissionDirty(
  intent: ArtifactFileShareIntent | undefined,
  committedPermission: ArtifactFileSharePermission | undefined,
  selectedPermission: ArtifactFileSharePermission,
): boolean {
  return intent === ArtifactFileShareIntent.Manage &&
    committedPermission !== undefined &&
    selectedPermission !== committedPermission;
}

export function isArtifactFileSharePermissionOptionDisabled(
  intent: ArtifactFileShareIntent | undefined,
  permission: ArtifactFileSharePermission,
): boolean {
  return intent === ArtifactFileShareIntent.Create &&
    permission === ArtifactFileSharePermissionValue.Stopped;
}

export function getArtifactFileShareCreateAccessMode(
  permission: ArtifactFileSharePermission,
): HtmlShareAccessModeValue | null {
  if (permission === ArtifactFileSharePermissionValue.Stopped) return null;
  return permission === ArtifactFileSharePermissionValue.Public
    ? HtmlShareAccessMode.Public
    : HtmlShareAccessMode.Code;
}

export function getArtifactFileSharePrimaryAction(
  intent: ArtifactFileShareIntent | undefined,
  isReady: boolean,
  isPermissionDirty: boolean,
): ArtifactFileSharePrimaryAction {
  if (!isReady) return ArtifactFileSharePrimaryAction.None;
  if (intent === ArtifactFileShareIntent.Create) {
    return ArtifactFileSharePrimaryAction.Create;
  }
  if (intent === ArtifactFileShareIntent.Manage) {
    return isPermissionDirty
      ? ArtifactFileSharePrimaryAction.UpdatePermission
      : ArtifactFileSharePrimaryAction.Copy;
  }
  return ArtifactFileSharePrimaryAction.None;
}
