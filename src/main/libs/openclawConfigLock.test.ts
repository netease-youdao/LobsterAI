import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  cleanupStaleOpenClawConfigLock,
  CONFIG_LOCK_ORPHAN_GRACE_MS,
  ConfigLockCleanupAction,
  isConfigLockRemoval,
  resolveOpenClawConfigLockPath,
} from './openclawConfigLock';
import {
  expectOpenClawSourceContains,
  getOpenClawSourceDir,
  isOpenClawSourceAvailable,
} from './openclawPatches/patchTestUtils';

describe('cleanupStaleOpenClawConfigLock', () => {
  let stateDir: string;
  let configPath: string;
  let lockPath: string;
  let guardPath: string;

  beforeEach(() => {
    stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-config-lock-test-')));
    configPath = path.join(stateDir, 'openclaw.json');
    fs.writeFileSync(configPath, '{}\n');
    lockPath = `${configPath}.lock`;
    guardPath = `${lockPath}.reclaim`;
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const afterGrace = () => Date.now() + CONFIG_LOCK_ORPHAN_GRACE_MS + 1_000;
  const cleanup = (overrides: Partial<Parameters<typeof cleanupStaleOpenClawConfigLock>[0]> = {}) =>
    cleanupStaleOpenClawConfigLock({ configPath, isPidAliveFn: () => true, ...overrides });

  test('resolves the lock beside the realpath of the config directory, like fs-safe', () => {
    expect(resolveOpenClawConfigLockPath(configPath)).toBe(lockPath);
  });

  test('does nothing without a lock or reclaim guard', () => {
    expect(cleanup({ now: afterGrace })).toEqual([]);
  });

  test('removes an empty lock left by a writer killed before it wrote its payload', () => {
    fs.writeFileSync(lockPath, '');

    const results = cleanup({ now: afterGrace });

    expect(results).toEqual([expect.objectContaining({ path: lockPath, action: ConfigLockCleanupAction.RemovedUnreadable })]);
    expect(results.every(isConfigLockRemoval)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(guardPath)).toBe(false);
  });

  test('removes a lock whose payload has no usable owner once it is past the grace window', () => {
    fs.writeFileSync(lockPath, '{"pid": 12');

    expect(cleanup({ now: afterGrace })[0]?.action).toBe(ConfigLockCleanupAction.RemovedUnreadable);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test('keeps a young empty lock: its writer may still be about to publish the payload', () => {
    fs.writeFileSync(lockPath, '');

    const results = cleanup();

    expect(results).toEqual([expect.objectContaining({ action: ConfigLockCleanupAction.KeptRecent })]);
    expect(isConfigLockRemoval(results[0]!)).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  test('removes a lock whose recorded owner has exited', () => {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 4242, createdAt: new Date().toISOString() }));

    const results = cleanup({ isPidAliveFn: () => false });

    expect(results).toEqual([expect.objectContaining({ action: ConfigLockCleanupAction.RemovedDeadOwner, ownerPid: 4242 })]);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test('never touches a lock whose owner is alive, however old it is', () => {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 4242, createdAt: '2026-09-07T12:45:01.758Z' }));

    const results = cleanup({ now: afterGrace });

    expect(results).toEqual([expect.objectContaining({ action: ConfigLockCleanupAction.KeptAliveOwner, ownerPid: 4242 })]);
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  test('leaves the lock alone while another process holds a fresh reclaim guard', () => {
    fs.writeFileSync(lockPath, '');
    fs.mkdirSync(guardPath);
    const now = Date.now();
    // The lock is old, the guard was just taken by a live reclaimer.
    fs.utimesSync(lockPath, new Date(now - 10 * CONFIG_LOCK_ORPHAN_GRACE_MS), new Date(now - 10 * CONFIG_LOCK_ORPHAN_GRACE_MS));

    expect(cleanup({ now: () => now })).toEqual([]);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.existsSync(guardPath)).toBe(true);
  });

  test('adopts an orphaned reclaim guard to remove the lock, then releases it', () => {
    fs.writeFileSync(lockPath, '');
    fs.mkdirSync(guardPath);

    const results = cleanup({ now: afterGrace });

    expect(results).toEqual([expect.objectContaining({ action: ConfigLockCleanupAction.RemovedUnreadable })]);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(guardPath)).toBe(false);
  });

  test('removes an orphaned reclaim guard that blocks every acquirer even without a lock', () => {
    fs.mkdirSync(guardPath);

    expect(cleanup()).toEqual([]);
    expect(cleanup({ now: afterGrace })).toEqual([
      expect.objectContaining({ path: guardPath, action: ConfigLockCleanupAction.RemovedReclaimGuard }),
    ]);
    expect(fs.existsSync(guardPath)).toBe(false);
  });

  test('ignores a lock path that is not a regular file', () => {
    fs.mkdirSync(lockPath);

    expect(cleanup({ now: afterGrace })).toEqual([]);
    expect(fs.existsSync(lockPath)).toBe(true);
  });
});

describe('pinned OpenClaw config lock protocol', () => {
  test.skipIf(!isOpenClawSourceAvailable())('never reclaims a payload-less sidecar on its own', () => {
    // If an OpenClaw upgrade changes this, the host cleanup may become redundant.
    expectOpenClawSourceContains([
      {
        file: 'src/config/mutate.ts',
        snippets: ['async () => await withFileLock(configPath, CONFIG_MUTATION_LOCK_OPTIONS, fn)'],
      },
      {
        file: 'src/infra/stale-lock-file.ts',
        snippets: ['export function shouldRemoveDeadOwnerOrExpiredLock('],
      },
    ]);
    const source = fs.readFileSync(path.join(getOpenClawSourceDir(), 'src/infra/stale-lock-file.ts'), 'utf8');
    expect(source).toMatch(/if \(!payload\?\.createdAt\) \{\s*return false;\s*\}/);
  });
});
