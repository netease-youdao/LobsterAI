import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  migrateLegacyWeixinAllowFrom,
  runLegacyWeixinAllowFromMigration,
  WeixinPairingMigrationStatus,
} from './openclawWeixinPairingMigration';

const tempDirs: string[] = [];

function makeStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-weixin-pairing-'));
  tempDirs.push(dir);
  return dir;
}

function writeCredential(stateDir: string, name: string, content: string): string {
  const dir = path.join(stateDir, 'credentials');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

function makeStore(allowFrom: string[] = []) {
  const state = { allowFrom };
  return {
    state,
    getWeixinConfig: vi.fn(() => ({ allowFrom: state.allowFrom })),
    setWeixinConfig: vi.fn((config: { allowFrom: string[] }) => {
      state.allowFrom = config.allowFrom;
    }),
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('migrateLegacyWeixinAllowFrom', () => {
  test('skips without touching the store when no legacy Weixin allowFrom file exists', () => {
    const stateDir = makeStateDir();
    writeCredential(stateDir, 'openclaw-weixin-pairing.json', '{"version":1,"requests":[]}');
    writeCredential(stateDir, 'discord-allowFrom.json', '{"version":1,"allowFrom":["1"]}');
    const store = makeStore();

    const result = migrateLegacyWeixinAllowFrom({ stateDir, getStore: () => store });

    expect(result.status).toBe(WeixinPairingMigrationStatus.Skipped);
    expect(store.getWeixinConfig).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(stateDir, 'credentials', 'discord-allowFrom.json'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'credentials', 'openclaw-weixin-pairing.json'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'startup-recovery-backups'))).toBe(false);
  });

  test('skips when the credentials directory is missing', () => {
    const store = makeStore();
    const result = migrateLegacyWeixinAllowFrom({ stateDir: makeStateDir(), getStore: () => store });
    expect(result.status).toBe(WeixinPairingMigrationStatus.Skipped);
    expect(store.getWeixinConfig).not.toHaveBeenCalled();
  });

  test('merges approved sender ids into the channel config and archives the file byte-for-byte', () => {
    const stateDir = makeStateDir();
    const original = '{\n  "version": 1,\n  "allowFrom": ["wxid_a", " wxid_b ", "*", "wxid_a", 42, null]\n}\n';
    const source = writeCredential(stateDir, 'openclaw-weixin-a74391227cd8-im-bot-allowFrom.json', original);
    const store = makeStore(['wxid_b', '*']);

    const result = migrateLegacyWeixinAllowFrom({
      stateDir, getStore: () => store, now: () => new Date('2026-09-21T06:12:55.037Z'),
    });

    expect(result.status).toBe(WeixinPairingMigrationStatus.Migrated);
    expect(result.addedEntries).toEqual(['wxid_a', '42']);
    expect(store.setWeixinConfig).toHaveBeenCalledExactlyOnceWith({ allowFrom: ['wxid_b', '*', 'wxid_a', '42'] });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({ source, accountKey: 'a74391227cd8-im-bot', entries: ['wxid_a', 'wxid_b', '42'] });
    expect(fs.existsSync(source)).toBe(false);
    const backupPath = result.files[0].backupPath!;
    expect(path.dirname(backupPath)).toBe(result.backupDir);
    expect(path.relative(stateDir, backupPath).split(path.sep)).toEqual([
      'startup-recovery-backups', 'weixin-allowfrom',
      expect.stringMatching(/^2026-09-21T06-12-55-037Z-.+$/),
      'openclaw-weixin-a74391227cd8-im-bot-allowFrom.json',
    ]);
    expect(fs.readFileSync(backupPath, 'utf8')).toBe(original);
  });

  test('handles the channel-level file and a bare array without duplicating configured ids', () => {
    const stateDir = makeStateDir();
    const source = writeCredential(stateDir, 'openclaw-weixin-allowFrom.json', '["wxid_c", "wxid_d"]');
    const store = makeStore(['wxid_d']);

    const result = migrateLegacyWeixinAllowFrom({ stateDir, getStore: () => store });

    expect(result.status).toBe(WeixinPairingMigrationStatus.Migrated);
    expect(result.files[0]).toMatchObject({ source, accountKey: null, entries: ['wxid_c', 'wxid_d'] });
    expect(store.state.allowFrom).toEqual(['wxid_d', 'wxid_c']);
    expect(fs.existsSync(source)).toBe(false);
  });

  test('archives an unreadable file without changing the config and reports why', () => {
    const stateDir = makeStateDir();
    const source = writeCredential(stateDir, 'openclaw-weixin-acct-allowFrom.json', '{not json');
    const store = makeStore(['wxid_z']);

    const result = migrateLegacyWeixinAllowFrom({ stateDir, getStore: () => store });

    expect(result.status).toBe(WeixinPairingMigrationStatus.Migrated);
    expect(result.addedEntries).toEqual([]);
    expect(store.setWeixinConfig).not.toHaveBeenCalled();
    expect(result.files[0].error).toContain('unreadable');
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(result.files[0].backupPath!, 'utf8')).toBe('{not json');
  });

  test('leaves every file in place when the config cannot be persisted', () => {
    const stateDir = makeStateDir();
    const source = writeCredential(stateDir, 'openclaw-weixin-acct-allowFrom.json', '{"allowFrom":["wxid_a"]}');
    const store = makeStore();
    store.setWeixinConfig.mockImplementation(() => {
      throw new Error('database is locked');
    });

    const result = migrateLegacyWeixinAllowFrom({ stateDir, getStore: () => store });

    expect(result.status).toBe(WeixinPairingMigrationStatus.Failed);
    expect(result.error).toContain('database is locked');
    expect(result.addedEntries).toEqual([]);
    expect(fs.existsSync(source)).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'startup-recovery-backups'))).toBe(false);
  });

  test('is idempotent once the files are archived', () => {
    const stateDir = makeStateDir();
    writeCredential(stateDir, 'openclaw-weixin-acct-allowFrom.json', '{"allowFrom":["wxid_a"]}');
    const store = makeStore();

    expect(migrateLegacyWeixinAllowFrom({ stateDir, getStore: () => store }).status).toBe(WeixinPairingMigrationStatus.Migrated);
    expect(migrateLegacyWeixinAllowFrom({ stateDir, getStore: () => store }).status).toBe(WeixinPairingMigrationStatus.Skipped);
    expect(store.setWeixinConfig).toHaveBeenCalledOnce();
    expect(store.state.allowFrom).toEqual(['wxid_a']);
  });
});

