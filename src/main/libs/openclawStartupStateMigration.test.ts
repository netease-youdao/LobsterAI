import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  OPENCLAW_STARTUP_MIGRATION_ENTRY,
  OPENCLAW_STARTUP_MIGRATION_RESULT_PREFIX,
  OpenClawStartupMigrationOwner,
  type OpenClawStartupMigrationReport,
  OpenClawStartupMigrationStatus,
} from '../../shared/openclawEngine/startupMigration';
import { migrateLegacyStateBeforeStartup } from './openclawStartupStateMigration';

let tempDir: string;
const InventoryFault = {
  MissingOwner: 'missing-owner', WrongTotal: 'wrong-total', UnknownOwner: 'unknown-owner',
} as const;
const report = (overrides: Partial<OpenClawStartupMigrationReport> = {}): string => (
  OPENCLAW_STARTUP_MIGRATION_RESULT_PREFIX + JSON.stringify({
    status: OpenClawStartupMigrationStatus.Migrated,
    sourceCount: 2, changes: ['Migrated workspace setup state to SQLite.'],
    sourceCounts: {
      [OpenClawStartupMigrationOwner.DeviceAuth]: 0,
      [OpenClawStartupMigrationOwner.DeviceIdentity]: 0,
      [OpenClawStartupMigrationOwner.ExecApprovals]: 0,
      [OpenClawStartupMigrationOwner.Workspace]: overrides.sourceCount ?? 2,
    },
    notices: [], warnings: [], remainingPaths: [], ...overrides,
  })
);

