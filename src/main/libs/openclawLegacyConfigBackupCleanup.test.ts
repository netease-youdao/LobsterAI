import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test } from 'vitest';

import { OPENCLAW_REPAIR_BACKUP_MAX_AGE_MS } from './openclawCompatibilityRepair';
import { pruneLegacyOpenClawConfigBackups } from './openclawLegacyConfigBackupCleanup';

const DAY_MS = 24 * 60 * 60 * 1000;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function stateDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-legacy-config-backup-'));
  roots.push(root);
  return root;
}
const pad = (value: number) => String(value).padStart(2, '0');
/** The local-time stamp gateway repair put in backup names before 2026.9.15. */
function repairStamp(time: number) {
  const date = new Date(time);
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
/** Writing sets the status change time to the real clock, whatever mtime is set to. */
function write(file: string, mtime: number) {
  fs.writeFileSync(file, '{}');
  fs.utimesSync(file, new Date(mtime), new Date(mtime));
  return file;
}

test('removes legacy repair backups whose repair time in the name is past the age limit', async () => {
  const state = stateDir();
  const config = path.join(state, 'openclaw.json');
  // A month ahead, so the real status change time of every file here is 30 days old.
  const now = Date.now() + 30 * DAY_MS;
  const longAgo = now - 90 * DAY_MS;
  const backup = (ageMs: number, suffix = '') => path.join(state, `openclaw-bak-${repairStamp(now - ageMs)}${suffix}.json`);
  const removable = [
    write(path.join(state, 'openclaw-bak.json'), longAgo),
    write(backup(20 * DAY_MS), longAgo),
    write(backup(15 * DAY_MS, '-2'), longAgo),
  ];
  const kept = [
    // A rename keeps the config's old mtime; the repair itself was recent.
    write(backup(13 * DAY_MS), longAgo),
    write(config, longAgo),
    write(`${config}.bak`, longAgo),
    write(path.join(state, 'openclaw-bak-notatime.json'), longAgo),
    write(`${backup(20 * DAY_MS)}.tmp`, longAgo),
    write(path.join(state, `other-bak-${repairStamp(now - 20 * DAY_MS)}.json`), longAgo),
  ];
  fs.mkdirSync(path.join(state, 'repair-backups'));
  const nested = write(path.join(state, 'repair-backups', 'openclaw-bak.json'), longAgo);
  // A link named like a backup is not a file this cleanup owns.
  const target = write(path.join(state, 'outside.json'), longAgo);
  fs.symlinkSync(target, backup(40 * DAY_MS));

  const removed = await pruneLegacyOpenClawConfigBackups(config, { now });

  expect(OPENCLAW_REPAIR_BACKUP_MAX_AGE_MS).toBe(14 * DAY_MS);
  expect([...removed].sort()).toEqual([...removable].sort());
  for (const file of removable) expect(fs.existsSync(file)).toBe(false);
  for (const file of [...kept, nested, target]) expect(fs.existsSync(file)).toBe(true);
});

test('the first backup, whose name has no time, is kept while its rename is recent', async () => {
  const state = stateDir();
  const now = Date.now();
  const first = write(path.join(state, 'openclaw-bak.json'), now - 90 * DAY_MS);

  expect(await pruneLegacyOpenClawConfigBackups(path.join(state, 'openclaw.json'), { now })).toEqual([]);
  expect(fs.existsSync(first)).toBe(true);
});

test('a missing config directory is a no-op', async () => {
  expect(await pruneLegacyOpenClawConfigBackups(path.join(stateDir(), 'missing', 'openclaw.json'))).toEqual([]);
});
