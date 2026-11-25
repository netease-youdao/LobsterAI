import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { RetainedImPlatform } from '../../shared/dshEngine/hostConstants';
import { WEIXIN_DEFAULT_BASE_URL, WeixinPlugin } from '../../shared/im/weixin';
import { MIGRATION_V2_REPORT_KV_KEY, MIGRATION_V2_WEIXIN_CREDENTIALS_KEY } from '../../shared/migration/constants';
import { runLegacyOpenClawMigration } from './legacyOpenClawMigrator';
import { migrateLegacyWeixinCredentials, WEIXIN_REAUTH_ITEM } from './legacyWeixinCredentials';

let dir: string;
let state: string;
let db: Database.Database;
const binding = { enabled: true, accountId: 'a@im.bot', dmPolicy: 'allowlist', allowFrom: ['owner'], debug: false };
const bot = RetainedImPlatform.Weixin;
function bind(config: object) {
  db.prepare('INSERT OR REPLACE INTO im_config VALUES (?, ?, 1)').run(bot, JSON.stringify(config));
}
function read() {
  const row = db.prepare('SELECT value FROM im_config WHERE key = ?').get(bot) as { value: string };
  return JSON.parse(row.value);
}
function write(file: string, value: unknown) {
  const full = path.join(state, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, JSON.stringify(value));
}
const accounts = WeixinPlugin.Id + '/accounts/';
const globalFile = 'credentials/' + WeixinPlugin.Id + '/credentials.json';
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'weixin-upgrade-'));
  state = path.join(dir, 'openclaw', 'state');
  db = new Database(path.join(dir, 'lobsterai.sqlite'));
  db.exec('CREATE TABLE im_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)');
  bind(binding);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

test.each(['a-im-bot', 'a@im.bot'])('imports the bound %s login, preserving routing, access and a later replacement', name => {
  const login = { token: 'original', baseUrl: 'https://sz.ilinkai.weixin.qq.com', userId: 'owner' };
  write(accounts + name + '.json', login);
  expect(migrateLegacyWeixinCredentials(db, state)).toBeNull();
  expect(read()).toEqual({ ...binding, botToken: login.token, baseUrl: login.baseUrl, userId: login.userId });
  bind({ ...binding, botToken: 'replacement' });
  expect(migrateLegacyWeixinCredentials(db, state)).toBeNull();
  expect(read()).toEqual({ ...binding, botToken: 'replacement' });
});

test('accepts the old single-account format and rejects ambiguous or conflicting owners', () => {
  write(globalFile, { token: 'single' });
  expect(migrateLegacyWeixinCredentials(db, state)).toBeNull();
  expect(read()).toEqual({ ...binding, botToken: 'single', baseUrl: WEIXIN_DEFAULT_BASE_URL });
  bind(binding);
  write(WeixinPlugin.Id + '/accounts.json', ['other-im-bot']);
  expect(migrateLegacyWeixinCredentials(db, state)).toEqual(WEIXIN_REAUTH_ITEM);
  write(accounts + 'other-im-bot.json', { token: 'another' });
  write(accounts + 'a-im-bot.json', { token: 'another', userId: 'different' });
  bind({ ...binding, userId: 'owner' });
  expect(migrateLegacyWeixinCredentials(db, state)).toEqual(WEIXIN_REAUTH_ITEM);
  expect(read().botToken).toBeUndefined();
});

test('reports only a configured, enabled bot when its file is absent or corrupted', () => {
  expect(migrateLegacyWeixinCredentials(db, state)).toEqual(WEIXIN_REAUTH_ITEM);
  write(accounts + 'a-im-bot.json', {});
  writeFileSync(path.join(state, accounts, 'a-im-bot.json'), '{');
  expect(migrateLegacyWeixinCredentials(db, state)).toEqual(WEIXIN_REAUTH_ITEM);
  bind({ ...binding, enabled: false });
  expect(migrateLegacyWeixinCredentials(db, state)).toBeNull();
  bind({ ...binding, accountId: '' });
  expect(migrateLegacyWeixinCredentials(db, state)).toBeNull();
});

test('a damaged account directory cannot abort the upgrade or authorize an unscoped token', () => {
  write(WeixinPlugin.Id + '/accounts', 'damaged directory');
  write(globalFile, { token: 'unscoped' });
  expect(migrateLegacyWeixinCredentials(db, state)).toEqual(WEIXIN_REAUTH_ITEM);
  expect(read().botToken).toBeUndefined();
});

test('backfills an earlier affected upgrade once and leaves a later cleared login alone', () => {
  mkdirSync(state, { recursive: true });
  const options = { userDataDir: dir, sqlitePath: db.name };
  expect(runLegacyOpenClawMigration(options).report?.reauthRequired).toContainEqual(WEIXIN_REAUTH_ITEM);
  db.prepare('DELETE FROM kv WHERE key = ?').run(MIGRATION_V2_WEIXIN_CREDENTIALS_KEY);
  write(accounts + 'a-im-bot.json', { token: 'recovered' });
  runLegacyOpenClawMigration(options);
  expect(read().botToken).toBe('recovered');
  const report = db.prepare('SELECT value FROM kv WHERE key = ?').get(MIGRATION_V2_REPORT_KV_KEY) as { value: string };
  expect(JSON.parse(report.value).reauthRequired).not.toContainEqual(WEIXIN_REAUTH_ITEM);
  bind(binding);
  runLegacyOpenClawMigration(options);
  expect(read().botToken).toBeUndefined();
});

test('skips a rebound or explicitly cleared bot during a backfill', () => {
  write(accounts + 'a-im-bot.json', { token: 'old' });
  migrateLegacyWeixinCredentials(db, state, { accountId: 'other@im.bot' });
  expect(read().botToken).toBeUndefined();
  bind({ ...binding, botToken: '' });
  migrateLegacyWeixinCredentials(db, state, binding);
  expect(read().botToken).toBe('');
});
