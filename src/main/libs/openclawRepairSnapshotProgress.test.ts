import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import {
  OpenClawRepairPhase, type OpenClawRepairProgress, OpenClawRepairProgressStage,
} from '../../shared/openclawEngine/repair';
import {
  copySnapshotFile, measureSnapshotSource, SNAPSHOT_CHUNKED_COPY_MIN_BYTES, SNAPSHOT_PROGRESS_INTERVAL_MS, SnapshotProgress,
} from './openclawRepairSnapshotProgress';

const roots: string[] = [];
function tempRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-snapshot-progress-')));
  roots.push(root);
  return root;
}
function write(root: string, relative: string, content: string | Buffer): string {
  const file = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('progress is reported once per interval while counts move, and a stalled copy stays silent', async () => {
  vi.useFakeTimers();
  const reports: OpenClawRepairProgress[] = [];
  const progress = new SnapshotProgress(OpenClawRepairPhase.Snapshot, value => reports.push(value));
  progress.start();
  progress.add(3, 300);
  progress.add(1, 100);
  await vi.advanceTimersByTimeAsync(SNAPSHOT_PROGRESS_INTERVAL_MS);
  expect(reports).toEqual([{ phase: OpenClawRepairPhase.Snapshot, stage: OpenClawRepairProgressStage.Scan, files: 4, bytes: 400 }]);
  // One I/O call that never returns: the counts do not move, so the app's idle limit can end it.
  await vi.advanceTimersByTimeAsync(SNAPSHOT_PROGRESS_INTERVAL_MS * 60);
  expect(reports).toHaveLength(1);

  // The measured totals are reported at once so the app can size its wait.
  progress.plan({ files: 4, bytes: 400 });
  expect(reports[1]).toEqual({
    phase: OpenClawRepairPhase.Snapshot, stage: OpenClawRepairProgressStage.Copy, files: 0, bytes: 0, totalFiles: 4, totalBytes: 400,
  });
  progress.add(0, 250);
  await vi.advanceTimersByTimeAsync(SNAPSHOT_PROGRESS_INTERVAL_MS);
  expect(reports[2]).toMatchObject({ files: 0, bytes: 250, totalBytes: 400 });

  progress.add(4, 150);
  progress.stop();
  expect(vi.getTimerCount()).toBe(0);
  progress.flush();
  progress.flush();
  expect(reports.slice(3)).toEqual([expect.objectContaining({ files: 4, bytes: 400 })]);
});

test('without a reporter no timer is started', () => {
  vi.useFakeTimers();
  const progress = new SnapshotProgress(OpenClawRepairPhase.Snapshot);
  progress.start();
  progress.add(1, 1);
  progress.flush();
  expect(vi.getTimerCount()).toBe(0);
});

test('the measure pass counts what the snapshot copies, without following links or entering skipped paths', async () => {
  const root = tempRoot();
  const stateDir = path.join(root, 'state');
  write(stateDir, 'openclaw.json', '{}');
  write(stateDir, 'agents/main/agent/openclaw-agent.sqlite', Buffer.alloc(4096));
  write(stateDir, 'agents/main/sessions/sessions.json', '{"a":1}');
  write(stateDir, 'agents/main/session-sqlite-import-archive/main.history.jsonl.imported-1', Buffer.alloc(9000));
  write(stateDir, 'session-sqlite-import-archive/root.history.jsonl.imported-1', Buffer.alloc(9000));
  write(stateDir, '.compile-cache/v8/data', Buffer.alloc(9000));
  write(root, 'outside/large.bin', Buffer.alloc(9000));
  fs.symlinkSync(path.join(root, 'outside'), path.join(stateDir, 'linked-outside'), 'junction');

  const reports: OpenClawRepairProgress[] = [];
  const progress = new SnapshotProgress(OpenClawRepairPhase.Snapshot, value => reports.push(value));
  const totals = await measureSnapshotSource(stateDir, progress);
  expect(totals).toEqual({ files: 4, bytes: 2 + 4096 + 7 });
  progress.flush();
  expect(reports).toEqual([expect.objectContaining({ stage: OpenClawRepairProgressStage.Scan, files: 4, bytes: totals.bytes })]);
});

test('a large file is copied in chunks that report their bytes, and an existing target is refused', async () => {
  const root = tempRoot();
  const size = SNAPSHOT_CHUNKED_COPY_MIN_BYTES + 12_345;
  const content = Buffer.alloc(size);
  for (let offset = 0; offset < size; offset += 4096) content.writeUInt32LE(offset, offset);
  const source = write(root, 'source.sqlite-wal', content);
  const target = path.join(root, 'target');
  const reported: number[] = [];

  await copySnapshotFile(source, target, size, bytes => reported.push(bytes));
  expect(reported.length).toBeGreaterThan(1);
  expect(reported.reduce((sum, bytes) => sum + bytes, 0)).toBe(size);
  expect(fs.readFileSync(target).equals(content)).toBe(true);
  if (process.platform !== 'win32') expect(fs.statSync(target).mode & 0o777).toBe(0o600);

  fs.writeFileSync(target, 'existing');
  await expect(copySnapshotFile(source, target, size, () => {})).rejects.toMatchObject({ code: 'EEXIST' });
  expect(fs.readFileSync(target, 'utf8')).toBe('existing');
});

test('a small file is copied at once and reports its size', async () => {
  const root = tempRoot();
  const source = write(root, 'small.json', '{"keep":true}');
  const reported: number[] = [];
  await copySnapshotFile(source, path.join(root, 'copy.json'), 13, bytes => reported.push(bytes));
  expect(reported).toEqual([13]);
  expect(fs.readFileSync(path.join(root, 'copy.json'), 'utf8')).toBe('{"keep":true}');
  await expect(copySnapshotFile(source, path.join(root, 'copy.json'), 13, () => {})).rejects.toMatchObject({ code: 'EEXIST' });
});
