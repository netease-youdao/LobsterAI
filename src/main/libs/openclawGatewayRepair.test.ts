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

test('backupOpenClawConfig moves openclaw.json into the repair backup directory', () => {
  const dir = makeTempDir();
  const configPath = path.join(dir, 'openclaw.json');
  const backupDir = makeTempDir();
  const backupPath = path.join(backupDir, 'openclaw.json');
  fs.writeFileSync(configPath, '{"gateway":{"mode":"local"}}\n', 'utf8');

  const result = backupOpenClawConfig(configPath, backupDir);

  expect(result).toEqual({
    originalPath: configPath,
    backupPath,
  });
  expect(fs.existsSync(configPath)).toBe(false);
  expect(fs.readFileSync(backupPath, 'utf8')).toBe('{"gateway":{"mode":"local"}}\n');
  // Nothing is left beside the config for startup cleanup to find.
  expect(fs.readdirSync(dir)).toEqual([]);
});

test('backupOpenClawConfig never overwrites an existing backup', () => {
  const configPath = path.join(makeTempDir(), 'openclaw.json');
  const backupDir = makeTempDir();
  fs.writeFileSync(configPath, '{"current":true}', 'utf8');
  fs.writeFileSync(path.join(backupDir, 'openclaw.json'), '{"earlier":true}', 'utf8');

  expect(() => backupOpenClawConfig(configPath, backupDir)).toThrow('OpenClaw config backup already exists');
  expect(fs.readFileSync(configPath, 'utf8')).toBe('{"current":true}');
  expect(fs.readFileSync(path.join(backupDir, 'openclaw.json'), 'utf8')).toBe('{"earlier":true}');
});

test('backupOpenClawConfig returns the original path when openclaw.json is missing', () => {
  const dir = makeTempDir();
  const configPath = path.join(dir, 'openclaw.json');
  const backupDir = makeTempDir();

  const result = backupOpenClawConfig(configPath, backupDir);

  expect(result).toEqual({ originalPath: configPath });
  expect(fs.existsSync(configPath)).toBe(false);
  expect(fs.readdirSync(backupDir)).toEqual([]);
});

test('getOpenClawGatewayRepairBusyError rejects active gateway workloads', () => {
  expect(getOpenClawGatewayRepairBusyError(true)).toBe(OPENCLAW_GATEWAY_REPAIR_BUSY_ERROR);
  expect(getOpenClawGatewayRepairBusyError(false)).toBeNull();
});
