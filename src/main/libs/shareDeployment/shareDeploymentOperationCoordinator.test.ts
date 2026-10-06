import { describe, expect, test } from 'vitest';

import {
  HtmlShareAccessMode,
  HtmlShareStatus,
} from '../../../shared/htmlShare/constants';
import {
  ShareDeploymentStatus,
} from '../../../shared/shareDeployment/constants';
import {
  reconcileShareDeploymentAccess,
  ShareDeploymentAccessSyncOperation,
  ShareDeploymentOperationCoordinator,
} from './shareDeploymentOperationCoordinator';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>(resolver => {
    resolve = resolver;
  });
  return { promise, resolve };
}

describe('ShareDeploymentOperationCoordinator', () => {
  test('serializes operations with the same source key', async () => {
    const coordinator = new ShareDeploymentOperationCoordinator();
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const events: string[] = [];

    const first = coordinator.run('same-source', async () => {
      events.push('first:start');
      firstStarted.resolve();
      await releaseFirst.promise;
      events.push('first:end');
    });
    await firstStarted.promise;

    const second = coordinator.run('same-source', async () => {
      events.push('second:start');
      events.push('second:end');
    });
    await Promise.resolve();
    expect(events).toEqual(['first:start']);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'second:end',
    ]);
  });

  test('allows different source keys to run concurrently', async () => {
    const coordinator = new ShareDeploymentOperationCoordinator();
    const firstStarted = deferred();
    const secondStarted = deferred();
    const release = deferred();

    const first = coordinator.run('first-source', async () => {
      firstStarted.resolve();
      await release.promise;
    });
    const second = coordinator.run('second-source', async () => {
      secondStarted.resolve();
      await release.promise;
    });

    await Promise.all([firstStarted.promise, secondStarted.promise]);
    release.resolve();
    await Promise.all([first, second]);
  });

  test('continues the queue after a failed operation', async () => {
    const coordinator = new ShareDeploymentOperationCoordinator();
    const first = coordinator.run('same-source', async () => {
      throw new Error('first failed');
    });
    const second = coordinator.run('same-source', async () => 'second completed');

    await expect(first).rejects.toThrow('first failed');
    await expect(second).resolves.toBe('second completed');
  });
});

describe('reconcileShareDeploymentAccess', () => {
  test('keeps the deployment result when access synchronization fails', async () => {
    const deployment = {
      deploymentId: 'dep-1',
      shareId: 'share-1',
      status: ShareDeploymentStatus.Live,
      shareStatus: HtmlShareStatus.Live,
      accessMode: HtmlShareAccessMode.Public,
    };

    const result = await reconcileShareDeploymentAccess(
      deployment,
      {
        accessMode: HtmlShareAccessMode.Public,
        previousAccessMode: HtmlShareAccessMode.Code,
        targetShareStatus: HtmlShareStatus.Live,
      },
      {
        updateAccessMode: async () => ({
          success: false,
          error: 'access update failed',
        }),
        updateStatus: async () => {
          throw new Error('status update should be skipped');
        },
      },
    );

    expect(result.deployment).toEqual(deployment);
    expect(result.failures).toEqual([{
      operation: ShareDeploymentAccessSyncOperation.AccessMode,
      error: 'access update failed',
    }]);
  });

  test('skips access synchronization when the uploaded and previous modes match the target', async () => {
    let accessUpdateCount = 0;
    const result = await reconcileShareDeploymentAccess(
      {
        deploymentId: 'dep-1',
        shareId: 'share-1',
        status: ShareDeploymentStatus.Live,
        shareStatus: HtmlShareStatus.Live,
        accessMode: HtmlShareAccessMode.Code,
      },
      {
        accessMode: HtmlShareAccessMode.Code,
        previousAccessMode: HtmlShareAccessMode.Code,
        targetShareStatus: HtmlShareStatus.Live,
      },
      {
        updateAccessMode: async () => {
          accessUpdateCount += 1;
          return { success: true };
        },
        updateStatus: async () => ({ success: true }),
      },
    );

    expect(accessUpdateCount).toBe(0);
    expect(result.failures).toEqual([]);
  });
});
