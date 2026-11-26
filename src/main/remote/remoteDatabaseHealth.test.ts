import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, it } from 'vitest';

import { RemoteDatabaseHealth } from './remoteDatabaseHealth';

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true }); });
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-db-health-')); folders.push(directory);
  const file = path.join(directory, 'isolated.sqlite');
  const db = new Database(file); db.exec('CREATE TABLE evidence(id TEXT PRIMARY KEY); INSERT INTO evidence VALUES(\'known\')'); db.close();
  return { file, health: new RemoteDatabaseHealth(file) };
}
it('uses a real read-only SQLite integrity worker and keeps unknown closed until verified', async () => {
  const f = fixture(); expect(f.health.current()).toBe(false);
  await expect(f.health.verify()).resolves.toBe(true);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(f.health.current()).toBe(true);
});
it('returns unknown after invalidation and fails closed on actual corrupted SQLite bytes', async () => {
  const f = fixture(); await f.health.verify(); f.health.invalidate();
  expect(f.health.current()).toBe(false);
  fs.writeFileSync(f.file, 'not a SQLite database');
  await expect(f.health.verify()).resolves.toBe(false); expect(f.health.current()).toBe(false);
});
