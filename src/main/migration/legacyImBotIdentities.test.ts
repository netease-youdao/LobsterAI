import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { expect, test } from 'vitest';

import { LEGACY_OPENCLAW_BACKUP_DIR_NAME } from '../../shared/dshEngine/hostConstants';
import { MIGRATION_V2_IM_IDENTITIES_KEY, MIGRATION_V2_REPORT_KV_KEY } from '../../shared/migration/constants';
import { legacyImBotIdentities, preserveLegacyImBotIdentities } from './legacyImBotIdentities';

test('recovers only the original Weixin identity from this profile’s migration snapshot after rebinding', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lobster-weixin-identity-'));
  const db = new Database(':memory:');
  try {
    const stamp = '2026-11-24T02-38-05-108Z';
    const folder = path.join(dir, LEGACY_OPENCLAW_BACKUP_DIR_NAME, stamp);
    mkdirSync(folder, { recursive: true });
    const snapshot = new Database(path.join(folder, 'lobsterai.pre-v2.sqlite'));
    try {
      snapshot.exec('CREATE TABLE im_config (key TEXT PRIMARY KEY, value TEXT)');
      snapshot.prepare('INSERT INTO im_config VALUES (?, ?)').run('weixin', JSON.stringify({
        accountId: 'original-im-bot', userId: 'owner', botToken: 'private-before-upgrade',
      }));
    } finally {
      snapshot.close();
    }
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)');
    const put = db.prepare('INSERT OR REPLACE INTO kv VALUES (?, ?, 1)');
    put.run(MIGRATION_V2_REPORT_KV_KEY, JSON.stringify({ backupDir: path.join('previous-location', stamp) }));
    preserveLegacyImBotIdentities(db, dir);
    const expected = [{ key: 'weixin', accountId: 'original-im-bot', userId: 'owner' }];
    expect(legacyImBotIdentities(db)).toEqual(expected);
    expect(db.prepare('SELECT value FROM kv WHERE key = ?').get(MIGRATION_V2_IM_IDENTITIES_KEY))
      .toEqual({ value: JSON.stringify(expected) });
    put.run(MIGRATION_V2_REPORT_KV_KEY, '{}');
    preserveLegacyImBotIdentities(db, dir);
    expect(legacyImBotIdentities(db)).toEqual(expected);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
