import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, test } from 'vitest';

import {
  clearWriterLock,
  DSH_WRITER_LOCK_FILE,
  isBlockingWriterLock,
  isProcessAlive,
  parseDshWriterLock,
  readWriterLock,
  writeWriterLock,
} from './dshSharedHome';

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lock-'));
  tempDirs.push(dir);
  return dir;
}

describe('parseDshWriterLock', () => {
  test('accepts a well-formed lock', () => {
    expect(parseDshWriterLock(JSON.stringify({ pid: 42, port: 3080, startedAt: 'x' }))).toEqual({
      pid: 42,
      port: 3080,
      startedAt: 'x',
    });
  });

  test('rejects malformed pids and invalid JSON', () => {
    expect(parseDshWriterLock(JSON.stringify({ pid: 0 }))).toBeNull();
    expect(parseDshWriterLock(JSON.stringify({ pid: 1.5 }))).toBeNull();
    expect(parseDshWriterLock('{nope')).toBeNull();
  });
});

describe('isBlockingWriterLock', () => {
  const alive = () => true;
  const dead = () => false;

  test('a live foreign writer blocks sharing', () => {
    expect(isBlockingWriterLock({ pid: 999, port: 1, startedAt: '' }, 1, alive)).toBe(true);
  });

  test('our own lock never blocks us (restart in the same app)', () => {
    expect(isBlockingWriterLock({ pid: 1, port: 1, startedAt: '' }, 1, alive)).toBe(false);
  });

  // A hard kill leaves the file behind; it must not lock the store forever.
  test('a stale lock from a dead process does not block', () => {
    expect(isBlockingWriterLock({ pid: 999, port: 1, startedAt: '' }, 1, dead)).toBe(false);
  });

  test('no lock does not block', () => {
    expect(isBlockingWriterLock(null, 1, alive)).toBe(false);
  });
});

describe('writer lock file round-trip', () => {
  test('writes, reads back, and clears our own lock', () => {
    const home = makeHome();
    writeWriterLock(home, 31234);
    const lock = readWriterLock(home);
    expect(lock).toMatchObject({ pid: process.pid, port: 31234 });
    expect(isBlockingWriterLock(lock, process.pid, isProcessAlive)).toBe(false);

    clearWriterLock(home);
    expect(readWriterLock(home)).toBeNull();
  });

  test('refuses to clear a lock held by another live process', () => {
    const home = makeHome();
    // process.ppid is alive and is not us.
    fs.writeFileSync(
      path.join(home, DSH_WRITER_LOCK_FILE),
      JSON.stringify({ pid: process.ppid, port: 1, startedAt: '' })
    );
    clearWriterLock(home);
    expect(readWriterLock(home)?.pid).toBe(process.ppid);
  });

  test('clears a lock whose owner is gone', () => {
    const home = makeHome();
    // PID 2^22 is above the default max pid on macOS/Linux, so it cannot exist.
    fs.writeFileSync(path.join(home, DSH_WRITER_LOCK_FILE), JSON.stringify({ pid: 4194304, port: 1, startedAt: '' }));
    clearWriterLock(home);
    expect(readWriterLock(home)).toBeNull();
  });

  test('missing home reads as no lock', () => {
    expect(readWriterLock(path.join(os.tmpdir(), 'definitely-not-here-xyz'))).toBeNull();
  });
});

describe('isProcessAlive', () => {
  test('recognizes this process and rejects an impossible pid', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(4194304)).toBe(false);
  });
});
