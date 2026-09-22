import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { OPENCLAW_REPAIR_ENTRY, OPENCLAW_REPAIR_RESULT_PREFIX, OpenClawRepairPhase, OpenClawRepairStage } from '../../shared/openclawEngine/repair';
import { OPENCLAW_STARTUP_COMPATIBILITY_ENTRY, OPENCLAW_STARTUP_COMPATIBILITY_RESULT_PREFIX, OpenClawStartupCompatibilityMode } from '../../shared/openclawEngine/startupCompatibility';
import { OpenClawStartupMigrationStatus } from '../../shared/openclawEngine/startupMigration';
import { createOpenClawRepairBackupDirectory, OPENCLAW_DOCTOR_REPAIR_ARGS, runOpenClawCompatibilityRepair, runOpenClawDoctorRepair } from './openclawCompatibilityRepair';
import type { StartupMigrationRunner } from './openclawStartupStateMigration';

const directories: string[] = [];
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-repair-process-'));
  directories.push(base);
  const runtimeRoot = path.join(base, 'runtime');
  fs.mkdirSync(runtimeRoot);
  fs.writeFileSync(path.join(runtimeRoot, OPENCLAW_REPAIR_ENTRY), '');
  fs.writeFileSync(path.join(runtimeRoot, OPENCLAW_STARTUP_COMPATIBILITY_ENTRY), '');
  return {
    runtimeRoot, stateDir: path.join(base, 'state'), configPath: path.join(base, 'state', 'openclaw.json'),
    electronNodeRuntimePath: '/bundled/electron', backupDir: createOpenClawRepairBackupDirectory(base),
    env: { NODE_OPTIONS: '--require untrusted', NODE_PATH: '/external', OPENCLAW_STATE_DIR: '/other-profile', PATH: '/bundled/shims' },
  };
}
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test('Doctor uses the controlled runtime, safe flags and externally managed service policy', async () => {
  const params = fixture();
  const runner = vi.fn<StartupMigrationRunner>().mockResolvedValueOnce(startupResult())
    .mockResolvedValueOnce({ code: 1, stdout: 'partial repair', stderr: 'remaining orphan vectors' });
  expect(await runOpenClawDoctorRepair({ ...params, runner })).toEqual({ code: 1 });
  expect(runner).toHaveBeenCalledWith('/bundled/electron', [path.join(params.runtimeRoot, 'openclaw.mjs'), ...OPENCLAW_DOCTOR_REPAIR_ARGS], expect.objectContaining({
    env: {
      PATH: '/bundled/shims', OPENCLAW_HOME: path.dirname(params.stateDir), OPENCLAW_STATE_DIR: params.stateDir,
      OPENCLAW_CONFIG_PATH: params.configPath, ELECTRON_RUN_AS_NODE: '1', OPENCLAW_SERVICE_REPAIR_POLICY: 'external',
    },
  }));
  expect(fs.readFileSync(path.join(params.backupDir, 'doctor.log'), 'utf8')).toContain('remaining orphan vectors');
  expect(runner.mock.calls[0][1]).toEqual([
    path.join(params.runtimeRoot, OPENCLAW_STARTUP_COMPATIBILITY_ENTRY), OpenClawStartupCompatibilityMode.PrepareStartup,
  ]);
});

test('exit zero alone or an invalid phase cannot certify repair completion', async () => {
  const params = fixture();
  const runner: StartupMigrationRunner = async () => ({ code: 0, stdout: 'done', stderr: '' });
  await expect(runOpenClawCompatibilityRepair({ ...params, phase: OpenClawRepairPhase.Recovery, runner })).rejects.toThrow('verified completion');
  const wrongPhase: StartupMigrationRunner = async () => ({ code: 0, stdout: OPENCLAW_REPAIR_RESULT_PREFIX + JSON.stringify({
    success: true, phase: OpenClawRepairPhase.Snapshot, changes: [], backups: [],
  }), stderr: '' });
  await expect(runOpenClawCompatibilityRepair({ ...params, phase: OpenClawRepairPhase.Recovery, runner: wrongPhase })).rejects.toThrow('verified completion');
});

