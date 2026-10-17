import path from 'node:path';

import { expect, test } from 'vitest';

import { isRegenerableSnapshotPath } from './openclawRepairSnapshotPaths';

test.each([
  ['.compile-cache', true],
  ['browser/openclaw/user-data/Default/Service Worker/CacheStorage', true],
  ['browser/openclaw/user-data/Default/Code Cache', true],
  ['browser/openclaw/user-data/ShaderCache', true],
  ['browser/openclaw/user-data/Default/Service Worker', false],
  ['browser/openclaw/user-data/Default/Service Worker/ScriptCache', false],
  ['browser/openclaw/user-data/Default/Cookies', false],
  ['browser/openclaw/user-data/Default/IndexedDB', false],
  ['browser/openclaw/user-data/Default/Extensions/abc/1.0/Cache', false],
  ['browser/openclaw/user-data', false],
  ['browser/openclaw/Cache', false],
  ['state/.compile-cache', false],
])('isRegenerableSnapshotPath(%s) = %s', (relative, expected) => {
  expect(isRegenerableSnapshotPath(path.join(...relative.split('/')))).toBe(expected);
});
