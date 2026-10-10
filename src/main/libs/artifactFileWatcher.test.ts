import { EventEmitter } from 'node:events';
import { type FSWatcher, type WatchEventType } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ArtifactFileWatcher, CHANGE_SETTLE_MS, type FileIdentity, MISSING_FILE_POLL_MS } from './artifactFileWatcher';

const missing = () => Object.assign(new Error('no such file'), { code: 'ENOENT' });

interface FakeFile {
  ino: bigint;
}

class FakeWatcher extends EventEmitter {
  closed = false;

  constructor(readonly file: FakeFile, readonly listener: (eventType: WatchEventType) => void) {
    super();
  }

  close(): void {
    this.closed = true;
  }
}

/** Watchers follow a file, not its path, as kqueue and inotify do. */
class FakeDisk {
  private nextIno = 1n;
  readonly files = new Map<string, FakeFile>();
  readonly watchers: FakeWatcher[] = [];

  create(filePath: string, ino = this.nextIno++): void {
    this.files.set(filePath, { ino });
  }

  /** An in-place write; macOS calls a same-length one a rename. */
  write(filePath: string, eventType: WatchEventType = 'change'): void {
    this.emit(this.files.get(filePath)!, eventType);
  }

  /** A temporary file renamed over the path. */
  replace(filePath: string, ino?: bigint): void {
    const old = this.files.get(filePath)!;
    this.create(filePath, ino);
    this.emit(old, 'rename');
  }

  remove(filePath: string): void {
    const old = this.files.get(filePath)!;
    this.files.delete(filePath);
    this.emit(old, 'rename');
  }

  active(filePath?: string): FakeWatcher[] {
    const file = filePath === undefined ? undefined : this.files.get(filePath);
    return this.watchers.filter(watcher => !watcher.closed && (!filePath || watcher.file === file));
  }

  watchFile = (filePath: string, listener: (eventType: WatchEventType) => void): FSWatcher => {
    const file = this.files.get(filePath);
    if (!file) throw missing();
    const watcher = new FakeWatcher(file, listener);
    this.watchers.push(watcher);
    return watcher as unknown as FSWatcher;
  };

  identify = async (filePath: string): Promise<FileIdentity> => {
    const file = this.files.get(filePath);
    if (!file) throw missing();
    return { dev: 1n, ino: file.ino };
  };

  private emit(file: FakeFile, eventType: WatchEventType): void {
    for (const watcher of this.watchers) if (!watcher.closed && watcher.file === file) watcher.listener(eventType);
  }
}