test('structured failure takes precedence over unrelated plugin warnings', async () => {
  const params = fixture();
  const runner: StartupMigrationRunner = async () => ({ code: 1, stdout: OPENCLAW_REPAIR_RESULT_PREFIX + JSON.stringify({
    success: false, phase: OpenClawRepairPhase.Recovery, changes: [], backups: [], error: 'Unsupported database schema',
  }), stderr: 'Config warnings: duplicate plugin ID' });
  await expect(runOpenClawCompatibilityRepair({ ...params, phase: OpenClawRepairPhase.Recovery, runner })).rejects.toThrow('Unsupported database schema');
});

test('snapshot failure preserves its phase and source path for the UI', async () => {
  const params = fixture();
  const failurePath = path.join(params.stateDir, 'agents', 'main', 'agent', 'openclaw-agent.sqlite');
  const runner: StartupMigrationRunner = async () => ({ code: 1, stderr: '', stdout: OPENCLAW_REPAIR_RESULT_PREFIX + JSON.stringify({
    phase: OpenClawRepairPhase.Snapshot, success: false, changes: [], backups: [], failurePath, error: 'SQLITE_CORRUPT',
  }) });
  await expect(runOpenClawCompatibilityRepair({ ...params, phase: OpenClawRepairPhase.Snapshot, runner }))
    .rejects.toMatchObject({ stage: OpenClawRepairStage.Snapshot, failurePath, message: 'SQLITE_CORRUPT' });
});

test('an interrupted Doctor retains its own stage', async () => {
  const params = fixture();
  const runner = vi.fn<StartupMigrationRunner>().mockResolvedValueOnce(startupResult())
    .mockRejectedValueOnce(new Error('Doctor process timed out'));
  await expect(runOpenClawDoctorRepair({ ...params, runner }))
    .rejects.toMatchObject({ stage: OpenClawRepairStage.Doctor, message: 'Doctor process timed out' });
});

test('backup directories do not collide on repeated repair requests', () => {
  const params = fixture();
  expect(createOpenClawRepairBackupDirectory(path.dirname(params.stateDir))).not.toBe(params.backupDir);
});

function bindingFailure(stateDir: string): string {
  return `SQLite schema is incomplete or noncanonical for ${path.join(stateDir, 'state', 'openclaw.sqlite')}: column definitions differ for current_conversation_bindings`;
}

function startupResult(error?: string) {
  return { code: error ? 1 : 0, stderr: '', stdout: OPENCLAW_STARTUP_COMPATIBILITY_RESULT_PREFIX + JSON.stringify({
    status: error ? OpenClawStartupMigrationStatus.Failed : OpenClawStartupMigrationStatus.Migrated,
    changes: [], backups: [], error,
  }) };
}

function recoveryResult(error?: string) {
  return { code: error ? 1 : 0, stderr: '', stdout: OPENCLAW_REPAIR_RESULT_PREFIX + JSON.stringify({
    phase: OpenClawRepairPhase.Recovery, success: !error, changes: [], backups: [], error,
  }) };
}

test.each([false, true])('discovery is migrated before Doctor can remove its source, with binding drift=%s', async (bindingDrift) => {
  const params = fixture();
  fs.mkdirSync(params.stateDir);
  fs.writeFileSync(params.configPath, JSON.stringify({ plugins: { bundledDiscovery: 'compat' } }));
  const runner = vi.fn<StartupMigrationRunner>();
  if (bindingDrift) runner.mockResolvedValueOnce(startupResult(bindingFailure(params.stateDir)))
    .mockResolvedValueOnce(startupResult());
  runner.mockResolvedValueOnce(startupResult()).mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });

  expect(await runOpenClawDoctorRepair({ ...params, runner })).toEqual({ code: 0 });

  const migration = [path.join(params.runtimeRoot, OPENCLAW_STARTUP_COMPATIBILITY_ENTRY), OpenClawStartupCompatibilityMode.PrepareStartup];
  const bindings = [path.join(params.runtimeRoot, OPENCLAW_STARTUP_COMPATIBILITY_ENTRY), OpenClawStartupCompatibilityMode.RepairBindings];
  expect(runner.mock.calls.map(([, args]) => args)).toEqual([
    ...(bindingDrift ? [migration, bindings] : []), migration,
    [path.join(params.runtimeRoot, 'openclaw.mjs'), ...OPENCLAW_DOCTOR_REPAIR_ARGS],
  ]);
  for (const [, , options] of runner.mock.calls) {
    expect(options.env.NODE_OPTIONS).toBeUndefined();
    expect(options.env.NODE_PATH).toBeUndefined();
    expect(options.env.OPENCLAW_STATE_DIR).toBe(params.stateDir);
  }
});

