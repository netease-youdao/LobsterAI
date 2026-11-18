import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { OPENCLAW_REPAIR_ENTRY, OPENCLAW_REPAIR_RESULT_PREFIX, OPENCLAW_REPAIR_SNAPSHOT_MANIFEST, OpenClawRepairPhase, OpenClawRepairStage } from '../../shared/openclawEngine/repair';
import { OPENCLAW_STARTUP_COMPATIBILITY_ENTRY, OPENCLAW_STARTUP_COMPATIBILITY_RESULT_PREFIX, OpenClawStartupCompatibilityMode } from '../../shared/openclawEngine/startupCompatibility';
import { OpenClawStartupMigrationStatus } from '../../shared/openclawEngine/startupMigration';
import {
  createOpenClawRepairBackupDirectory, OPENCLAW_DOCTOR_REPAIR_ARGS, OPENCLAW_REPAIR_BACKUP_MAX_AGE_MS,
  OPENCLAW_REPAIR_BACKUP_RETENTION, pruneOpenClawRepairBackups, runOpenClawCompatibilityRepair, runOpenClawDoctorRepair,
} from './openclawCompatibilityRepair';
import { DiskCleanupStoppedError,DiskCleanupStopReason } from './openclawDiskCleanupThrottle';
import type { StartupMigrationRunner } from './openclawStartupStateMigration';

const directories: string[] = [];
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-repair-process-'));
  directories.push(base);
  const runtimeRoot = path.join(base, 'runtime');
  fs.mkdirSync(runtimeRoot);
  fs.writeFileSync(path.join(runtimeRoot, OPENCLAW_REPAIR_ENTRY), '');
  fs.writeFileSync(path.join(runtimeRoot, OPENCLAW_STARTUP_COMPATIBILITY_ENTRY), '');
  const params = {
    runtimeRoot, stateDir: path.join(base, 'state'), configPath: path.join(base, 'state', 'openclaw.json'),
    electronNodeRuntimePath: '/bundled/electron', backupDir: createOpenClawRepairBackupDirectory(base),
    env: { NODE_OPTIONS: '--require untrusted', NODE_PATH: '/external', OPENCLAW_STATE_DIR: '/other-profile', PATH: '/bundled/shims' },
  };
  completeSnapshot(params);
  return params;
}

