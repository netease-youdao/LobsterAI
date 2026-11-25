import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';

import { DshPermissionPreset } from '../../shared/dshEngine/hostConstants';
import { lookupSessionImChannelPermissionPreset } from './imChannelPermissionLookup';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE im_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE im_session_mappings (
      im_conversation_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      cowork_session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT 'main',
      created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL,
      PRIMARY KEY (im_conversation_id, platform, agent_id)
    );
  `);
  return db;
}

describe('lookupSessionImChannelPermissionPreset', () => {
  test('returns null when IM tables do not exist yet', () => {
    const db = new Database(':memory:');
    expect(lookupSessionImChannelPermissionPreset(db, 'session-1')).toBeNull();
    db.close();
  });

  test('resolves WeChat and multi-instance Feishu channel default presets from SQLite', () => {
    const db = createTestDb();
    const now = Date.now();
    db.prepare('INSERT INTO im_config (key, value, updated_at) VALUES (?, ?, ?)').run(
      'settings',
      JSON.stringify({
        platformPermissionPresets: {
          weixin: DshPermissionPreset.ReadOnly,
          feishu: DshPermissionPreset.WorkspaceWrite,
          'feishu:bot-2': DshPermissionPreset.FullAccess,
        },
      }),
      now,
    );
    db.prepare(
      'INSERT INTO im_session_mappings (im_conversation_id, platform, cowork_session_id, agent_id, created_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('o9cq@im.wechat', 'weixin', 'sess-wx', 'main', now, now);
    db.prepare(
      'INSERT INTO im_session_mappings (im_conversation_id, platform, cowork_session_id, agent_id, created_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('oc_1', 'feishu:bot-1', 'sess-fs-1', 'main', now, now);
    db.prepare(
      'INSERT INTO im_session_mappings (im_conversation_id, platform, cowork_session_id, agent_id, created_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('oc_2', 'feishu:bot-2', 'sess-fs-2', 'main', now, now);
    db.prepare(
      'INSERT INTO im_session_mappings (im_conversation_id, platform, cowork_session_id, agent_id, created_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('tg_1', 'telegram:bot-1', 'sess-tg', 'main', now, now);

    expect(lookupSessionImChannelPermissionPreset(db, 'sess-wx')).toBe(DshPermissionPreset.ReadOnly);
    expect(lookupSessionImChannelPermissionPreset(db, 'sess-fs-1')).toBe(DshPermissionPreset.WorkspaceWrite);
    expect(lookupSessionImChannelPermissionPreset(db, 'sess-fs-2')).toBe(DshPermissionPreset.FullAccess);
    expect(lookupSessionImChannelPermissionPreset(db, 'sess-tg')).toBeNull();
    expect(lookupSessionImChannelPermissionPreset(db, 'desktop-session')).toBeNull();
    db.close();
  });
});
