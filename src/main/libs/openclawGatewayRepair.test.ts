import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test } from 'vitest';

import { OpenClawEngineErrorCode } from '../../shared/openclawEngine/constants';
import {
  backupOpenClawConfig,
  getOpenClawGatewayRepairBusyError,
  OPENCLAW_GATEWAY_REPAIR_BUSY_ERROR,
  preserveOpenClawConfigForStartupRecovery,
  resolveOpenClawConfigBackupPath,
} from './openclawGatewayRepair';

const tempDirs: string[] = [];

const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-openclaw-repair-'));
  tempDirs.push(dir);
  return dir;
};

test('Quick Repair retains legacy discovery data even before a failure code was captured', () => {
  const configPath = path.join(makeTempDir(), 'openclaw.json');
  fs.writeFileSync(configPath, JSON.stringify({ plugins: { bundledDiscovery: 'compat' } }));
  expect(preserveOpenClawConfigForStartupRecovery(configPath)).toBe(true);
  expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).plugins.bundledDiscovery).toBe('compat');
});

test('a binding recovery failure retains regenerated config without the old field', () => {
  const configPath = path.join(makeTempDir(), 'openclaw.json');
  fs.writeFileSync(configPath, '{}');
  expect(preserveOpenClawConfigForStartupRecovery(configPath, OpenClawEngineErrorCode.StartupCompatibilityFailed)).toBe(true);
  expect(preserveOpenClawConfigForStartupRecovery(configPath, OpenClawEngineErrorCode.MemoryDreamingMigrationFailed)).toBe(true);
  expect(preserveOpenClawConfigForStartupRecovery(configPath, OpenClawEngineErrorCode.StartupMigrationRefused)).toBe(true);
  expect(preserveOpenClawConfigForStartupRecovery(configPath)).toBe(false);
  fs.writeFileSync(configPath, 'invalid JSON');
  expect(preserveOpenClawConfigForStartupRecovery(configPath)).toBe(false);
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backupOpenClawConfig renames openclaw.json to the preferred backup path', () => {
  const dir = makeTempDir();
  const configPath = path.join(dir, 'openclaw.json');
  const backupPath = path.join(dir, 'openclaw-bak.json');
  fs.writeFileSync(configPath, '{"gateway":{"mode":"local"}}\n', 'utf8');

  const result = backupOpenClawConfig(configPath);

  expect(result).toEqual({
    originalPath: configPath,
    backupPath,
  });
  expect(fs.existsSync(configPath)).toBe(false);
  expect(fs.readFileSync(backupPath, 'utf8')).toBe('{"gateway":{"mode":"local"}}\n');
});

test('resolveOpenClawConfigBackupPath uses a timestamped path when the preferred backup exists', () => {
  const dir = makeTempDir();
  const configPath = path.join(dir, 'openclaw.json');
  const existing = new Set([
    path.join(dir, 'openclaw-bak.json'),
  ]);

  const backupPath = resolveOpenClawConfigBackupPath(
    configPath,
    (filePath) => existing.has(filePath),
    new Date('2026-06-05T09:08:07'),
  );

  expect(backupPath).toBe(path.join(dir, 'openclaw-bak-20260605-090807.json'));
});

test('resolveOpenClawConfigBackupPath never overwrites timestamped backups', () => {
  const dir = makeTempDir();
  const configPath = path.join(dir, 'openclaw.json');
  const existing = new Set([
    path.join(dir, 'openclaw-bak.json'),
    path.join(dir, 'openclaw-bak-20260605-090807.json'),
  ]);

  const backupPath = resolveOpenClawConfigBackupPath(
    configPath,
    (filePath) => existing.has(filePath),
    new Date('2026-06-05T09:08:07'),
  );

  expect(backupPath).toBe(path.join(dir, 'openclaw-bak-20260605-090807-2.json'));
});

test('backupOpenClawConfig returns the original path when openclaw.json is missing', () => {
  const dir = makeTempDir();
  const configPath = path.join(dir, 'openclaw.json');

  const result = backupOpenClawConfig(configPath);

  expect(result).toEqual({ originalPath: configPath });
  expect(fs.existsSync(configPath)).toBe(false);
});

test('getOpenClawGatewayRepairBusyError rejects active gateway workloads', () => {
  expect(getOpenClawGatewayRepairBusyError(true)).toBe(OPENCLAW_GATEWAY_REPAIR_BUSY_ERROR);
  expect(getOpenClawGatewayRepairBusyError(false)).toBeNull();
});
