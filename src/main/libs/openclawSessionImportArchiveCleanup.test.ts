import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test } from 'vitest';

import { DiskCleanupStoppedError,DiskCleanupStopReason } from './openclawDiskCleanupThrottle';
import { OPENCLAW_SESSION_IMPORT_ARCHIVE_MAX_AGE_MS, pruneExpiredOpenClawSessionImportArchives } from './openclawSessionImportArchiveCleanup';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function stateDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-import-archive-'));
  roots.push(root);
  return root;
}
function setAge(target: string, ageMs: number) {
  const time = new Date(NOW - ageMs);
  fs.utimesSync(target, time, time);
}
function archive(state: string, agentId: string | null, ageMs: number) {
  const dir = agentId
    ? path.join(state, 'agents', agentId, 'session-sqlite-import-archive')
    : path.join(state, 'session-sqlite-import-archive');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.jsonl.imported-1789112083676'), '{"role":"user"}\n');
  setAge(dir, ageMs);
  return dir;
}
function run(state: string, name: string, manifest: Record<string, unknown>) {
  const dir = path.join(state, 'session-sqlite-migration-runs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ manifestVersion: 2, targets: [{ issues: [] }], ...manifest }));
  return file;
}
const iso = (ageMs: number) => new Date(NOW - ageMs).toISOString();

test('removes every import archive once the last migration completed cleanly past the age limit', async () => {
  expect(OPENCLAW_SESSION_IMPORT_ARCHIVE_MAX_AGE_MS).toBe(14 * DAY_MS);
  const state = stateDir();
  const manifests = [
    run(state, 'session-sqlite-1', { startedAt: iso(40 * DAY_MS), completedAt: iso(40 * DAY_MS) }),
    run(state, 'session-sqlite-2', { startedAt: iso(20 * DAY_MS), completedAt: iso(20 * DAY_MS) }),
  ];
  const archives = [archive(state, 'main', 20 * DAY_MS), archive(state, 'worker', 30 * DAY_MS), archive(state, null, 20 * DAY_MS)];

  const removed = await pruneExpiredOpenClawSessionImportArchives(state, { now: NOW });

  expect([...removed].sort()).toEqual([...archives].sort());
  for (const dir of archives) expect(fs.existsSync(dir)).toBe(false);
  // Run manifests stay for OpenClaw's own pruning.
  for (const file of manifests) expect(fs.existsSync(file)).toBe(true);
});

test('keeps archives while the last clean migration is within the age limit', async () => {
  const state = stateDir();
  run(state, 'session-sqlite-1', { startedAt: iso(40 * DAY_MS), completedAt: iso(40 * DAY_MS) });
  run(state, 'session-sqlite-2', { startedAt: iso(10 * DAY_MS), completedAt: iso(10 * DAY_MS) });
  const dir = archive(state, 'main', 30 * DAY_MS);

  expect(await pruneExpiredOpenClawSessionImportArchives(state, { now: NOW })).toEqual([]);
  expect(fs.existsSync(dir)).toBe(true);
});

test.each([
  ['in flight', { startedAt: iso(20 * DAY_MS) }],
  ['failed', { startedAt: iso(20 * DAY_MS), failedAt: iso(20 * DAY_MS) }],
  ['completed with issues', { startedAt: iso(20 * DAY_MS), completedAt: iso(20 * DAY_MS), targets: [{ issues: [{ code: 'x' }] }] }],
  ['completed with failure reports', { startedAt: iso(20 * DAY_MS), completedAt: iso(20 * DAY_MS), failureReports: { jsonPath: 'a', markdownPath: 'b' } }],
])('keeps archives when the newest migration run is %s, since recover may need them', async (_label, manifest) => {
  const state = stateDir();
  run(state, 'session-sqlite-1', { startedAt: iso(40 * DAY_MS), completedAt: iso(40 * DAY_MS) });
  run(state, 'session-sqlite-2', manifest);
  const dir = archive(state, 'main', 30 * DAY_MS);

  expect(await pruneExpiredOpenClawSessionImportArchives(state, { now: NOW })).toEqual([]);
  expect(fs.existsSync(dir)).toBe(true);
});

test('keeps archives without migration records, with an unreadable record, or modified recently', async () => {
  const noRuns = stateDir();
  const orphan = archive(noRuns, 'main', 30 * DAY_MS);
  expect(await pruneExpiredOpenClawSessionImportArchives(noRuns, { now: NOW })).toEqual([]);
  expect(fs.existsSync(orphan)).toBe(true);

  const unreadable = stateDir();
  run(unreadable, 'session-sqlite-1', { startedAt: iso(40 * DAY_MS), completedAt: iso(40 * DAY_MS) });
  fs.writeFileSync(path.join(unreadable, 'session-sqlite-migration-runs', 'session-sqlite-2.json'), '{"startedAt":');
  const kept = archive(unreadable, 'main', 30 * DAY_MS);
  expect(await pruneExpiredOpenClawSessionImportArchives(unreadable, { now: NOW })).toEqual([]);
  expect(fs.existsSync(kept)).toBe(true);

  const recent = stateDir();
  run(recent, 'session-sqlite-1', { startedAt: iso(40 * DAY_MS), completedAt: iso(40 * DAY_MS) });
  const old = archive(recent, 'main', 30 * DAY_MS);
  const touched = archive(recent, 'worker', 2 * DAY_MS);
  expect(await pruneExpiredOpenClawSessionImportArchives(recent, { now: NOW })).toEqual([old]);
  expect(fs.existsSync(touched)).toBe(true);
});

test.skipIf(process.platform === 'win32')('never follows a symlinked archive', async () => {
  const state = stateDir();
  run(state, 'session-sqlite-1', { startedAt: iso(40 * DAY_MS), completedAt: iso(40 * DAY_MS) });
  const outside = stateDir();
  fs.writeFileSync(path.join(outside, 'keep.jsonl'), 'keep');
  fs.mkdirSync(path.join(state, 'agents', 'main'), { recursive: true });
  fs.symlinkSync(outside, path.join(state, 'agents', 'main', 'session-sqlite-import-archive'));

  expect(await pruneExpiredOpenClawSessionImportArchives(state, { now: NOW })).toEqual([]);
  expect(fs.readFileSync(path.join(outside, 'keep.jsonl'), 'utf8')).toBe('keep');
});

test('a removal stopped part-way is finished on the next prune, even though deleting bumped its mtime', async () => {
  const state = stateDir();
  run(state, 'session-sqlite-1', { startedAt: iso(40 * DAY_MS), completedAt: iso(40 * DAY_MS) });
  const dir = archive(state, 'main', 30 * DAY_MS);
  for (const name of ['a', 'b', 'c']) fs.writeFileSync(path.join(dir, `${name}.jsonl.imported-1`), name);
  setAge(dir, 30 * DAY_MS);
  let steps = 0;
  const stopping = {
    step: async () => {
      steps += 1;
      if (steps === 2) throw new DiskCleanupStoppedError(DiskCleanupStopReason.Budget);
    },
  };

  await expect(pruneExpiredOpenClawSessionImportArchives(state, { now: NOW, throttle: stopping }))
    .rejects.toBeInstanceOf(DiskCleanupStoppedError);
  const owner = path.dirname(dir);
  const leftovers = fs.readdirSync(owner).filter(name => name.startsWith('session-sqlite-import-archive'));
  expect(leftovers).toHaveLength(1);
  expect(leftovers[0]).toMatch(/^session-sqlite-import-archive\.lobsterai-stale-[0-9a-f]+$/);

  await pruneExpiredOpenClawSessionImportArchives(state, { now: NOW });
  expect(fs.readdirSync(owner).filter(name => name.startsWith('session-sqlite-import-archive'))).toEqual([]);
});