describe('runLegacyWeixinAllowFromMigration', () => {
  test('never throws, only reads the store when there is work, and logs counts rather than sender ids', () => {
    const stateDir = makeStateDir();
    writeCredential(stateDir, 'openclaw-weixin-acct-allowFrom.json', '{"allowFrom":["wxid_secret"]}');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = makeStore();
    const unavailable = () => {
      throw new Error('store unavailable');
    };

    expect(runLegacyWeixinAllowFromMigration({ stateDir, getStore: () => store }).status).toBe(WeixinPairingMigrationStatus.Migrated);
    expect(JSON.stringify(log.mock.calls)).not.toContain('wxid_secret');
    expect(runLegacyWeixinAllowFromMigration({ stateDir, getStore: unavailable }).status).toBe(WeixinPairingMigrationStatus.Skipped);

    writeCredential(stateDir, 'openclaw-weixin-other-allowFrom.json', '{"allowFrom":["wxid_x"]}');
    expect(runLegacyWeixinAllowFromMigration({ stateDir, getStore: unavailable }).status).toBe(WeixinPairingMigrationStatus.Failed);
    expect(error).toHaveBeenCalled();
    expect(fs.existsSync(path.join(stateDir, 'credentials', 'openclaw-weixin-other-allowFrom.json'))).toBe(true);
  });
});
