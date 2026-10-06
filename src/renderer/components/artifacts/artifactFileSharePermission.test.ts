import {
  HtmlShareAccessMode,
  HtmlShareDisabledSource,
  HtmlShareStatus,
} from '@shared/htmlShare/constants';
import { describe, expect, test } from 'vitest';

import {
  ArtifactFileSharePermission,
  ArtifactFileSharePermissionChangeAction,
  ArtifactFileSharePermissionConfirmationKind,
  type ArtifactFileSharePermissionRecord,
  buildArtifactFileSharePermissionPlan,
  deriveArtifactFileSharePermission,
  isArtifactFileShareResumeLocked,
  resolveArtifactFileSharePermissionConfirmation,
} from './artifactFileSharePermission';

function makeShare(
  overrides: Partial<ArtifactFileSharePermissionRecord> = {},
): ArtifactFileSharePermissionRecord {
  return {
    accessMode: HtmlShareAccessMode.Code,
    status: HtmlShareStatus.Live,
    ...overrides,
  };
}

describe('deriveArtifactFileSharePermission', () => {
  test.each([
    [HtmlShareAccessMode.Public, ArtifactFileSharePermission.Public],
    [HtmlShareAccessMode.Code, ArtifactFileSharePermission.Code],
  ])('derives live %s access as %s permission', (accessMode, expected) => {
    expect(deriveArtifactFileSharePermission(makeShare({ accessMode }))).toBe(expected);
  });

  test.each([HtmlShareAccessMode.Public, HtmlShareAccessMode.Code])(
    'derives disabled %s access as stopped permission',
    accessMode => {
      expect(
        deriveArtifactFileSharePermission(
          makeShare({
            accessMode,
            status: HtmlShareStatus.Disabled,
          }),
        ),
      ).toBe(ArtifactFileSharePermission.Stopped);
    },
  );

  test.each([
    [HtmlShareAccessMode.Public, ArtifactFileSharePermission.Public],
    [HtmlShareAccessMode.Code, ArtifactFileSharePermission.Code],
  ])('preserves %s access for a failed share', (accessMode, expected) => {
    expect(
      deriveArtifactFileSharePermission(
        makeShare({
          accessMode,
          status: HtmlShareStatus.Failed,
        }),
      ),
    ).toBe(expected);
  });
});

describe('isArtifactFileShareResumeLocked', () => {
  test.each([
    HtmlShareDisabledSource.Admin,
    HtmlShareDisabledSource.Moderation,
    HtmlShareDisabledSource.System,
  ])('locks a share disabled by %s', disabledSource => {
    expect(isArtifactFileShareResumeLocked(disabledSource)).toBe(true);
  });

  test.each([HtmlShareDisabledSource.User, HtmlShareDisabledSource.ActiveLimit, undefined, null])(
    'does not lock a share disabled by %s',
    disabledSource => {
      expect(isArtifactFileShareResumeLocked(disabledSource)).toBe(false);
    },
  );
});

describe('resolveArtifactFileSharePermissionConfirmation', () => {
  test.each([
    [
      ArtifactFileSharePermission.Code,
      ArtifactFileSharePermission.Public,
      ArtifactFileSharePermissionConfirmationKind.MakePublic,
    ],
    [
      ArtifactFileSharePermission.Public,
      ArtifactFileSharePermission.Code,
      ArtifactFileSharePermissionConfirmationKind.RequireCode,
    ],
    [
      ArtifactFileSharePermission.Public,
      ArtifactFileSharePermission.Stopped,
      ArtifactFileSharePermissionConfirmationKind.Stop,
    ],
    [
      ArtifactFileSharePermission.Code,
      ArtifactFileSharePermission.Stopped,
      ArtifactFileSharePermissionConfirmationKind.Stop,
    ],
    [
      ArtifactFileSharePermission.Stopped,
      ArtifactFileSharePermission.Public,
      ArtifactFileSharePermissionConfirmationKind.Resume,
    ],
    [
      ArtifactFileSharePermission.Stopped,
      ArtifactFileSharePermission.Code,
      ArtifactFileSharePermissionConfirmationKind.Resume,
    ],
  ])(
    'resolves the %s to %s transition as %s',
    (current, target, expected) => {
      expect(resolveArtifactFileSharePermissionConfirmation(current, target)).toBe(expected);
    },
  );

  test.each(Object.values(ArtifactFileSharePermission))(
    'does not confirm when %s remains unchanged',
    permission => {
      expect(resolveArtifactFileSharePermissionConfirmation(permission, permission)).toBeUndefined();
    },
  );
});

