import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  hasLegacyCronStorage,
  type LegacyCronMigrationRunner,
  migrateLegacyCronStorageWithDoctor,
  resolveLegacyCronStorePath,
} from './openclawCronLegacyMigration';

let tmpDir = '';
let stateDir = '';
let runtimeRoot = '';
let electronNodeRuntimePath = '';

function mkdirp(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function writeFile(filePath: string, content: string): void {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
}

describe('openclawCronLegacyMigration', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-openclaw-cron-migration-'));
    stateDir = path.join(tmpDir, 'openclaw', 'state');
    runtimeRoot = path.join(tmpDir, 'runtime');
    electronNodeRuntimePath = process.execPath;
    mkdirp(runtimeRoot);
    writeFile(path.join(runtimeRoot, 'openclaw.mjs'), 'console.log("openclaw");\n');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('skips when no legacy cron storage exists', async () => {
    const runner = vi.fn<LegacyCronMigrationRunner>();

    expect(hasLegacyCronStorage(stateDir)).toBe(false);

    const result = await migrateLegacyCronStorageWithDoctor({
      stateDir,
      runtimeRoot,
      electronNodeRuntimePath,
      env: {},
      runner,
    });

    expect(result).toEqual({ status: 'skipped', reason: 'no-legacy-cron-files' });
    expect(runner).not.toHaveBeenCalled();
  });

  test('runs official doctor fix when jobs.json exists', async () => {
    writeFile(resolveLegacyCronStorePath(stateDir), '{"version":1,"jobs":[]}\n');
    const runner = vi.fn<LegacyCronMigrationRunner>().mockResolvedValue({
      code: 0,
      stdout: 'ok',
      stderr: '',
    });

    const result = await migrateLegacyCronStorageWithDoctor({
      stateDir,
      runtimeRoot,
      electronNodeRuntimePath,
      env: { EXISTING: '1' },
      runner,
    });

    expect(result).toEqual({ status: 'migrated', code: 0 });
    expect(runner).toHaveBeenCalledTimes(1);
    const [command, args, options] = runner.mock.calls[0];
    expect(command).toBe(electronNodeRuntimePath);
    expect(args).toEqual([
      path.join(runtimeRoot, 'openclaw.mjs'),
      'doctor',
      '--non-interactive',
      '--fix',
    ]);
    expect(options.cwd).toBe(runtimeRoot);
    expect(options.timeoutMs).toBeGreaterThan(0);
    expect(options.env.EXISTING).toBe('1');
    expect(options.env.OPENCLAW_HOME).toBe(path.dirname(stateDir));
    expect(options.env.OPENCLAW_STATE_DIR).toBe(stateDir);
    expect(options.env.OPENCLAW_CONFIG_PATH).toBe(path.join(stateDir, '.lobsterai-cron-doctor-openclaw.json'));
    expect(options.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(JSON.parse(fs.readFileSync(options.env.OPENCLAW_CONFIG_PATH ?? '', 'utf8'))).toEqual({
      gateway: { mode: 'local' },
      cron: {
        enabled: true,
        store: resolveLegacyCronStorePath(stateDir),
      },
    });
  });

  test('runs doctor when only legacy run logs exist', async () => {
    writeFile(path.join(stateDir, 'cron', 'runs', 'job-1.jsonl'), '{"status":"ok"}\n');
    const runner = vi.fn<LegacyCronMigrationRunner>().mockResolvedValue({
      code: 0,
      stdout: '',
      stderr: '',
    });

    expect(hasLegacyCronStorage(stateDir)).toBe(true);

    const result = await migrateLegacyCronStorageWithDoctor({
      stateDir,
      runtimeRoot,
      electronNodeRuntimePath,
      env: {},
      runner,
    });

    expect(result).toEqual({ status: 'migrated', code: 0 });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  test('skips when legacy files exist but bundled OpenClaw CLI is missing', async () => {
    fs.rmSync(path.join(runtimeRoot, 'openclaw.mjs'), { force: true });
    writeFile(resolveLegacyCronStorePath(stateDir), '{"version":1,"jobs":[]}\n');
    const runner = vi.fn<LegacyCronMigrationRunner>();

    const result = await migrateLegacyCronStorageWithDoctor({
      stateDir,
      runtimeRoot,
      electronNodeRuntimePath,
      env: {},
      runner,
    });

    expect(result).toEqual({ status: 'skipped', reason: 'missing-openclaw-cli' });
    expect(runner).not.toHaveBeenCalled();
  });

  test('returns failed when doctor exits non-zero', async () => {
    writeFile(resolveLegacyCronStorePath(stateDir), '{"version":1,"jobs":[]}\n');
    const runner = vi.fn<LegacyCronMigrationRunner>().mockResolvedValue({
      code: 2,
      stdout: 'preview',
      stderr: 'failed',
    });

    const result = await migrateLegacyCronStorageWithDoctor({
      stateDir,
      runtimeRoot,
      electronNodeRuntimePath,
      env: {},
      runner,
    });

    expect(result).toEqual({ status: 'failed', code: 2 });
  });

  test('archives legacy cron files after successful doctor run', async () => {
    const storePath = resolveLegacyCronStorePath(stateDir);
    const statePath = path.join(stateDir, 'cron', 'jobs-state.json');
    const runLogPath = path.join(stateDir, 'cron', 'runs', 'job-1.jsonl');
    writeFile(storePath, '{"version":1,"jobs":[{"id":"job-1"}]}\n');
    writeFile(statePath, '{"job-1":{}}\n');
    writeFile(runLogPath, '{"status":"ok"}\n');
    const runner = vi.fn<LegacyCronMigrationRunner>().mockResolvedValue({
      code: 0,
      stdout: '',
      stderr: '',
    });

    const result = await migrateLegacyCronStorageWithDoctor({
      stateDir,
      runtimeRoot,
      electronNodeRuntimePath,
      env: {},
      runner,
    });

    expect(result).toEqual({ status: 'migrated', code: 0 });
    expect(fs.existsSync(storePath)).toBe(false);
    expect(fs.existsSync(statePath)).toBe(false);
    expect(fs.existsSync(runLogPath)).toBe(false);
    expect(fs.readFileSync(`${storePath}.migrated`, 'utf8')).toBe('{"version":1,"jobs":[{"id":"job-1"}]}\n');
    expect(fs.readFileSync(`${statePath}.migrated`, 'utf8')).toBe('{"job-1":{}}\n');
    expect(fs.readFileSync(`${runLogPath}.migrated`, 'utf8')).toBe('{"status":"ok"}\n');
    expect(hasLegacyCronStorage(stateDir)).toBe(false);

    const rerun = await migrateLegacyCronStorageWithDoctor({
      stateDir,
      runtimeRoot,
      electronNodeRuntimePath,
      env: {},
      runner,
    });

    expect(rerun).toEqual({ status: 'skipped', reason: 'no-legacy-cron-files' });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  test('keeps legacy cron files when doctor fails', async () => {
    const storePath = resolveLegacyCronStorePath(stateDir);
    writeFile(storePath, '{"version":1,"jobs":[]}\n');
    const runner = vi.fn<LegacyCronMigrationRunner>().mockResolvedValue({
      code: 2,
      stdout: '',
      stderr: 'failed',
    });

    await migrateLegacyCronStorageWithDoctor({
      stateDir,
      runtimeRoot,
      electronNodeRuntimePath,
      env: {},
      runner,
    });

    expect(fs.existsSync(storePath)).toBe(true);
    expect(hasLegacyCronStorage(stateDir)).toBe(true);
  });

  test('does not clobber an existing archive from a previous migration', async () => {
    const storePath = resolveLegacyCronStorePath(stateDir);
    writeFile(`${storePath}.migrated`, 'earlier archive\n');
    writeFile(storePath, '{"version":1,"jobs":[{"id":"job-2"}]}\n');
    const runner = vi.fn<LegacyCronMigrationRunner>().mockResolvedValue({
      code: 0,
      stdout: '',
      stderr: '',
    });

    const result = await migrateLegacyCronStorageWithDoctor({
      stateDir,
      runtimeRoot,
      electronNodeRuntimePath,
      env: {},
      runner,
    });

    expect(result).toEqual({ status: 'migrated', code: 0 });
    expect(fs.existsSync(storePath)).toBe(false);
    expect(fs.readFileSync(`${storePath}.migrated`, 'utf8')).toBe('earlier archive\n');
    const fallbackArchives = fs.readdirSync(path.join(stateDir, 'cron'))
      .filter((name) => name.startsWith('jobs.json.migrated-'));
    expect(fallbackArchives).toHaveLength(1);
    expect(fs.readFileSync(path.join(stateDir, 'cron', fallbackArchives[0]), 'utf8'))
      .toBe('{"version":1,"jobs":[{"id":"job-2"}]}\n');
  });
});
