import { describe, expect, test } from 'vitest';

import {
  type ShareDeploymentPersistenceBinding,
  ShareDeploymentPersistenceBindingKind,
} from './constants';
import { findShareDeploymentPersistencePathConflict } from './persistencePaths';

function binding(appPath: string, dataPath: string): ShareDeploymentPersistenceBinding {
  return {
    appPath,
    dataPath,
    kind: ShareDeploymentPersistenceBindingKind.Directory,
  };
}

describe('findShareDeploymentPersistencePathConflict', () => {
  test('detects duplicate, parent-child, case-insensitive, and cross-field conflicts', () => {
    expect(findShareDeploymentPersistencePathConflict([
      binding('data', 'cloud-a'),
      binding('./Data', 'cloud-b'),
    ])).toMatchObject({ firstField: 'appPath', secondField: 'appPath' });

    expect(findShareDeploymentPersistencePathConflict([
      binding('local-a', 'data'),
      binding('local-b', 'data/app.sqlite'),
    ])).toMatchObject({ firstField: 'dataPath', secondField: 'dataPath' });

    expect(findShareDeploymentPersistencePathConflict([
      binding('data', 'cloud-a'),
      binding('local-b', 'data/file.json'),
    ])).toMatchObject({ firstField: 'appPath', secondField: 'dataPath' });
  });

  test('allows equal paths within one binding and path-segment prefixes across bindings', () => {
    expect(findShareDeploymentPersistencePathConflict([
      binding('data', 'data'),
      binding('database/app.sqlite', 'database/app.sqlite'),
    ])).toBeNull();
  });
});