function completeSnapshot(params: { stateDir: string; backupDir: string }) {
  fs.mkdirSync(params.stateDir, { recursive: true });
  fs.cpSync(params.stateDir, path.join(params.backupDir, 'original'), { recursive: true });
  fs.writeFileSync(path.join(params.backupDir, OPENCLAW_REPAIR_SNAPSHOT_MANIFEST), JSON.stringify({ version: 1 }));
  fs.writeFileSync(path.join(params.backupDir, `${OpenClawRepairPhase.Snapshot}-report.json`), JSON.stringify({
    phase: OpenClawRepairPhase.Snapshot, success: true,
  }));
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test('Doctor uses the controlled runtime, safe flags and externally managed service policy', async () => {
  const params = fixture();
  const env = { ...params.env, OPENCLAW_GATEWAY_TOKEN: 'profile-gateway-token' };
  const runner = vi.fn<StartupMigrationRunner>().mockResolvedValueOnce(startupResult())
    .mockResolvedValueOnce({ code: 1, stdout: 'partial repair', stderr: 'remaining orphan vectors' });
  expect(await runOpenClawDoctorRepair({ ...params, env, runner })).toEqual({ code: 1 });
  expect(runner).toHaveBeenCalledWith('/bundled/electron', [path.join(params.runtimeRoot, 'openclaw.mjs'), ...OPENCLAW_DOCTOR_REPAIR_ARGS], expect.objectContaining({
    env: {
      PATH: '/bundled/shims', OPENCLAW_HOME: path.dirname(params.stateDir), OPENCLAW_STATE_DIR: params.stateDir,
      OPENCLAW_CONFIG_PATH: params.configPath, ELECTRON_RUN_AS_NODE: '1', OPENCLAW_SERVICE_REPAIR_POLICY: 'external',
      OPENCLAW_GATEWAY_TOKEN: 'profile-gateway-token',
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
  const interruption = Object.assign(new Error('Doctor process timed out'), { killed: true, signal: 'SIGTERM' });
  const runner = vi.fn<StartupMigrationRunner>().mockResolvedValueOnce(startupResult())
    .mockRejectedValueOnce(interruption);
  await expect(runOpenClawDoctorRepair({ ...params, runner }))
    .rejects.toMatchObject({ stage: OpenClawRepairStage.Doctor, message: 'Doctor process timed out', cause: interruption });
});

test('backup directories do not collide on repeated repair requests', () => {
  const params = fixture();
  expect(createOpenClawRepairBackupDirectory(path.dirname(params.stateDir))).not.toBe(params.backupDir);
});

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const runName = (iso: string, suffix = 'aaaaaa') => `${iso.replace(/[:.]/g, '-')}-${suffix}`;
// Runs a pre-fix snapshot would contain: real state plus regenerable caches.
const OLD_SNAPSHOT_FILES = [
  'openclaw.json', 'state/openclaw.sqlite', '.compile-cache/v24.11.1-arm64-e4fd8016-501/data',
  'browser/openclaw/user-data/Default/Cookies', 'browser/openclaw/user-data/Default/IndexedDB/x/CURRENT',
  'browser/openclaw/user-data/Default/Service Worker/CacheStorage/abc/index.txt',
  'browser/openclaw/user-data/Default/Service Worker/Database/CURRENT',
  'browser/openclaw/user-data/Default/GPUCache/data_0', 'browser/openclaw/user-data/GraphiteDawnCache/data_0',
];

function backupRuns(runs: Array<{ name: string; modifiedAt?: number }>) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-repair-prune-'));
  directories.push(base);
  const root = path.join(base, 'repair-backups');
  const paths = runs.map(({ name }) => path.join(root, name));
  for (const run of paths) {
    for (const file of OLD_SNAPSHOT_FILES) {
      const target = path.join(run, 'original', ...file.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file);
    }
  }
  // Set mtimes last: populating a run updates its directory mtime.
  runs.forEach(({ name, modifiedAt }, index) => {
    const time = new Date(modifiedAt ?? Date.parse(name.slice(0, 24).replace(/T(\d{2})-(\d{2})-(\d{2})-/, 'T$1:$2:$3.')));
    fs.utimesSync(paths[index], time, time);
  });
  return { base, root, runs: paths };
}
const existsIn = (run: string, file: string) => fs.existsSync(path.join(run, 'original', ...file.split('/')));

test('pruning keeps the current and newest previous run, ignores foreign entries, and never follows links', async () => {
  const { base, root, runs } = backupRuns(['2026-10-01T00:00:00.000Z', '2026-10-05T00:00:00.000Z', '2026-10-10T00:00:00.000Z', '2026-10-15T00:00:00.000Z']
    .map(iso => ({ name: runName(iso) })));
  fs.mkdirSync(path.join(root, 'user-notes'));
  fs.writeFileSync(path.join(root, 'keep.txt'), '');
  const external = path.join(base, 'external');
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'keep.txt'), 'external');
  fs.symlinkSync(external, path.join(runs[0], 'original', 'link'), 'junction');
  const current = createOpenClawRepairBackupDirectory(base);

  const result = await pruneOpenClawRepairBackups(base, { currentBackupDir: current, now: NOW });

  expect(OPENCLAW_REPAIR_BACKUP_RETENTION).toBe(2);
  expect([...result.removedRuns].sort()).toEqual(runs.slice(0, 3));
  expect(fs.readdirSync(root).sort()).toEqual([path.basename(current), path.basename(runs[3]), 'keep.txt', 'user-notes'].sort());
  expect(fs.readFileSync(path.join(external, 'keep.txt'), 'utf8')).toBe('external');
});

test('pruning removes runs past the age limit, falling back to mtime when the name has no valid time', async () => {
  const { root, base, runs } = backupRuns([
    { name: runName('2026-09-01T00:00:00.000Z') },
    { name: runName('2026-10-15T00:00:00.000Z') },
    { name: '2026-13-01T00-00-00-000Z-oldmtm', modifiedAt: NOW - 40 * DAY_MS },
  ]);
  expect(OPENCLAW_REPAIR_BACKUP_MAX_AGE_MS).toBe(14 * DAY_MS);

  const result = await pruneOpenClawRepairBackups(base, { now: NOW });

  expect([...result.removedRuns].sort()).toEqual([runs[2], runs[0]].sort());
  expect(fs.readdirSync(root)).toEqual([path.basename(runs[1])]);
});

test('pruning keeps a current run whose clock-based name sorts older than the others', async () => {
  const { root, base, runs } = backupRuns(['2026-10-01T00:00:00.000Z', '2026-10-05T00:00:00.000Z', '2026-10-10T00:00:00.000Z', '2026-10-15T00:00:00.000Z']
    .map(iso => ({ name: runName(iso) })));
  const result = await pruneOpenClawRepairBackups(base, { currentBackupDir: runs[0], now: NOW });
  expect([...result.removedRuns].sort()).toEqual(runs.slice(1, 3));
  expect(fs.readdirSync(root).sort()).toEqual([runs[0], runs[3]].map(run => path.basename(run)));
});

test.each([
  ['newest', '2026-10-17T11:55:00.000Z'],
  // A run named before the others (clock moved back) is still recognized as in progress by its mtime.
  ['oldest-named', '2026-01-01T00:00:00.000Z'],
])('a startup prune without a current run never touches an in-progress %s run', async (_name, iso) => {
  const inProgress = { name: runName(iso, 'inprog'), modifiedAt: NOW - 5 * 60 * 1000 };
  const { base, runs } = backupRuns([
    inProgress,
    ...['2026-10-05T00:00:00.000Z', '2026-10-10T00:00:00.000Z', '2026-10-15T00:00:00.000Z'].map(value => ({ name: runName(value) })),
  ]);

  const result = await pruneOpenClawRepairBackups(base, { now: NOW });

  expect([...result.removedRuns].sort()).toEqual(runs.slice(1, 3));
  for (const file of OLD_SNAPSHOT_FILES) expect(existsIn(runs[0], file)).toBe(true);
  expect(existsIn(runs[3], 'openclaw.json')).toBe(true);
});

test('retained runs lose regenerable caches but keep state and site data, and the manifest records it', async () => {
  const { base, runs } = backupRuns([
    { name: runName('2026-10-06T04:42:33.345Z', '4W3ZYj') }, { name: runName('2026-10-04T06:43:26.330Z', 'vRNFCI') },
  ]);
  // Writing the manifest bumps the run's mtime to the real clock, which reads as in progress at NOW; restore it.
  const { mtime } = fs.statSync(runs[0]);
  fs.writeFileSync(path.join(runs[0], OPENCLAW_REPAIR_SNAPSHOT_MANIFEST), JSON.stringify({ version: 1, generatedPluginSkillLinks: [] }));
  fs.utimesSync(runs[0], mtime, mtime);

  const result = await pruneOpenClawRepairBackups(base, { now: NOW });

  expect(result.removedRuns).toEqual([]);
  const regenerable = ['.compile-cache', 'browser/openclaw/user-data/Default/Service Worker/CacheStorage',
    'browser/openclaw/user-data/Default/GPUCache', 'browser/openclaw/user-data/GraphiteDawnCache'];
  expect([...result.strippedPaths].sort()).toEqual(runs.flatMap(run => regenerable.map(item => path.join(run, 'original', ...item.split('/')))).sort());
  for (const run of runs) {
    for (const item of regenerable) expect(existsIn(run, item)).toBe(false);
    for (const file of ['openclaw.json', 'state/openclaw.sqlite', 'browser/openclaw/user-data/Default/Cookies',
      'browser/openclaw/user-data/Default/IndexedDB/x/CURRENT', 'browser/openclaw/user-data/Default/Service Worker/Database/CURRENT']) {
      expect(existsIn(run, file)).toBe(true);
    }
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(runs[0], OPENCLAW_REPAIR_SNAPSHOT_MANIFEST), 'utf8'));
  expect([...manifest.skippedRegenerablePaths].sort()).toEqual(regenerable.map(item => path.join(...item.split('/'))).sort());
  expect((await pruneOpenClawRepairBackups(base, { now: NOW })).strippedPaths).toEqual([]);
});

test('pruning tolerates a missing root and keeps going when one backup cannot be removed', async () => {
  expect(await pruneOpenClawRepairBackups(path.join(os.tmpdir(), 'lobster-absent-repair-base'), { now: NOW }))
    .toEqual({ removedRuns: [], strippedPaths: [] });
  const { base, runs } = backupRuns(['2026-10-01T00:00:00.000Z', '2026-10-05T00:00:00.000Z', '2026-10-10T00:00:00.000Z', '2026-10-15T00:00:00.000Z']
    .map(iso => ({ name: runName(iso) })));
  // A run that is locked (e.g. open in Explorer on Windows) fails at the rename that stages it.
  const rename = fs.promises.rename;
  vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
    if (from === runs[1]) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
    return rename(from, to);
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect((await pruneOpenClawRepairBackups(base, { currentBackupDir: runs[3], now: NOW })).removedRuns).toEqual([runs[0]]);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining(runs[1]), expect.objectContaining({ code: 'EBUSY' }));
  expect(fs.existsSync(runs[1])).toBe(true);
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
  fs.writeFileSync(params.configPath, JSON.stringify({ plugins: { bundledDiscovery: 'compat' } }));
  completeSnapshot(params);
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
  const original = JSON.stringify({ plugins: { bundledDiscovery: 'unsupported' } });
  fs.writeFileSync(params.configPath, original);
  completeSnapshot(params);
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

test('cleans retired keys after backup and before compatibility migration, preserving migration-owned fields', async () => {
  const params = fixture();
  fs.writeFileSync(path.join(params.runtimeRoot, 'openclaw.mjs'), '');
  const plugins = { installs: { demo: { source: 'npm', spec: 'demo@1.0.0' } }, bundledDiscovery: 'compat' };
  const original = { gateway: { reload: { mode: 'hot' } }, session: { maintenance: { rotateBytes: 1000 } }, plugins };
  fs.writeFileSync(params.configPath, JSON.stringify(original));
  completeSnapshot(params);
  const runner = vi.fn<StartupMigrationRunner>().mockImplementation(async (_command, args) => {
    const current = JSON.parse(fs.readFileSync(params.configPath, 'utf8'));
    if (args.includes('validate')) return { code: 1, stderr: '', stdout: JSON.stringify({ valid: false, issues: [
      { path: 'session.maintenance', message: 'Unrecognized key: "rotateBytes"' },
      { path: 'plugins', message: 'Unrecognized keys: "installs", "bundledDiscovery"' },
    ] }) };
    expect(current.session.maintenance).not.toHaveProperty('rotateBytes');
    expect(current.plugins).toEqual(plugins);
    if (args.includes(OpenClawStartupCompatibilityMode.PrepareStartup)) return startupResult();
    return { code: 0, stdout: '', stderr: '' };
  });

  await runOpenClawDoctorRepair({ ...params, runner });

  expect(runner.mock.calls.map(([, args]) => args.slice(1))).toEqual([
    ['config', 'validate', '--json'], ['config', 'validate', '--json'],
    [OpenClawStartupCompatibilityMode.PrepareStartup], [...OPENCLAW_DOCTOR_REPAIR_ARGS],
  ]);
  expect(JSON.parse(fs.readFileSync(path.join(params.backupDir, 'original', 'openclaw.json'), 'utf8'))).toEqual(original);
});

test('an incomplete snapshot stops repair before config validation or Doctor', async () => {
  const params = fixture();
  fs.unlinkSync(path.join(params.backupDir, OPENCLAW_REPAIR_SNAPSHOT_MANIFEST));
  const runner = vi.fn<StartupMigrationRunner>();
  await expect(runOpenClawDoctorRepair({ ...params, runner })).rejects.toMatchObject({ stage: OpenClawRepairStage.Preparation });
  expect(runner).not.toHaveBeenCalled();
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

test('a prune stopped mid-removal resumes later without the partial run taking a retention slot', async () => {
  const { root, base, runs } = backupRuns(['2026-10-15T00:00:00.000Z', '2026-10-10T00:00:00.000Z', '2026-10-05T00:00:00.000Z']
    .map(iso => ({ name: runName(iso) })));
  let steps = 0;
  const stopping = {
    step: async () => {
      steps += 1;
      if (steps === 3) throw new DiskCleanupStoppedError(DiskCleanupStopReason.Budget);
    },
  };

  await expect(pruneOpenClawRepairBackups(base, { now: NOW, throttle: stopping })).rejects.toBeInstanceOf(DiskCleanupStoppedError);
  // The oldest run was renamed aside before removal started, so it no longer looks like a fresh run.
  const staged = `.lobsterai-stale-${path.basename(runs[2])}`;
  expect(fs.readdirSync(root).sort()).toEqual([path.basename(runs[0]), path.basename(runs[1]), staged].sort());

  const resumed = await pruneOpenClawRepairBackups(base, { now: NOW });

  expect(resumed.removedRuns).toEqual([]);
  expect(fs.readdirSync(root).sort()).toEqual([path.basename(runs[0]), path.basename(runs[1])].sort());
  for (const run of runs.slice(0, 2)) expect(existsIn(run, 'state/openclaw.sqlite')).toBe(true);
});