describe('ArtifactFileWatcher', () => {
  const page = '/work/page.html';
  let disk: FakeDisk;
  let reports: Array<[string, string[]]>;
  let watcher: ArtifactFileWatcher<string>;
  const elapse = (ms: number) => vi.advanceTimersByTimeAsync(ms);

  beforeEach(() => {
    vi.useFakeTimers();
    disk = new FakeDisk();
    reports = [];
    watcher = new ArtifactFileWatcher<string>({
      onChange: (filePath, owners) => { reports.push([filePath, owners]); },
      watchFile: (filePath, listener) => disk.watchFile(filePath, listener),
      identify: filePath => disk.identify(filePath),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('reports an in-place edit that fs.watch calls a rename, once per burst of events', async () => {
    disk.create(page);
    watcher.watch(page, 'panel');
    await elapse(0);
    expect(disk.active(page)).toHaveLength(1);

    // The agent's same-length edit: macOS reports only 'rename', and the inode stays.
    disk.write(page, 'rename');
    await elapse(CHANGE_SETTLE_MS - 1);
    expect(reports).toEqual([]);
    await elapse(1);
    expect(reports).toEqual([[page, ['panel']]]);
    expect(disk.active(page)).toHaveLength(1);

    disk.write(page, 'change');
    await elapse(CHANGE_SETTLE_MS / 2);
    disk.write(page, 'rename');
    await elapse(CHANGE_SETTLE_MS / 2);
    disk.write(page, 'change');
    await elapse(CHANGE_SETTLE_MS);
    expect(reports).toHaveLength(2);
  });

  test('moves to the new file after an atomic replacement', async () => {
    disk.create(page);
    watcher.watch(page, 'panel');
    await elapse(0);
    const [first] = disk.active(page);

    disk.replace(page);
    await elapse(CHANGE_SETTLE_MS);
    expect(reports).toHaveLength(1);
    expect(first.closed).toBe(true);
    expect(disk.active(page)).toHaveLength(1);

    // Only a watcher on the new file sees later writes.
    disk.write(page);
    await elapse(CHANGE_SETTLE_MS);
    expect(reports).toHaveLength(2);
  });

  test('re-arms after a rename even when the recreated file reuses the inode number', async () => {
    disk.create(page, 7n);
    watcher.watch(page, 'panel');
    await elapse(0);

    disk.remove(page);
    disk.create(page, 7n);
    await elapse(CHANGE_SETTLE_MS);
    expect(reports).toHaveLength(1);

    disk.write(page);
    await elapse(CHANGE_SETTLE_MS);
    expect(reports).toHaveLength(2);
  });

  test('ignores a deleted file and reports it once it comes back', async () => {
    disk.create(page);
    watcher.watch(page, 'panel');
    await elapse(0);

    disk.remove(page);
    await elapse(CHANGE_SETTLE_MS + MISSING_FILE_POLL_MS * 3);
    expect(reports).toEqual([]);
    expect(disk.active()).toEqual([]);

    disk.create(page);
    await elapse(MISSING_FILE_POLL_MS);
    expect(reports).toEqual([[page, ['panel']]]);

    disk.write(page);
    await elapse(CHANGE_SETTLE_MS);
    expect(reports).toHaveLength(2);
  });

  test('starts watching a file that appears after it was requested', async () => {
    watcher.watch(page, 'panel');
    await elapse(MISSING_FILE_POLL_MS);
    expect(disk.active()).toEqual([]);

    disk.create(page);
    await elapse(MISSING_FILE_POLL_MS);
    expect(reports).toHaveLength(1);
    expect(disk.active(page)).toHaveLength(1);
  });

  test('keeps a shared file watched until its last subscription is gone', async () => {
    disk.create(page);
    watcher.watch(page, 'panel');
    watcher.watch(page, 'panel');
    watcher.watch(page, 'browser');
    await elapse(0);
    expect(disk.active(page)).toHaveLength(1);

    watcher.unwatch(page, 'browser');
    watcher.unwatch(page, 'panel');
    disk.write(page);
    await elapse(CHANGE_SETTLE_MS);
    expect(reports).toEqual([[page, ['panel']]]);

    watcher.unwatch(page, 'panel');
    expect(disk.active()).toEqual([]);
    disk.write(page);
    await elapse(CHANGE_SETTLE_MS + MISSING_FILE_POLL_MS);
    expect(reports).toHaveLength(1);
  });

  test('releases every subscription of an owner that reloaded', async () => {
    const chart = '/work/chart.svg';
    disk.create(page);
    disk.create(chart);
    watcher.watch(page, 'window');
    watcher.watch(page, 'window');
    watcher.watch(chart, 'window');
    watcher.watch(chart, 'other');
    await elapse(0);

    watcher.releaseOwner('window');
    expect(disk.active(page)).toEqual([]);
    disk.write(page);
    disk.write(chart);
    await elapse(CHANGE_SETTLE_MS);
    expect(reports).toEqual([[chart, ['other']]]);
  });

  test('drops a check that finishes after the last subscription is gone', async () => {
    disk.create(page);
    watcher.watch(page, 'panel');
    await elapse(0);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(disk, 'identify').mockImplementationOnce(async filePath => {
      await gate;
      return { dev: 1n, ino: disk.files.get(filePath)!.ino + 100n };
    });

    disk.write(page);
    await elapse(CHANGE_SETTLE_MS);
    watcher.unwatch(page, 'panel');
    release();
    await elapse(MISSING_FILE_POLL_MS);
    expect(reports).toEqual([]);
    expect(disk.active()).toEqual([]);
  });

  test('stops quietly when a file cannot be watched or its watcher fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    disk.create(page);
    watcher.watch(page, 'panel');
    await elapse(0);
    disk.active(page)[0].emit('error', new Error('watch failed'));
    expect(disk.active()).toEqual([]);
    disk.write(page);
    await elapse(CHANGE_SETTLE_MS + MISSING_FILE_POLL_MS);
    expect(reports).toEqual([]);

    const locked = '/work/locked.html';
    disk.create(locked);
    const watchFile = vi.spyOn(disk, 'watchFile').mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });
    watcher.watch(locked, 'panel');
    await elapse(MISSING_FILE_POLL_MS * 3);
    expect(watchFile).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('ArtifactFileWatcher on the real file system', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
  });

  /** Rewrites a file in place the way OpenClaw's host edit does: no truncation, same inode. */
  async function editInPlace(filePath: string, content: string): Promise<void> {
    const handle = await fs.open(filePath, 'r+');
    try {
      await handle.write(content, 0);
    } finally {
      await handle.close();
    }
  }

  test('follows in-place edits, atomic replacements and a deleted file coming back', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lobster-artifact-watch-'));
    roots.push(root);
    const filePath = path.join(root, 'page.html');
    await fs.writeFile(filePath, '<p>Version 1</p>');
    const reports: string[] = [];
    const watcher = new ArtifactFileWatcher<number>({
      onChange: changedPath => { reports.push(changedPath); },
      settleMs: 50,
      missingPollMs: 50,
    });
    const expectReports = (count: number) => vi.waitFor(() => { expect(reports).toHaveLength(count); }, { timeout: 5000 });
    watcher.watch(filePath, 1);
    await new Promise(resolve => setTimeout(resolve, 100));

    await editInPlace(filePath, '<p>Version 2</p>');
    await expectReports(1);

    const temporary = path.join(root, '.page.html.tmp');
    await fs.writeFile(temporary, '<p>Version 3</p>');
    await fs.rename(temporary, filePath);
    await expectReports(2);

    await editInPlace(filePath, '<p>Version 4</p>');
    await expectReports(3);

    await fs.unlink(filePath);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(reports).toHaveLength(3);

    await fs.writeFile(filePath, '<p>Version 5</p>');
    await expectReports(4);
    expect(reports.every(changedPath => changedPath === filePath)).toBe(true);
    watcher.unwatch(filePath, 1);
  });
});
