import {
  HtmlShareAccessMode,
  HtmlShareDisabledSource,
  HtmlShareStatus,
} from '@shared/htmlShare/constants';
import {
  ShareDeploymentKind,
  type ShareDeploymentPersistence,
  ShareDeploymentPersistenceBindingKind,
  ShareDeploymentPersistenceProvider,
  ShareDeploymentStatus,
} from '@shared/shareDeployment/constants';
import { describe, expect, test } from 'vitest';

import {
  buildLocalServiceDeploymentPermissionPlan,
  canCopyLocalServiceDeploymentLink,
  getCommittedLocalServiceDeploymentPermission,
  getLocalServiceDeploymentPermission,
  getLocalServiceDeploymentPermissionState,
  getLocalServiceDeploymentPermissionSubmitAction,
  getLocalServiceDeploymentProjectName,
  hasConfiguredLocalServiceCloudData,
  isLocalServiceDeploymentPermissionDirty,
  isLocalServiceDeploymentPermissionLocked,
  isLocalServiceDeploymentStopped,
  LocalServiceDeploymentPermission,
  LocalServiceDeploymentPermissionChangeAction,
  LocalServiceDeploymentPermissionSubmitAction,
  mergeLocalServiceDeploymentShareUpdate,
} from './localServiceDeploymentModel';

const configuredPersistence: ShareDeploymentPersistence = {
  enabled: true,
  provider: ShareDeploymentPersistenceProvider.Filesystem,
  bindings: [
    {
      appPath: 'data',
      dataPath: 'data',
      kind: ShareDeploymentPersistenceBindingKind.Directory,
    },
  ],
};

describe('getLocalServiceDeploymentPermission', () => {
  test.each([
    [HtmlShareAccessMode.Public, HtmlShareStatus.Live, LocalServiceDeploymentPermission.Public],
    [HtmlShareAccessMode.Code, HtmlShareStatus.Live, LocalServiceDeploymentPermission.Code],
    [HtmlShareAccessMode.Public, HtmlShareStatus.Failed, LocalServiceDeploymentPermission.Public],
    [HtmlShareAccessMode.Code, undefined, LocalServiceDeploymentPermission.Code],
    [undefined, undefined, LocalServiceDeploymentPermission.Code],
  ])('maps %s access with %s status to %s', (accessMode, targetStatus, expected) => {
    expect(getLocalServiceDeploymentPermission(accessMode, targetStatus)).toBe(expected);
  });

  test.each([HtmlShareAccessMode.Public, HtmlShareAccessMode.Code])(
    'maps disabled %s access to stopped',
    accessMode => {
      expect(
        getLocalServiceDeploymentPermission(accessMode, HtmlShareStatus.Disabled),
      ).toBe(LocalServiceDeploymentPermission.Stopped);
    },
  );
});

describe('getLocalServiceDeploymentPermissionState', () => {
  test.each([
    [LocalServiceDeploymentPermission.Public, HtmlShareAccessMode.Code, HtmlShareAccessMode.Public],
    [LocalServiceDeploymentPermission.Code, HtmlShareAccessMode.Public, HtmlShareAccessMode.Code],
  ])('activates %s access', (selection, currentAccessMode, expectedAccessMode) => {
    expect(
      getLocalServiceDeploymentPermissionState(selection, currentAccessMode),
    ).toEqual({
      accessMode: expectedAccessMode,
      targetStatus: HtmlShareStatus.Live,
    });
  });

  test.each([HtmlShareAccessMode.Public, HtmlShareAccessMode.Code])(
    'stops access while preserving the current %s mode',
    currentAccessMode => {
      expect(
        getLocalServiceDeploymentPermissionState(
          LocalServiceDeploymentPermission.Stopped,
          currentAccessMode,
        ),
      ).toEqual({
        accessMode: currentAccessMode,
        targetStatus: HtmlShareStatus.Disabled,
      });
    },
  );

  test('defaults a stopped deployment with no access mode to code access', () => {
    expect(
      getLocalServiceDeploymentPermissionState(LocalServiceDeploymentPermission.Stopped),
    ).toEqual({
      accessMode: HtmlShareAccessMode.Code,
      targetStatus: HtmlShareStatus.Disabled,
    });
  });
});

