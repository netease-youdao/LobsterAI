import path from 'node:path';

import { expect, test } from 'vitest';

import { isRegenerableSnapshotPath, resolveSnapshotSkipReason, SnapshotSkipReason } from './openclawRepairSnapshotPaths';

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

test.each([
  ['.compile-cache', true, SnapshotSkipReason.Regenerable],
  ['session-sqlite-import-archive', true, SnapshotSkipReason.SessionImportArchive],
  ['agents/main/session-sqlite-import-archive', true, SnapshotSkipReason.SessionImportArchive],
  ['agents/7694a870-f8e8/session-sqlite-import-archive', true, SnapshotSkipReason.SessionImportArchive],
  // A link there is not an archive OpenClaw writes; the snapshot's link checks decide.
  ['agents/main/session-sqlite-import-archive', false, undefined],
  ['agents/main/sessions/session-sqlite-import-archive', true, undefined],
  ['agents/main/session-sqlite-import-archive/main.history.jsonl.imported-1', false, undefined],
  ['agents/main/session-sqlite-import-archive.lobsterai-stale-0a1b2c3d', true, undefined],
  ['state/session-sqlite-import-archive', true, undefined],
  ['agents/main/agent', true, undefined],
  ['agents/main/agent/openclaw-agent.sqlite', false, undefined],
  ['agents/main/sessions', true, undefined],
  ['session-sqlite-migration-runs', true, undefined],
])('resolveSnapshotSkipReason(%s, directory=%s) = %s', (relative, isDirectory, expected) => {
  expect(resolveSnapshotSkipReason(path.join(...relative.split('/')), isDirectory)).toBe(expected);
});
