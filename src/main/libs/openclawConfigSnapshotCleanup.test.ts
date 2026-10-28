import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test } from 'vitest';

import {
  OPENCLAW_CONFIG_SNAPSHOT_KEEP_COUNT, OPENCLAW_CONFIG_SNAPSHOT_MAX_AGE_MS, pruneOpenClawConfigSnapshots,
} from './openclawConfigSnapshotCleanup';
import { DiskCleanupStoppedError, DiskCleanupStopReason } from './openclawDiskCleanupThrottle';

const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function stateDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-config-snapshot-'));
  roots.push(root);
  return root;
}
/** OpenClaw's artifact timestamp for a snapshot taken `ageMs` before NOW. */
function stamp(ageMs: number) {
  return new Date(NOW - ageMs).toISOString().replace(/[:.]/g, '-');
}
function write(file: string, ageMs: number) {
  fs.writeFileSync(file, '{}');
  const time = new Date(NOW - ageMs);
  fs.utimesSync(file, time, time);
  return file;
}

test('per kind, keeps the newest snapshots and removes older ones past the age limit', async () => {
  const state = stateDir();
  const config = path.join(state, 'openclaw.json');
  const clobbered = (ageMs: number, suffix = '') => write(`${config}.clobbered.${stamp(ageMs)}${suffix}`, ageMs);
  const rejected = (ageMs: number) => write(`${config}.rejected.${stamp(ageMs)}`, ageMs);
  const removable = [
    clobbered(30 * DAY_MS),
    clobbered(20 * DAY_MS),
    clobbered(10 * DAY_MS),
    rejected(30 * DAY_MS),
  ];
  const kept = [
    // Newest three clobbered copies, old or not; a collision counter sorts after its base name.
    clobbered(10 * DAY_MS, '-01'),
    clobbered(8 * DAY_MS),
    clobbered(DAY_MS),
    // Past the newest three but still within the age limit.
    rejected(6 * DAY_MS),
    rejected(5 * DAY_MS),
    rejected(4 * DAY_MS),
    rejected(3 * DAY_MS),
    // Live config, OpenClaw's recovery sources, and files this cleanup does not own.
    write(config, 30 * DAY_MS),
    write(`${config}.bak`, 30 * DAY_MS),
    write(`${config}.bak.1`, 30 * DAY_MS),
    write(`${config}.last-good`, 30 * DAY_MS),
    write(`${config}.bak-${stamp(30 * DAY_MS)}`, 30 * DAY_MS),
    write(`${config}.pre-meta-fix-20261006-121937`, 30 * DAY_MS),
    write(`${config}.clobbered.not-a-timestamp`, 30 * DAY_MS),
    write(`${config}.rejected.${stamp(30 * DAY_MS)}-01`, 30 * DAY_MS),
    write(path.join(state, `other.json.clobbered.${stamp(30 * DAY_MS)}`), 30 * DAY_MS),
    write(path.join(state, 'openclaw-bak-20260624-174741.json'), 30 * DAY_MS),
  ];
  fs.mkdirSync(`${config}.clobber.lock`);
  // A link named like a snapshot is not a file this cleanup owns.
  const target = write(path.join(state, 'outside.json'), 30 * DAY_MS);
  fs.symlinkSync(target, `${config}.clobbered.${stamp(40 * DAY_MS)}`);

  const removed = await pruneOpenClawConfigSnapshots(config, { now: NOW });

  expect(OPENCLAW_CONFIG_SNAPSHOT_KEEP_COUNT).toBe(3);
  expect(OPENCLAW_CONFIG_SNAPSHOT_MAX_AGE_MS).toBe(7 * DAY_MS);
  expect([...removed].sort()).toEqual([...removable].sort());
  for (const file of removable) expect(fs.existsSync(file)).toBe(false);
  for (const file of kept) expect(fs.existsSync(file)).toBe(true);
  expect(fs.existsSync(`${config}.clobber.lock`)).toBe(true);
  expect(fs.existsSync(target)).toBe(true);
});

test('a missing config directory is a no-op', async () => {
  expect(await pruneOpenClawConfigSnapshots(path.join(stateDir(), 'missing', 'openclaw.json'), { now: NOW })).toEqual([]);
});

test('a stopped throttle ends the prune after the current removal', async () => {
  const config = path.join(stateDir(), 'openclaw.json');
  for (let day = 10; day < 16; day += 1) write(`${config}.clobbered.${stamp(day * DAY_MS)}`, day * DAY_MS);
  const stopping = { step: async () => { throw new DiskCleanupStoppedError(DiskCleanupStopReason.Budget); } };

  await expect(pruneOpenClawConfigSnapshots(config, { now: NOW, throttle: stopping }))
    .rejects.toBeInstanceOf(DiskCleanupStoppedError);
  expect(fs.readdirSync(path.dirname(config))).toHaveLength(5);
  // The next pass resumes where this one stopped.
  expect(await pruneOpenClawConfigSnapshots(config, { now: NOW })).toHaveLength(2);
});