describe('buildLocalServiceDeploymentPermissionPlan', () => {
  const liveCodeDeployment = {
    accessMode: HtmlShareAccessMode.Code,
    deploymentKind: ShareDeploymentKind.NodeService,
    shareStatus: HtmlShareStatus.Live,
    status: ShareDeploymentStatus.Live,
  };

  test('updates only the access mode between live permissions', () => {
    expect(
      buildLocalServiceDeploymentPermissionPlan(
        liveCodeDeployment,
        LocalServiceDeploymentPermission.Public,
      ),
    ).toEqual([{
      action: LocalServiceDeploymentPermissionChangeAction.UpdateAccess,
      accessMode: HtmlShareAccessMode.Public,
    }]);
  });

  test('plans a live public deployment update to share-code access', () => {
    expect(
      buildLocalServiceDeploymentPermissionPlan(
        {
          ...liveCodeDeployment,
          accessMode: HtmlShareAccessMode.Public,
        },
        LocalServiceDeploymentPermission.Code,
      ),
    ).toEqual([{
      action: LocalServiceDeploymentPermissionChangeAction.UpdateAccess,
      accessMode: HtmlShareAccessMode.Code,
    }]);
  });

  test('stops a live deployment without changing its access mode', () => {
    expect(
      buildLocalServiceDeploymentPermissionPlan(
        liveCodeDeployment,
        LocalServiceDeploymentPermission.Stopped,
      ),
    ).toEqual([{
      action: LocalServiceDeploymentPermissionChangeAction.UpdateStatus,
      status: HtmlShareStatus.Disabled,
    }]);
  });

  test('requires redeployment instead of resuming a stopped deployment', () => {
    expect(
      buildLocalServiceDeploymentPermissionPlan(
        {
          ...liveCodeDeployment,
          shareStatus: HtmlShareStatus.Disabled,
          status: ShareDeploymentStatus.Stopped,
        },
        LocalServiceDeploymentPermission.Code,
      ),
    ).toEqual([{
      action: LocalServiceDeploymentPermissionChangeAction.RequireRedeploy,
      accessMode: HtmlShareAccessMode.Code,
    }]);
  });

  test('stages the selected access mode for redeployment without updating the stopped share', () => {
    expect(
      buildLocalServiceDeploymentPermissionPlan(
        {
          ...liveCodeDeployment,
          shareStatus: HtmlShareStatus.Disabled,
          status: ShareDeploymentStatus.Stopped,
        },
        LocalServiceDeploymentPermission.Public,
      ),
    ).toEqual([{
      action: LocalServiceDeploymentPermissionChangeAction.RequireRedeploy,
      accessMode: HtmlShareAccessMode.Public,
    }]);
  });

  test('reopens a stopped static deployment without requiring redeployment', () => {
    expect(
      buildLocalServiceDeploymentPermissionPlan(
        {
          ...liveCodeDeployment,
          deploymentKind: ShareDeploymentKind.StaticSite,
          shareStatus: HtmlShareStatus.Disabled,
          status: ShareDeploymentStatus.Stopped,
        },
        LocalServiceDeploymentPermission.Public,
      ),
    ).toEqual([
      {
        action: LocalServiceDeploymentPermissionChangeAction.UpdateAccess,
        accessMode: HtmlShareAccessMode.Public,
      },
      {
        action: LocalServiceDeploymentPermissionChangeAction.UpdateStatus,
        status: HtmlShareStatus.Live,
      },
    ]);
  });

  test('does nothing when a stopped deployment remains stopped', () => {
    expect(
      buildLocalServiceDeploymentPermissionPlan(
        {
          ...liveCodeDeployment,
          shareStatus: HtmlShareStatus.Disabled,
          status: ShareDeploymentStatus.Stopped,
        },
        LocalServiceDeploymentPermission.Stopped,
      ),
    ).toEqual([]);
  });

  test.each([
    HtmlShareDisabledSource.Admin,
    HtmlShareDisabledSource.Moderation,
    HtmlShareDisabledSource.System,
  ])('blocks restoring a deployment stopped by %s', disabledSource => {
    expect(isLocalServiceDeploymentPermissionLocked(disabledSource)).toBe(true);
    expect(
      buildLocalServiceDeploymentPermissionPlan(
        {
          ...liveCodeDeployment,
          disabledSource,
          shareStatus: HtmlShareStatus.Disabled,
          status: ShareDeploymentStatus.Stopped,
        },
        LocalServiceDeploymentPermission.Public,
      ),
    ).toEqual([{
      action: LocalServiceDeploymentPermissionChangeAction.Blocked,
      disabledSource,
    }]);
  });
});

