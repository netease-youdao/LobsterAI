import { existsSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { LEGACY_OPENCLAW_BACKUP_DIR_NAME, RetainedImPlatform } from '../../shared/dshEngine/hostConstants';
import { MIGRATION_V2_IM_IDENTITIES_KEY, MIGRATION_V2_REPORT_KV_KEY } from '../../shared/migration/constants';

const ACCOUNT_FIELDS = {
  [RetainedImPlatform.DingTalk]: 'clientId',
  [RetainedImPlatform.Feishu]: 'appId',
  [RetainedImPlatform.WeCom]: 'botId',
  [RetainedImPlatform.QQ]: 'appId',
  [RetainedImPlatform.Weixin]: 'accountId',
} as const;

export type LegacyDirectPlatform = keyof typeof ACCOUNT_FIELDS;

export function isLegacyDirectPlatform(platform: RetainedImPlatform): platform is LegacyDirectPlatform {
  return Object.hasOwn(ACCOUNT_FIELDS, platform);
}

interface ImBotIdentity {
  key: string;
  accountId: string;
  userId?: string;
}

export function currentImBotIdentities(db: Database.Database, platform: LegacyDirectPlatform): ImBotIdentity[] {
  const weixin = platform === RetainedImPlatform.Weixin;
  const query = weixin ? 'key = ?' : 'key GLOB ?';
  const rows = db.prepare('SELECT key, value FROM im_config WHERE ' + query)
    .all(weixin ? platform : platform + ':*') as { key: string; value: string }[];
  if (!weixin && !rows.length) {
    // IMStore assigns a UUID to older single-bot settings on first open.
    const singleKey = platform === RetainedImPlatform.QQ ? platform : platform + 'OpenClaw';
    const single = db.prepare('SELECT value FROM im_config WHERE key = ?').get(singleKey) as { value: string } | undefined;
    if (single) rows.push({ key: platform, value: single.value });
  }
  return rows.map(row => {
    let accountId = '';
    let userId: string | undefined;
    try {
      const record = JSON.parse(row.value);
      const id = record?.[ACCOUNT_FIELDS[platform]];
      if (typeof id === 'string') accountId = id.trim();
      if (weixin && typeof record?.userId === 'string') userId = record.userId.trim();
    } catch {
      // A malformed or disabled configuration still counts for prefix collisions.
    }
    return { key: row.key, accountId, ...(userId ? { userId } : {}) };
  });
}

export function legacyImBotIdentities(db: Database.Database): ImBotIdentity[] | null {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(MIGRATION_V2_IM_IDENTITIES_KEY) as
    { value: string } | undefined;
  if (!row) return null;
  try {
    const data: unknown = JSON.parse(row.value);
    if (Array.isArray(data) && data.every(item => typeof item?.key === 'string' && typeof item.accountId === 'string'
      && (item.userId === undefined || typeof item.userId === 'string'))) return data;
  } catch {
    // A missing snapshot leaves only directly provable live account keys.
  }
  return null;
}

function snapshotIdentities(db: Database.Database): ImBotIdentity[] {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='im_config'").get()) return [];
  return (Object.keys(ACCOUNT_FIELDS) as LegacyDirectPlatform[]).flatMap(platform => currentImBotIdentities(db, platform));
}

// Preserve public bot identities before credentials can be edited or a DSH QR
// login can replace a Weixin account. Earlier upgrades use their own snapshot.
export function preserveLegacyImBotIdentities(db: Database.Database, upgradedProfileDir?: string): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='kv'").get()) return;
  const lookup = db.prepare('SELECT value FROM kv WHERE key = ?');
  if (lookup.get(MIGRATION_V2_IM_IDENTITIES_KEY)) return;
  let identities: ImBotIdentity[];
  if (upgradedProfileDir === undefined) {
    identities = snapshotIdentities(db);
  } else {
    const report = lookup.get(MIGRATION_V2_REPORT_KV_KEY) as { value: string } | undefined;
    if (!report) return;
    let snapshot: Database.Database | undefined;
    try {
      const stamp = path.posix.basename(JSON.parse(report.value).backupDir.replace(/\\/g, '/'));
      if (!/^\d{4}-\d{2}-\d{2}T[\d-]+Z$/.test(stamp)) return;
      const file = path.join(upgradedProfileDir, LEGACY_OPENCLAW_BACKUP_DIR_NAME, stamp, 'lobsterai.pre-v2.sqlite');
      if (!existsSync(file)) return;
      snapshot = new Database(file, { readonly: true, fileMustExist: true });
      identities = snapshotIdentities(snapshot);
    } catch {
      return;
    } finally {
      snapshot?.close();
    }
  }
  db.prepare('INSERT OR IGNORE INTO kv (key, value, updated_at) VALUES (?, ?, ?)')
    .run(MIGRATION_V2_IM_IDENTITIES_KEY, JSON.stringify(identities), Date.now());
}
