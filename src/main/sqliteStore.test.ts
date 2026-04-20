import BetterSqlite3 from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/lobsterai-tests',
    getAppPath: () => '/tmp/lobsterai-tests',
  },
}));

import { DB_FILENAME } from './appConstants';
import { SqliteStore } from './sqliteStore';

const createLegacyDatabase = (basePath: string): void => {
  const dbPath = path.join(basePath, DB_FILENAME);
  const db = new BetterSqlite3(dbPath);

  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '',
      identity TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT '',
      skill_ids TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'custom',
      preset_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  const now = Date.now();
  db.prepare(`
    INSERT INTO agents (id, name, description, system_prompt, identity, model, icon, skill_ids, enabled, is_default, source, preset_id, created_at, updated_at)
    VALUES ('writer', 'Writer', '', '', '', '', '✍️', '[]', 1, 0, 'custom', '', ?, ?)
  `).run(now, now);

  db.close();
};

test('SqliteStore migrates the agents table to include avatar_path', () => {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-sqlite-store-'));
  createLegacyDatabase(basePath);

  SqliteStore.create(basePath);

  const db = new BetterSqlite3(path.join(basePath, DB_FILENAME), { readonly: true });
  const columns = db.pragma('table_info(agents)') as Array<{ name: string }>;
  const writerRow = db.prepare(`
    SELECT avatar_path
    FROM agents
    WHERE id = 'writer'
  `).get() as { avatar_path: string };

  expect(columns.some((column) => column.name === 'avatar_path')).toBe(true);
  expect(writerRow.avatar_path).toBe('');

  db.close();
});
