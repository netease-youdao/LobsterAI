import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  OPENCLAW_STARTUP_COMPATIBILITY_ENTRY,
  OPENCLAW_STARTUP_COMPATIBILITY_RESULT_PREFIX,
  OpenClawStartupCompatibilityMode,
} from '../../shared/openclawEngine/startupCompatibility';
import { OpenClawStartupMigrationStatus } from '../../shared/openclawEngine/startupMigration';
import {
  extractOpenClawBindingSchemaFailure,
  extractOpenClawCliFailure,
  hasLegacyOpenClawDiscovery,
  isOpenClawBindingSchemaFailure,
  runOpenClawStartupCompatibility,
} from './openclawStartupCompatibility';

let tempDir: string;
const warning = 'Config warnings: plugins.entries.openclaw-weixin: duplicate plugin id resolved by explicit config-selected plugin';
const failure = (stateDir: string) => `SQLite schema is incomplete or noncanonical for ${path.join(stateDir, 'state', 'openclaw.sqlite')}: column definitions differ for current_conversation_bindings`;

beforeEach(() => { tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-startup-compat-')); });
afterEach(() => {
  vi.restoreAllMocks();
  if (!path.resolve(tempDir).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unexpected fixture path');
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('startup failure evidence', () => {
  test('prefers the structured CLI cause over long warnings and secondary exceptions', () => {
    const error = failure(tempDir);
    expect(extractOpenClawCliFailure('diagnostic\n' + JSON.stringify({ ok: false, error: { type: 'cli_error', message: error } }),
      warning.repeat(30) + '\nError: secondary failure')).toBe(error);
  });

  test('reads the tagged reason and ignores its stack', () => {
    const error = failure(tempDir);
    expect(extractOpenClawCliFailure('', `${warning}\n[stderr] [openclaw] Reason: ${error}\n[stderr]     at openDatabase (file:///runtime/db.js:42:5)`)).toBe(error);
  });

  test('warning text alone cannot become a structured cause', () => {
    expect(extractOpenClawCliFailure('', warning)).toBeUndefined();
    expect(extractOpenClawCliFailure(JSON.stringify({ ok: true, error: { type: 'cli_error', message: 'ignored' } }), '')).toBeUndefined();
  });

  test('only admits the exact shared-state database and table, including Windows paths', () => {
    const error = failure(tempDir);
    expect(isOpenClawBindingSchemaFailure(error, tempDir)).toBe(true);
    expect(extractOpenClawBindingSchemaFailure(`${warning}\nError: ${error}\n at openDatabase`, tempDir)).toBe(error);
    expect(isOpenClawBindingSchemaFailure(error.replace('openclaw.sqlite', 'openclaw-agent.sqlite'), tempDir)).toBe(false);
    expect(isOpenClawBindingSchemaFailure(error.replace('current_conversation_bindings', 'sessions'), tempDir)).toBe(false);
    expect(isOpenClawBindingSchemaFailure(failure(path.join(tempDir, 'other')), tempDir)).toBe(false);
    expect(isOpenClawBindingSchemaFailure(warning, tempDir)).toBe(false);
  });

  test('detects the retired field without requiring database access or accepting inherited fields', () => {
    expect(hasLegacyOpenClawDiscovery({ plugins: { bundledDiscovery: 'compat' } })).toBe(true);
    expect(hasLegacyOpenClawDiscovery({ plugins: { bundledDiscovery: null } })).toBe(true);
    expect(hasLegacyOpenClawDiscovery({ plugins: Object.create({ bundledDiscovery: 'compat' }) })).toBe(false);
    for (const config of [null, {}, { plugins: { allow: ['memory-core'] } }]) expect(hasLegacyOpenClawDiscovery(config)).toBe(false);
  });
});

describe('on-demand helper', () => {
  const report = (status: OpenClawStartupMigrationStatus = OpenClawStartupMigrationStatus.Migrated, error?: string) =>
    OPENCLAW_STARTUP_COMPATIBILITY_RESULT_PREFIX + JSON.stringify({ status, error, changes: [], backups: [] });

  function options() {
    fs.writeFileSync(path.join(tempDir, OPENCLAW_STARTUP_COMPATIBILITY_ENTRY), '');
    return {
      stateDir: path.join(tempDir, 'state'), configPath: path.join(tempDir, 'state', 'openclaw.json'),
      runtimeRoot: tempDir, electronNodeRuntimePath: process.execPath,
      env: { OPENCLAW_STATE_DIR: 'wrong', OPENCLAW_HOME: 'wrong', EXISTING: 'kept' },
      mode: OpenClawStartupCompatibilityMode.RepairBindings,
    };
  }

  test('executes only the selected operation with the application state paths', async () => {
    const params = options();
    const runner = vi.fn(async () => ({ code: 0, stdout: report(), stderr: '' }));
    expect(await runOpenClawStartupCompatibility({ ...params, runner })).toEqual({ status: OpenClawStartupMigrationStatus.Migrated });
    expect(runner).toHaveBeenCalledExactlyOnceWith(process.execPath,
      [path.join(tempDir, OPENCLAW_STARTUP_COMPATIBILITY_ENTRY), OpenClawStartupCompatibilityMode.RepairBindings], {
        cwd: tempDir, timeoutMs: 180_000,
        env: {
          EXISTING: 'kept', OPENCLAW_HOME: tempDir, OPENCLAW_STATE_DIR: params.stateDir,
          OPENCLAW_CONFIG_PATH: params.configPath, OPENCLAW_SERVICE_REPAIR_POLICY: 'external', ELECTRON_RUN_AS_NODE: '1',
        },
      });
  });

  test('retains the schema cause when a config import cannot open SQLite', async () => {
    const params = options();
    const error = failure(params.stateDir);
    const runner = vi.fn(async () => ({ code: 1, stdout: report(OpenClawStartupMigrationStatus.Failed, error), stderr: warning }));
    expect(await runOpenClawStartupCompatibility({ ...params, runner })).toEqual({ status: OpenClawStartupMigrationStatus.Failed, error });
  });

  test.each([
    { code: 0, stdout: '', stderr: '' },
    { code: 1, stdout: report(), stderr: '' },
    { code: 0, stdout: OPENCLAW_STARTUP_COMPATIBILITY_RESULT_PREFIX + '{"status":"migrated"}', stderr: '' },
  ])('never reports recovery for incomplete/unsuccessful output: %j', async result => {
    expect((await runOpenClawStartupCompatibility({ ...options(), runner: async () => result })).status)
      .toBe(OpenClawStartupMigrationStatus.Failed);
  });
});
