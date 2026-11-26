import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { RemoteOwner } from '../../shared/remote/constants';
import { LibraryFileAccessPolicy } from './libraryFileAccess';

describe('library file access across account boundaries', () => {
  let directory: string;
  let mine: string;
  let other: string;
  let sibling: string;
  let owner: RemoteOwner | null;
  let epoch: string;
  let visible: boolean;
  let policy: LibraryFileAccessPolicy;

  beforeEach(() => {
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'library-access-')));
    mine = path.join(directory, 'mine.html');
    other = path.join(directory, 'other.txt');
    sibling = path.join(directory, 'style.css');
    for (const file of [mine, other, sibling]) fs.writeFileSync(file, 'private contents');
    owner = { userId: 'A', scopeKey: 'personal' };
    epoch = 'boot:1';
    visible = true;
    const canRead = () => visible && owner?.userId === 'A' && owner.scopeKey === 'personal';
    policy = new LibraryFileAccessPolicy({
      resolvePath: vi.fn(itemId => itemId === 'mine' && canRead() ? mine : null),
      getFileAccess: vi.fn(filePath => ({
        tracked: filePath === mine || filePath === other,
        visible: filePath === mine && canRead(),
      })),
    }, () => owner, () => epoch);
  });

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  test('authorizes a visible item and rechecks ownership when its context is used', () => {
    const result = policy.authorize('mine');
    expect(result).toEqual({ filePath: mine, access: { itemId: 'mine', accountEpoch: epoch } });
    expect(() => policy.capture(mine, result.access)).not.toThrow();
    owner = { userId: 'B', scopeKey: 'personal' };
    expect(() => policy.capture(mine, result.access)).toThrow();
    expect(() => policy.authorize('mine')).toThrow();
    expect(() => policy.authorize('missing')).toThrow();
  });

  test('rejects hidden indexed files even when callers omit or forge the item context', () => {
    expect(() => policy.capture(other)).toThrow();
    expect(() => policy.capture(other, policy.authorize('mine').access)).toThrow();
    expect(() => policy.capture(mine, { itemId: 'other', accountEpoch: epoch })).toThrow();
    expect(() => policy.capture(mine, { itemId: 'mine', accountEpoch: 'old' })).toThrow();
    expect(() => policy.capture(mine, null as never)).toThrow();
  });

  test('discards a completed asynchronous read after logout and after switching back to A', async () => {
    const access = policy.authorize('mine').access;
    const lease = policy.capture(mine, access);
    const pendingRead = fs.promises.readFile(mine);
    owner = null;
    epoch = 'boot:2';
    await pendingRead;
    expect(() => lease.assertAllowed()).toThrow();
    owner = { userId: 'A', scopeKey: 'personal' };
    epoch = 'boot:3';
    expect(() => lease.assertAllowed()).toThrow();
    expect(() => policy.capture(mine, access)).toThrow();
    expect(() => policy.capture(mine, policy.authorize('mine').access)).not.toThrow();
  });

  test('also revokes unscoped in-flight reads on account or space changes', () => {
    const lease = policy.capture(mine);
    owner = { userId: 'A', scopeKey: 'team:1' };
    expect(() => lease.assertAllowed()).toThrow();
  });

  test('rechecks task visibility without an account switch or reindex', () => {
    const lease = policy.capture(mine, policy.authorize('mine').access);
    visible = false;
    expect(() => lease.assertAllowed()).toThrow();
    expect(() => policy.capture(mine)).toThrow();
  });

  test('allows ordinary files and preview assets but rejects hidden sibling artifacts', () => {
    expect(() => policy.capture(sibling)).not.toThrow();
    const lease = policy.capture(mine, policy.authorize('mine').access);
    expect(() => lease.assertAllowed(sibling)).not.toThrow();
    expect(() => lease.assertAllowed(other)).toThrow();
    owner = null;
    expect(() => policy.capture(sibling)).not.toThrow();
  });

  test('checks canonical paths so a symlink cannot expose a hidden indexed file', () => {
    const link = path.join(directory, 'alias.txt');
    fs.symlinkSync(other, link);
    expect(() => policy.capture(link)).toThrow();
    const lease = policy.capture(mine, policy.authorize('mine').access);
    expect(() => lease.assertAllowed(link)).toThrow();
  });

  test('scoped previews cannot traverse or symlink outside the entry directory', () => {
    const nested = path.join(directory, 'nested');
    fs.mkdirSync(nested);
    const originalMine = mine;
    mine = path.join(nested, 'index.html');
    fs.writeFileSync(mine, 'entry');
    const lease = policy.capture(mine, policy.authorize('mine').access);
    const link = path.join(nested, 'outside.css');
    fs.symlinkSync(sibling, link);
    expect(() => lease.assertAllowed(link)).toThrow();
    expect(() => lease.assertAllowed(originalMine)).toThrow();
  });
});
