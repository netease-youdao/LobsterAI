import { HtmlShareAccessMode } from '@shared/htmlShare/constants';
import { describe, expect, test } from 'vitest';

import {
  ArtifactFileShareIntent,
  ArtifactFileSharePrimaryAction,
  getArtifactFileShareCreateAccessMode,
  getArtifactFileSharePrimaryAction,
  isArtifactFileSharePermissionDirty,
  isArtifactFileSharePermissionOptionDisabled,
} from './artifactFileShareDialogModel';
import { ArtifactFileSharePermission } from './artifactFileSharePermission';

describe('getArtifactFileShareCreateAccessMode', () => {
  test.each([
    [ArtifactFileSharePermission.Public, HtmlShareAccessMode.Public],
    [ArtifactFileSharePermission.Code, HtmlShareAccessMode.Code],
    [ArtifactFileSharePermission.Stopped, null],
  ])('maps %s creation permission to %s', (permission, expected) => {
    expect(getArtifactFileShareCreateAccessMode(permission)).toBe(expected);
  });
});

describe('isArtifactFileSharePermissionDirty', () => {
  test('does not treat a create selection as an update', () => {
    expect(
      isArtifactFileSharePermissionDirty(
        ArtifactFileShareIntent.Create,
        undefined,
        ArtifactFileSharePermission.Public,
      ),
    ).toBe(false);
  });

  test('detects a changed permission for an existing share', () => {
    expect(
      isArtifactFileSharePermissionDirty(
        ArtifactFileShareIntent.Manage,
        ArtifactFileSharePermission.Code,
        ArtifactFileSharePermission.Public,
      ),
    ).toBe(true);
  });

  test('clears the dirty state when the original permission is selected again', () => {
    expect(
      isArtifactFileSharePermissionDirty(
        ArtifactFileShareIntent.Manage,
        ArtifactFileSharePermission.Code,
        ArtifactFileSharePermission.Code,
      ),
    ).toBe(false);
  });
});

describe('isArtifactFileSharePermissionOptionDisabled', () => {
  test('disables stop access before a share has been created', () => {
    expect(
      isArtifactFileSharePermissionOptionDisabled(
        ArtifactFileShareIntent.Create,
        ArtifactFileSharePermission.Stopped,
      ),
    ).toBe(true);
  });

  test.each([
    ArtifactFileSharePermission.Public,
    ArtifactFileSharePermission.Code,
  ])('allows %s access before creation', permission => {
    expect(
      isArtifactFileSharePermissionOptionDisabled(
        ArtifactFileShareIntent.Create,
        permission,
      ),
    ).toBe(false);
  });

  test('allows stop access for an existing share', () => {
    expect(
      isArtifactFileSharePermissionOptionDisabled(
        ArtifactFileShareIntent.Manage,
        ArtifactFileSharePermission.Stopped,
      ),
    ).toBe(false);
  });
});

describe('getArtifactFileSharePrimaryAction', () => {
  test.each([
    [undefined, false, false],
    [ArtifactFileShareIntent.Create, false, false],
    [ArtifactFileShareIntent.Manage, false, true],
  ] as const)('shows no primary action before the dialog is ready', (intent, isReady, isDirty) => {
    expect(getArtifactFileSharePrimaryAction(intent, isReady, isDirty)).toBe(
      ArtifactFileSharePrimaryAction.None,
    );
  });

  test('shows create for a new share', () => {
    expect(
      getArtifactFileSharePrimaryAction(ArtifactFileShareIntent.Create, true, false),
    ).toBe(ArtifactFileSharePrimaryAction.Create);
  });

  test('shows copy for an unchanged existing share', () => {
    expect(
      getArtifactFileSharePrimaryAction(ArtifactFileShareIntent.Manage, true, false),
    ).toBe(ArtifactFileSharePrimaryAction.Copy);
  });

  test('replaces copy with update when permission changes', () => {
    expect(
      getArtifactFileSharePrimaryAction(ArtifactFileShareIntent.Manage, true, true),
    ).toBe(ArtifactFileSharePrimaryAction.UpdatePermission);
  });
});