describe('local service deployment permission submission state', () => {
  const liveCodeDeployment = {
    accessMode: HtmlShareAccessMode.Code,
    deploymentKind: ShareDeploymentKind.NodeService,
    shareStatus: HtmlShareStatus.Live,
    status: ShareDeploymentStatus.Live,
  };

  test('derives the committed permission from the deployment', () => {
    expect(getCommittedLocalServiceDeploymentPermission(liveCodeDeployment)).toBe(
      LocalServiceDeploymentPermission.Code,
    );
    expect(getCommittedLocalServiceDeploymentPermission({
      ...liveCodeDeployment,
      shareStatus: HtmlShareStatus.Disabled,
      status: ShareDeploymentStatus.Stopped,
    })).toBe(LocalServiceDeploymentPermission.Stopped);
  });

  test('detects a local permission draft and clears it when restored', () => {
    expect(isLocalServiceDeploymentPermissionDirty(
      liveCodeDeployment,
      LocalServiceDeploymentPermission.Public,
    )).toBe(true);
    expect(isLocalServiceDeploymentPermissionDirty(
      liveCodeDeployment,
      LocalServiceDeploymentPermission.Code,
    )).toBe(false);
    expect(isLocalServiceDeploymentPermissionDirty(
      null,
      LocalServiceDeploymentPermission.Public,
    )).toBe(false);
  });

  test('has no permission update action before deployment or without changes', () => {
    expect(getLocalServiceDeploymentPermissionSubmitAction(
      null,
      LocalServiceDeploymentPermission.Public,
    )).toBe(LocalServiceDeploymentPermissionSubmitAction.None);
    expect(getLocalServiceDeploymentPermissionSubmitAction(
      liveCodeDeployment,
      LocalServiceDeploymentPermission.Code,
    )).toBe(LocalServiceDeploymentPermissionSubmitAction.None);
  });

  test.each([
    LocalServiceDeploymentPermission.Public,
    LocalServiceDeploymentPermission.Stopped,
  ])('requires explicit permission submission for %s', selectedPermission => {
    expect(getLocalServiceDeploymentPermissionSubmitAction(
      liveCodeDeployment,
      selectedPermission,
    )).toBe(LocalServiceDeploymentPermissionSubmitAction.UpdatePermission);
  });

  test('requires redeployment to restore a stopped node service', () => {
    expect(getLocalServiceDeploymentPermissionSubmitAction(
      {
        ...liveCodeDeployment,
        shareStatus: HtmlShareStatus.Disabled,
        status: ShareDeploymentStatus.Stopped,
      },
      LocalServiceDeploymentPermission.Public,
    )).toBe(LocalServiceDeploymentPermissionSubmitAction.RedeployAndEnable);
  });

  test('updates permission directly to restore a stopped static site', () => {
    expect(getLocalServiceDeploymentPermissionSubmitAction(
      {
        ...liveCodeDeployment,
        deploymentKind: ShareDeploymentKind.StaticSite,
        shareStatus: HtmlShareStatus.Disabled,
        status: ShareDeploymentStatus.Stopped,
      },
      LocalServiceDeploymentPermission.Public,
    )).toBe(LocalServiceDeploymentPermissionSubmitAction.UpdatePermission);
  });

  test('blocks a service stopped by an administrator', () => {
    expect(getLocalServiceDeploymentPermissionSubmitAction(
      {
        ...liveCodeDeployment,
        disabledSource: HtmlShareDisabledSource.Admin,
        shareStatus: HtmlShareStatus.Disabled,
        status: ShareDeploymentStatus.Stopped,
      },
      LocalServiceDeploymentPermission.Public,
    )).toBe(LocalServiceDeploymentPermissionSubmitAction.Blocked);
  });
});

