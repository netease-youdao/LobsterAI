import fs from 'node:fs';
import path from 'node:path';

import type Database from 'better-sqlite3';

import { RetainedImPlatform } from '../../shared/dshEngine/hostConstants';
import { legacyWeixinAccountId, WEIXIN_DEFAULT_BASE_URL, WeixinPlugin } from '../../shared/im/weixin';
import type { MigrationV2ReauthItem } from '../../shared/migration/constants';

export const WEIXIN_REAUTH_ITEM = {
  kind: 'im_weixin', id: RetainedImPlatform.Weixin, label: 'Weixin Bot (QR re-login required)',
} as const satisfies MigrationV2ReauthItem;

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function field(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readAccount(stateDir: string, id: string) {
  const root = path.join(stateDir, WeixinPlugin.Id);
  const accounts = path.join(root, 'accounts');
  const rawId = id.replace(/-im-(bot|wechat)$/, '@im.$1');
  for (const name of new Set([id, rawId])) {
    const data = record(readJson(path.join(accounts, name + '.json')));
    if (data) return data;
  }

  // The pre-multi-account plugin stored an unscoped credential. Do not use it
  // when another account may own it or the account index is unreadable.
  const legacy = record(readJson(path.join(stateDir, 'credentials', WeixinPlugin.Id, 'credentials.json')));
  if (!field(legacy?.token)) return;
  const indexPath = path.join(root, 'accounts.json');
  if (fs.existsSync(indexPath)) {
    const index = readJson(indexPath);
    if (!Array.isArray(index) || !index.length || !index.every(entry => legacyWeixinAccountId(field(entry)) === id)) return;
  }
  try {
    if (fs.existsSync(accounts) && fs.readdirSync(accounts).some(name => name.endsWith('.json'))) return;
  } catch {
    return;
  }
  return legacy;
}

/** Import only the bound bot's login. Keep the original ID, routing and access policy. */
export function migrateLegacyWeixinCredentials(
  db: Database.Database,
  stateDir: string,
  previousBinding?: { accountId: string; userId?: string },
): MigrationV2ReauthItem | null {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='im_config'").get()) return null;
  const platform = RetainedImPlatform.Weixin;
  const row = db.prepare('SELECT value FROM im_config WHERE key = ?').get(platform) as { value: string } | undefined;
  if (!row) return null;
  let config: Record<string, unknown> | undefined;
  try {
    config = record(JSON.parse(row.value));
  } catch {
    return null;
  }
  const id = legacyWeixinAccountId(field(config?.accountId));
  if (!config || !id || field(config.botToken)) return null;
  if (previousBinding && (
    id !== legacyWeixinAccountId(previousBinding.accountId) || Object.hasOwn(config, 'botToken') || !config.enabled
  )) return config.enabled ? WEIXIN_REAUTH_ITEM : null;

  const data = readAccount(stateDir, id);
  const token = field(data?.token);
  const userId = field(data?.userId);
  const owners = new Set([userId, field(config.userId), field(previousBinding?.userId)].filter(Boolean));
  if (!token || owners.size > 1) {
    return config.enabled ? WEIXIN_REAUTH_ITEM : null;
  }
  db.prepare('UPDATE im_config SET value = ?, updated_at = ? WHERE key = ?').run(JSON.stringify({
    ...config, botToken: token, baseUrl: field(data?.baseUrl) || WEIXIN_DEFAULT_BASE_URL,
    ...(userId ? { userId } : {}),
  }), Date.now(), platform);
  return null;
}
