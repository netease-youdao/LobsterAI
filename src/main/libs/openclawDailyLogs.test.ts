import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { getOpenClawDailyLogCandidates, getRecentOpenClawDailyLogEntries } from './openclawDailyLogs';

const tempDirs: string[] = [];
afterEach(() => tempDirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

describe('OpenClaw native log export', () => {
  test('includes the Windows runtime temp directory even when a legacy drive-root directory exists', () => {
    expect(getOpenClawDailyLogCandidates({
      platform: 'win32', tmpDir: 'C:\\Users\\user\\AppData\\Local\\Temp', runtimeRoot: 'D:\\LobsterAI\\cfmind',
    })).toEqual(['C:\\Users\\user\\AppData\\Local\\Temp\\openclaw', 'D:\\tmp\\openclaw']);
  });

  test('includes the secure POSIX fallback', () => {
    expect(getOpenClawDailyLogCandidates({ platform: 'darwin', tmpDir: '/private/tmp', uid: 501 }))
      .toEqual(['/tmp/openclaw', '/private/tmp/openclaw-501', '/private/tmp/openclaw']);
  });

  test('keeps both same-day logs, skips old/unrelated files, and deduplicates aliases', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-export-'));
    tempDirs.push(root);
    const native = path.join(root, 'native');
    const legacy = path.join(root, 'legacy');
    fs.mkdirSync(native);
    fs.mkdirSync(legacy);
    const name = 'openclaw-2026-09-18.log';
    fs.writeFileSync(path.join(native, name), 'native receipt');
    fs.writeFileSync(path.join(legacy, name), 'legacy log');
    fs.writeFileSync(path.join(native, 'account.json'), 'not a log');
    const old = path.join(native, 'openclaw-2026-09-01.log');
    fs.writeFileSync(old, 'expired');
    const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(old, oldTime, oldTime);
    fs.mkdirSync(path.join(native, 'openclaw-2026-09-17.log'));
    const entries = getRecentOpenClawDailyLogEntries([native, legacy, native, path.join(root, 'missing')]);
    expect(entries).toEqual([
      { archiveName: name, filePath: path.join(native, name) },
      { archiveName: `openclaw-logs/2/${name}`, filePath: path.join(legacy, name) },
    ]);
    expect(entries.map(entry => fs.readFileSync(entry.filePath, 'utf8'))).toEqual(['native receipt', 'legacy log']);
  });
});
