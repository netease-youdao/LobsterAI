import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test } from 'vitest';

import { OPENCLAW_SESSION_STORE_TEMP_MAX_AGE_MS, pruneOrphanOpenClawSessionStoreTemps } from './openclawSessionStoreTempCleanup';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = '027a053e-24bc-4cec-92e4-5a1baec4d2d1';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function stateDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-session-temp-'));
  roots.push(root);
  return root;
}
function write(file: string, ageMs: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"partial":');
  const time = new Date(NOW - ageMs);
  fs.utimesSync(file, time, time);
  return file;
}

test('removes only old orphan store temps in agent and top-level session dirs', async () => {
  const state = stateDir();
  const main = path.join(state, 'agents', 'main', 'sessions');
  const removable = [
    write(path.join(main, `sessions.json.${UUID}.tmp`), 30 * DAY_MS),
    write(path.join(main, `sessions.json.4242.${UUID.toUpperCase()}.tmp`), 8 * DAY_MS),
    write(path.join(state, 'agents', 'worker', 'sessions', `sessions.json.${UUID}.tmp`), 8 * DAY_MS),
    write(path.join(state, 'sessions', `sessions.json.${UUID}.tmp`), 8 * DAY_MS),
  ];
  const kept = [
    write(path.join(main, `sessions.json.f7a22dd4-1b21-4a78-b84d-3dca403e1b56.tmp`), 6 * DAY_MS),
    write(path.join(main, 'sessions.json'), 30 * DAY_MS),
    write(path.join(main, `${UUID}.jsonl`), 30 * DAY_MS),
    write(path.join(main, `${UUID}.jsonl.deleted.2026-08-03T06-15-52.517Z`), 30 * DAY_MS),
    write(path.join(main, `other.json.${UUID}.tmp`), 30 * DAY_MS),
    write(path.join(main, `sessions.json.not-a-uuid.tmp`), 30 * DAY_MS),
    write(path.join(state, 'agents', 'main', `sessions.json.${UUID}.tmp`), 30 * DAY_MS),
  ];
  // A link named like a temp is not a file this cleanup owns.
  const target = write(path.join(state, 'outside.tmp'), 30 * DAY_MS);
  fs.symlinkSync(target, path.join(main, 'sessions.json.11111111-2222-4333-8444-555555555555.tmp'));

  const removed = await pruneOrphanOpenClawSessionStoreTemps(state, { now: NOW });

  expect(OPENCLAW_SESSION_STORE_TEMP_MAX_AGE_MS).toBe(7 * DAY_MS);
  expect([...removed].sort()).toEqual([...removable].sort());
  for (const file of kept) expect(fs.existsSync(file)).toBe(true);
  expect(fs.existsSync(target)).toBe(true);
});

test('a state dir without agents or sessions is a no-op', async () => {
  expect(await pruneOrphanOpenClawSessionStoreTemps(stateDir(), { now: NOW })).toEqual([]);
});
