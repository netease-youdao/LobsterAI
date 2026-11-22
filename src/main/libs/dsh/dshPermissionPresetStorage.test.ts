import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';

import {
  DEFAULT_DSH_PERMISSION_PRESET,
  DSH_PERMISSION_PRESET_KV_KEY,
  DshPermissionPreset,
} from '../../../shared/dshEngine/hostConstants';
import { resolveInitialDshPermissionPreset } from './dshPermissionPresetStorage';

const openDbs: Database.Database[] = [];

function createMemoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)');
  db.exec('CREATE TABLE cowork_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)');
  openDbs.push(db);
  return db;
}

function createKvPort(db: Database.Database) {
  return {
    get(key: string): string | null {
      const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value?: string } | undefined;
      return typeof row?.value === 'string' ? row.value : null;
    },
    set(key: string, value: string): void {
      db.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(key, value, Date.now());
    },
  };
}

afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()!.close();
});

describe('resolveInitialDshPermissionPreset', () => {
  test('prefers stored kv preset over legacy cowork_config.executionMode', () => {
    const db = createMemoryDb();
    const kv = createKvPort(db);
    db.prepare("INSERT INTO cowork_config (key, value, updated_at) VALUES ('executionMode', 'auto', 1)").run();
    kv.set(DSH_PERMISSION_PRESET_KV_KEY, DshPermissionPreset.ReadOnly);

    expect(resolveInitialDshPermissionPreset(db, kv)).toBe(DshPermissionPreset.ReadOnly);
    expect(kv.get(DSH_PERMISSION_PRESET_KV_KEY)).toBe(DshPermissionPreset.ReadOnly);
  });

  test('falls back to legacy cowork_config.executionMode=auto and persists danger-full-access', () => {
    const db = createMemoryDb();
    const kv = createKvPort(db);
    db.prepare("INSERT INTO cowork_config (key, value, updated_at) VALUES ('executionMode', 'auto', 1)").run();

    expect(resolveInitialDshPermissionPreset(db, kv)).toBe(DshPermissionPreset.FullAccess);
    expect(kv.get(DSH_PERMISSION_PRESET_KV_KEY)).toBe(DshPermissionPreset.FullAccess);
  });

  test('maps legacy local and sandbox executionMode to workspace-write', () => {
    for (const legacyMode of ['local', 'sandbox']) {
      const db = createMemoryDb();
      const kv = createKvPort(db);
      db.prepare("INSERT INTO cowork_config (key, value, updated_at) VALUES ('executionMode', ?, 1)").run(legacyMode);

      expect(resolveInitialDshPermissionPreset(db, kv)).toBe(DshPermissionPreset.WorkspaceWrite);
      expect(kv.get(DSH_PERMISSION_PRESET_KV_KEY)).toBe(DshPermissionPreset.WorkspaceWrite);
    }
  });

  test('defaults to workspace-write when both kv and legacy executionMode are absent', () => {
    const db = createMemoryDb();
    const kv = createKvPort(db);

    expect(resolveInitialDshPermissionPreset(db, kv)).toBe(DEFAULT_DSH_PERMISSION_PRESET);
    expect(kv.get(DSH_PERMISSION_PRESET_KV_KEY)).toBeNull();
  });
});