describe('mergeLocalServiceDeploymentShareUpdate', () => {
  const deployment = {
    deploymentId: 'deployment-1',
    shareId: 'share-1',
    status: ShareDeploymentStatus.Live,
    shareStatus: HtmlShareStatus.Live,
    accessMode: HtmlShareAccessMode.Code,
    shareCode: 'ABCD',
    url: 'https://share.example/service',
  };

  test('removes the share code when public access is confirmed', () => {
    expect(
      mergeLocalServiceDeploymentShareUpdate(
        deployment,
        { accessMode: HtmlShareAccessMode.Public },
        HtmlShareAccessMode.Public,
        HtmlShareStatus.Live,
      ),
    ).toMatchObject({
      accessMode: HtmlShareAccessMode.Public,
      shareCode: undefined,
      shareStatus: HtmlShareStatus.Live,
      status: ShareDeploymentStatus.Live,
    });
  });

  test('maps disabled and restored share status to the deployment status', () => {
    const stopped = mergeLocalServiceDeploymentShareUpdate(
      deployment,
      { status: HtmlShareStatus.Disabled },
      HtmlShareAccessMode.Code,
      HtmlShareStatus.Disabled,
    );
    expect(stopped).toMatchObject({
      shareStatus: HtmlShareStatus.Disabled,
      status: ShareDeploymentStatus.Stopped,
    });

    expect(
      mergeLocalServiceDeploymentShareUpdate(
        stopped,
        { status: HtmlShareStatus.Live },
        HtmlShareAccessMode.Code,
        HtmlShareStatus.Live,
      ),
    ).toMatchObject({
      shareStatus: HtmlShareStatus.Live,
      status: ShareDeploymentStatus.Live,
    });
  });
});

describe('isLocalServiceDeploymentStopped', () => {
  test.each([
    [HtmlShareStatus.Disabled, ShareDeploymentStatus.Live],
    [undefined, ShareDeploymentStatus.Stopped],
    [HtmlShareStatus.Disabled, undefined],
  ])('detects a stopped service from share status %s or deployment status %s', (
    shareStatus,
    deploymentStatus,
  ) => {
    expect(isLocalServiceDeploymentStopped(shareStatus, deploymentStatus)).toBe(true);
  });

  test('does not mark a live service as stopped', () => {
    expect(
      isLocalServiceDeploymentStopped(HtmlShareStatus.Live, ShareDeploymentStatus.Live),
    ).toBe(false);
  });
});

describe('canCopyLocalServiceDeploymentLink', () => {
  test.each([
    ShareDeploymentStatus.Queued,
    ShareDeploymentStatus.Deploying,
    ShareDeploymentStatus.DeployFailed,
    ShareDeploymentStatus.Expired,
  ])('hides the link while deployment status is %s', status => {
    expect(
      canCopyLocalServiceDeploymentLink({
        status,
        url: 'https://share.example/service',
      }),
    ).toBe(false);
  });

  test.each([
    ShareDeploymentStatus.Live,
    ShareDeploymentStatus.Stopped,
  ])('shows the link after a deployment reaches %s', status => {
    expect(
      canCopyLocalServiceDeploymentLink({
        status,
        url: 'https://share.example/service',
      }),
    ).toBe(true);
  });

  test('hides the link until the operation and URL are ready', () => {
    expect(
      canCopyLocalServiceDeploymentLink({
        status: ShareDeploymentStatus.Live,
        url: 'https://share.example/service',
      }, true),
    ).toBe(false);
    expect(
      canCopyLocalServiceDeploymentLink({
        status: ShareDeploymentStatus.Live,
      }),
    ).toBe(false);
  });
});

describe('getLocalServiceDeploymentProjectName', () => {
  test.each([
    ['/Users/admin/projects/lobster-app', 'lobster-app'],
    ['/Users/admin/projects/lobster-app///', 'lobster-app'],
    ['C:\\Users\\admin\\projects\\lobster-app', 'lobster-app'],
    ['C:\\Users\\admin\\projects\\lobster-app\\', 'lobster-app'],
    ['relative\\nested/project', 'project'],
    ['standalone-project', 'standalone-project'],
  ])('gets the project name from %s', (directory, expected) => {
    expect(getLocalServiceDeploymentProjectName(directory, 'fallback')).toBe(expected);
  });

  test.each([undefined, null, '', '   ', '/', 'C:\\'])(
    'uses the fallback for an empty or root directory (%s)',
    directory => {
      expect(getLocalServiceDeploymentProjectName(directory, 'fallback')).toBe('fallback');
    },
  );
});

describe('hasConfiguredLocalServiceCloudData', () => {
  test('returns true only for enabled persistence with bindings', () => {
    expect(hasConfiguredLocalServiceCloudData(configuredPersistence)).toBe(true);
  });

  test.each([
    undefined,
    null,
    { ...configuredPersistence, enabled: false },
    { ...configuredPersistence, bindings: [] },
  ])('returns false when cloud data is not configured', persistence => {
    expect(hasConfiguredLocalServiceCloudData(persistence)).toBe(false);
  });
});