describe('state migration before gateway startup', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-workspace-migration-'));
    fs.writeFileSync(path.join(tempDir, OPENCLAW_STARTUP_MIGRATION_ENTRY), '');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function options() {
    return {
      stateDir: path.join(tempDir, 'openclaw', 'state'),
      configPath: path.join(tempDir, 'openclaw', 'state', 'openclaw.json'),
      runtimeRoot: tempDir,
      electronNodeRuntimePath: '/electron/node',
      env: { EXISTING: 'preserved', OPENCLAW_STATE_DIR: '/wrong-state', OPENCLAW_HOME: '/wrong-home' },
    };
  }

  test('runs the focused helper with the gateway state/config and preserves other environment', async () => {
    const runner = vi.fn(async () => ({ code: 0, stdout: `diagnostic line\n${report()}\n`, stderr: '' }));
    const params = options();
    expect(await migrateLegacyStateBeforeStartup({ ...params, runner })).toEqual({
      status: OpenClawStartupMigrationStatus.Migrated,
    });
    expect(runner).toHaveBeenCalledWith('/electron/node', [path.join(tempDir, OPENCLAW_STARTUP_MIGRATION_ENTRY)], {
      cwd: tempDir,
      env: {
        EXISTING: 'preserved', OPENCLAW_HOME: path.dirname(params.stateDir),
        OPENCLAW_STATE_DIR: params.stateDir, OPENCLAW_CONFIG_PATH: params.configPath,
        OPENCLAW_SERVICE_REPAIR_POLICY: 'external', ELECTRON_RUN_AS_NODE: '1',
      },
      timeoutMs: 180_000,
    });
  });

  test('logs the checked inventory without reporting changes on an already migrated installation', async () => {
    const runner = vi.fn(async () => ({
      code: 0, stdout: report({ status: OpenClawStartupMigrationStatus.Skipped, sourceCount: 0, changes: [] }), stderr: '',
    }));
    expect(await migrateLegacyStateBeforeStartup({ ...options(), runner })).toEqual({
      status: OpenClawStartupMigrationStatus.Skipped,
    });
    expect(console.log).toHaveBeenCalledExactlyOnceWith('[OpenClaw] Startup state migration checked:', {
      status: OpenClawStartupMigrationStatus.Skipped,
      sourceCounts: Object.fromEntries(Object.values(OpenClawStartupMigrationOwner).map(owner => [owner, 0])),
    });
  });

  test('logs the quarantine backup when another source prevents startup', async () => {
    const change = 'Quarantined corrupt workspace attestation; backup: /state/workspace-attestation-quarantine/copy.attested.';
    const runner = vi.fn(async () => ({
      code: 1,
      stdout: report({
        status: OpenClawStartupMigrationStatus.Failed,
        changes: [change], warnings: ['Another source is invalid'], remainingPaths: ['/state/other-source'],
      }),
      stderr: '',
    }));
    expect((await migrateLegacyStateBeforeStartup({ ...options(), runner })).status)
      .toBe(OpenClawStartupMigrationStatus.Failed);
    expect(console.log).toHaveBeenCalledWith('[OpenClaw] Startup state migration: ' + change);
  });

  test.each([
    { code: 0, stdout: report({ remainingPaths: ['/workspace/.openclaw/workspace-state.json'] }), stderr: '', expected: 'Unmigrated startup state' },
    { code: 0, stdout: report({ warnings: ['Gateway owns this state directory'] }), stderr: '', expected: 'Gateway owns this state directory' },
    { code: 1, stdout: report({ status: OpenClawStartupMigrationStatus.Failed, warnings: ['legacy workspace setup contains invalid JSON'] }), stderr: '', expected: 'invalid JSON' },
    { code: 1, stdout: report(), stderr: '', expected: 'exit code 1' },
    { code: 0, stdout: '', stderr: '', expected: 'verified completion' },
    { code: 0, stdout: OPENCLAW_STARTUP_MIGRATION_RESULT_PREFIX + '{}', stderr: '', expected: 'verified completion' },
    { code: 1, stdout: '', stderr: 'Cannot find package dependency', expected: 'Cannot find package dependency' },
  ])('blocks unverified migration: $expected', async ({ expected, ...result }) => {
    const runner = vi.fn(async () => result);
    expect(await migrateLegacyStateBeforeStartup({ ...options(), runner })).toEqual({
      status: OpenClawStartupMigrationStatus.Failed, error: expect.stringContaining(expected),
    });
  });

  test('fails when an old runtime lacks the helper', async () => {
    fs.unlinkSync(path.join(tempDir, OPENCLAW_STARTUP_MIGRATION_ENTRY));
    const runner = vi.fn();
    expect(await migrateLegacyStateBeforeStartup({ ...options(), runner })).toEqual({
      status: OpenClawStartupMigrationStatus.Failed, error: expect.stringContaining('helper is missing'),
    });
    expect(runner).not.toHaveBeenCalled();
  });

  test('keeps process/timeout errors retryable', async () => {
    const runner = vi.fn(async () => { throw new Error('migration timed out'); });
    expect(await migrateLegacyStateBeforeStartup({ ...options(), runner })).toEqual({
      status: OpenClawStartupMigrationStatus.Failed, error: 'migration timed out',
    });
  });

  test.each(Object.values(InventoryFault))('rejects an incomplete migration inventory: %s', async (fault) => {
    const incomplete = JSON.parse(report().slice(OPENCLAW_STARTUP_MIGRATION_RESULT_PREFIX.length));
    if (fault === InventoryFault.MissingOwner) delete incomplete.sourceCounts[OpenClawStartupMigrationOwner.DeviceIdentity];
    if (fault === InventoryFault.WrongTotal) incomplete.sourceCount++;
    if (fault === InventoryFault.UnknownOwner) incomplete.sourceCounts.unknown = 0;
    const runner = vi.fn(async () => ({ code: 0,
      stdout: OPENCLAW_STARTUP_MIGRATION_RESULT_PREFIX + JSON.stringify(incomplete), stderr: '' }));
    expect((await migrateLegacyStateBeforeStartup({ ...options(), runner })).status).toBe(OpenClawStartupMigrationStatus.Failed);
  });
});