test('unverified discovery migration keeps its config source and does not run Doctor', async () => {
  const params = fixture();
  fs.mkdirSync(params.stateDir);
  const original = JSON.stringify({ plugins: { bundledDiscovery: 'unsupported' } });
  fs.writeFileSync(params.configPath, original);
  const runner = vi.fn<StartupMigrationRunner>().mockResolvedValue(startupResult('Unsupported discovery mode'));

  await expect(runOpenClawDoctorRepair({ ...params, runner })).rejects.toThrow('Unsupported discovery mode');

  expect(runner).toHaveBeenCalledTimes(1);
  expect(fs.readFileSync(params.configPath, 'utf8')).toBe(original);
  expect(fs.existsSync(path.join(params.backupDir, 'doctor-result.json'))).toBe(false);
});

test('a schema migration failure stops Doctor even without legacy discovery config', async () => {
  const params = fixture();
  const runner = vi.fn<StartupMigrationRunner>().mockResolvedValue(startupResult('Shared-state snapshot failed'));
  await expect(runOpenClawDoctorRepair({ ...params, runner })).rejects.toThrow('Shared-state snapshot failed');
  expect(runner).toHaveBeenCalledTimes(1);
  expect(fs.existsSync(path.join(params.backupDir, 'doctor-result.json'))).toBe(false);
});

test('full recovery repairs recognized binding drift and re-verifies before reporting success', async () => {
  const params = fixture();
  const runner = vi.fn<StartupMigrationRunner>()
    .mockResolvedValueOnce(recoveryResult(bindingFailure(params.stateDir)))
    .mockResolvedValueOnce(startupResult())
    .mockResolvedValueOnce(recoveryResult());

  await expect(runOpenClawCompatibilityRepair({ ...params, phase: OpenClawRepairPhase.Recovery, runner }))
    .resolves.toMatchObject({ success: true, phase: OpenClawRepairPhase.Recovery });

  expect(runner).toHaveBeenCalledTimes(3);
  expect(runner.mock.calls[1][1]).toEqual([
    path.join(params.runtimeRoot, OPENCLAW_STARTUP_COMPATIBILITY_ENTRY), OpenClawStartupCompatibilityMode.RepairBindings,
  ]);
  expect(runner.mock.calls[2][1]).toEqual(runner.mock.calls[0][1]);
});

test.each([
  { name: 'a different database', otherDatabase: true, otherTable: false, repeat: false, helperError: undefined },
  { name: 'a different table', otherDatabase: false, otherTable: true, repeat: false, helperError: undefined },
  { name: 'a repeated failure', otherDatabase: false, otherTable: false, repeat: true, helperError: undefined },
  { name: 'a helper failure', otherDatabase: false, otherTable: false, repeat: false, helperError: 'Unknown binding columns' },
])('full recovery stops on $name', async ({ otherDatabase, otherTable, repeat, helperError }) => {
  const params = fixture();
  const matching = bindingFailure(params.stateDir);
  const error = otherDatabase ? bindingFailure(path.join(params.stateDir, 'other'))
    : otherTable ? matching.replace('current_conversation_bindings', 'sessions') : matching;
  const runner = vi.fn<StartupMigrationRunner>().mockResolvedValueOnce(recoveryResult(error));
  if (repeat) runner.mockResolvedValueOnce(startupResult()).mockResolvedValueOnce(recoveryResult(error));
  if (helperError) runner.mockResolvedValueOnce(startupResult(helperError));

  await expect(runOpenClawCompatibilityRepair({ ...params, phase: OpenClawRepairPhase.Recovery, runner }))
    .rejects.toThrow(helperError ?? error);
  expect(runner).toHaveBeenCalledTimes(repeat ? 3 : helperError ? 2 : 1);
});