describe('buildArtifactFileSharePermissionPlan', () => {
  test.each([
    [HtmlShareAccessMode.Public, ArtifactFileSharePermission.Public],
    [HtmlShareAccessMode.Code, ArtifactFileSharePermission.Code],
  ])('does nothing when live %s access already matches', (accessMode, target) => {
    expect(buildArtifactFileSharePermissionPlan(makeShare({ accessMode }), target)).toEqual([]);
  });

  test.each([
    [HtmlShareAccessMode.Public, ArtifactFileSharePermission.Code],
    [HtmlShareAccessMode.Code, ArtifactFileSharePermission.Public],
  ])('updates live %s access immediately', (accessMode, target) => {
    expect(buildArtifactFileSharePermissionPlan(makeShare({ accessMode }), target)).toEqual([
      {
        action: ArtifactFileSharePermissionChangeAction.UpdateAccess,
        accessMode:
          target === ArtifactFileSharePermission.Public
            ? HtmlShareAccessMode.Public
            : HtmlShareAccessMode.Code,
      },
    ]);
  });

  test.each([HtmlShareAccessMode.Public, HtmlShareAccessMode.Code])(
    'stops a live %s share',
    accessMode => {
      expect(
        buildArtifactFileSharePermissionPlan(
          makeShare({ accessMode }),
          ArtifactFileSharePermission.Stopped,
        ),
      ).toEqual([
        {
          action: ArtifactFileSharePermissionChangeAction.UpdateStatus,
          status: HtmlShareStatus.Disabled,
        },
      ]);
    },
  );

  test('does nothing when an existing share remains stopped', () => {
    expect(
      buildArtifactFileSharePermissionPlan(
        makeShare({
          status: HtmlShareStatus.Disabled,
          disabledSource: HtmlShareDisabledSource.User,
        }),
        ArtifactFileSharePermission.Stopped,
      ),
    ).toEqual([]);
  });

  test('resumes a user-stopped share with its previous access mode', () => {
    expect(
      buildArtifactFileSharePermissionPlan(
        makeShare({
          accessMode: HtmlShareAccessMode.Code,
          status: HtmlShareStatus.Disabled,
          disabledSource: HtmlShareDisabledSource.User,
        }),
        ArtifactFileSharePermission.Code,
      ),
    ).toEqual([
      {
        action: ArtifactFileSharePermissionChangeAction.UpdateStatus,
        status: HtmlShareStatus.Live,
      },
    ]);
  });

  test('updates access before resuming a user-stopped share', () => {
    expect(
      buildArtifactFileSharePermissionPlan(
        makeShare({
          accessMode: HtmlShareAccessMode.Code,
          status: HtmlShareStatus.Disabled,
          disabledSource: HtmlShareDisabledSource.User,
        }),
        ArtifactFileSharePermission.Public,
      ),
    ).toEqual([
      {
        action: ArtifactFileSharePermissionChangeAction.UpdateAccess,
        accessMode: HtmlShareAccessMode.Public,
      },
      {
        action: ArtifactFileSharePermissionChangeAction.UpdateStatus,
        status: HtmlShareStatus.Live,
      },
    ]);
  });

  test('treats a missing disabled source as user-resumable', () => {
    expect(
      buildArtifactFileSharePermissionPlan(
        makeShare({
          accessMode: HtmlShareAccessMode.Public,
          status: HtmlShareStatus.Disabled,
        }),
        ArtifactFileSharePermission.Public,
      ),
    ).toEqual([
      {
        action: ArtifactFileSharePermissionChangeAction.UpdateStatus,
        status: HtmlShareStatus.Live,
      },
    ]);
  });

  test.each([
    HtmlShareDisabledSource.Admin,
    HtmlShareDisabledSource.Moderation,
    HtmlShareDisabledSource.System,
  ])('blocks resuming a share disabled by %s', disabledSource => {
    expect(
      buildArtifactFileSharePermissionPlan(
        makeShare({
          status: HtmlShareStatus.Disabled,
          disabledSource,
        }),
        ArtifactFileSharePermission.Code,
      ),
    ).toEqual([
      {
        action: ArtifactFileSharePermissionChangeAction.Blocked,
        disabledSource,
      },
    ]);
  });

  test('restores an active-limit share when access does not change', () => {
    expect(
      buildArtifactFileSharePermissionPlan(
        makeShare({
          accessMode: HtmlShareAccessMode.Code,
          status: HtmlShareStatus.Disabled,
          disabledSource: HtmlShareDisabledSource.ActiveLimit,
        }),
        ArtifactFileSharePermission.Code,
      ),
    ).toEqual([{ action: ArtifactFileSharePermissionChangeAction.RestoreActiveLimit }]);
  });

  test('updates access before restoring an active-limit share', () => {
    expect(
      buildArtifactFileSharePermissionPlan(
        makeShare({
          accessMode: HtmlShareAccessMode.Code,
          status: HtmlShareStatus.Disabled,
          disabledSource: HtmlShareDisabledSource.ActiveLimit,
        }),
        ArtifactFileSharePermission.Public,
      ),
    ).toEqual([
      {
        action: ArtifactFileSharePermissionChangeAction.UpdateAccess,
        accessMode: HtmlShareAccessMode.Public,
      },
      { action: ArtifactFileSharePermissionChangeAction.RestoreActiveLimit },
    ]);
  });
});
