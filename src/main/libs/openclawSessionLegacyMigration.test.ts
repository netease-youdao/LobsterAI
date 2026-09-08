import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  type LegacySessionMigrationRunner,
  listLegacySessionStorePaths,
  migrateLegacySessionStorageWithDoctor,
} from './openclawSessionLegacyMigration';

let tempDir = '';
let stateDir = '';
let runtimeRoot = '';
let configPath = '';

function writeFile(filePath: string, content = '{}\n'): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

describe('openclawSessionLegacyMigration', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-openclaw-session-migration-'));
    stateDir = path.join(tempDir, 'openclaw', 'state');
    runtimeRoot = path.join(tempDir, 'runtime');
    configPath = path.join(stateDir, 'openclaw.json');
    writeFile(path.join(runtimeRoot, 'openclaw.mjs'), 'console.log("openclaw");\n');
    writeFile(configPath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('skips when no legacy session stores exist', async () => {
    const runner = vi.fn<LegacySessionMigrationRunner>();

    const result = await migrateLegacySessionStorageWithDoctor({
      stateDir,
      configPath,
      runtimeRoot,
      electronNodeRuntimePath: process.execPath,
      env: {},
      runner,
    });

    expect(result).toEqual({ status: 'skipped', reason: 'no-legacy-session-files' });
    expect(runner).not.toHaveBeenCalled();
  });

  test('discovers shared and per-agent default legacy stores', () => {
    const sharedPath = path.join(stateDir, 'sessions', 'sessions.json');
    const mainPath = path.join(stateDir, 'agents', 'main', 'sessions', 'sessions.json');
    const workerPath = path.join(stateDir, 'agents', 'worker', 'sessions', 'sessions.json');
    writeFile(sharedPath);
    writeFile(mainPath);
    writeFile(workerPath);

    expect(listLegacySessionStorePaths(stateDir)).toEqual([sharedPath, mainPath, workerPath]);
  });

  test('runs official doctor with the same state and config then verifies migration', async () => {
    const legacyPath = path.join(stateDir, 'agents', 'main', 'sessions', 'sessions.json');
    writeFile(legacyPath, '{"agent:main:main":{"sessionId":"existing"}}\n');
    const runner = vi.fn<LegacySessionMigrationRunner>().mockImplementation(async () => {
      fs.renameSync(legacyPath, `${legacyPath}.migrated`);
      return { code: 0, stdout: 'migrated', stderr: '' };
    });

    const result = await migrateLegacySessionStorageWithDoctor({
      stateDir,
      configPath,
      runtimeRoot,
      electronNodeRuntimePath: process.execPath,
      env: { EXISTING: '1' },
      runner,
    });

    expect(result).toEqual({ status: 'migrated', code: 0, migratedPaths: [legacyPath] });
    expect(runner).toHaveBeenCalledTimes(1);
    const [command, args, options] = runner.mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(args).toEqual([
      path.join(runtimeRoot, 'openclaw.mjs'),
      'doctor',
      '--session-sqlite',
      'import',
      '--session-sqlite-all-agents',
      '--json',
    ]);
    expect(options.cwd).toBe(runtimeRoot);
    expect(options.env.EXISTING).toBe('1');
    expect(options.env.OPENCLAW_HOME).toBe(path.dirname(stateDir));
    expect(options.env.OPENCLAW_STATE_DIR).toBe(stateDir);
    expect(options.env.OPENCLAW_CONFIG_PATH).toBe(configPath);
    expect(options.env.OPENCLAW_SERVICE_REPAIR_POLICY).toBe('external');
    expect(options.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  test('surfaces the doctor cause before long config warnings without hiding diagnostic logs', async () => {
    writeFile(path.join(stateDir, 'agents', 'main', 'sessions', 'sessions.json'));
    const warning = `[config] warnings: ${'duplicate plugin id; '.repeat(300)}`;
    const cause = "Cannot find package 'openclaw' imported from /runtime/discord/dist/owner-access.js";
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runner = vi.fn<LegacySessionMigrationRunner>().mockResolvedValue({
      code: 1,
      stdout: 'Earlier memory migration completed.',
      stderr: `${warning}\n${cause}\n    at packageResolve (node:internal/modules/esm/resolve:762:9)\n`,
    });

    const result = await migrateLegacySessionStorageWithDoctor({
      stateDir, configPath, runtimeRoot, electronNodeRuntimePath: process.execPath, env: {}, runner,
    });

    expect(result).toMatchObject({ code: 1, error: expect.stringContaining(cause) });
    if (!('error' in result)) throw new Error('Expected migration failure');
    expect(result.error.slice(0, 500)).toContain(cause);
    expect(result.error).not.toContain('duplicate plugin id');
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('duplicate plugin id'));
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('Earlier memory migration completed.'));
  });

  test('keeps a useful failure when doctor emits only warnings', async () => {
    writeFile(path.join(stateDir, 'agents', 'main', 'sessions', 'sessions.json'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const runner = vi.fn<LegacySessionMigrationRunner>().mockResolvedValue({
      code: 1, stdout: '', stderr: '[config] warnings: duplicate plugin id\n',
    });

    const result = await migrateLegacySessionStorageWithDoctor({
      stateDir, configPath, runtimeRoot, electronNodeRuntimePath: process.execPath, env: {}, runner,
    });

    expect(result).toMatchObject({
      code: 1,
      error: 'OpenClaw legacy session migration failed with exit code 1.',
    });
  });

  test.each(['│', '|'])('reports wrapped stdout validation errors with %s borders', async (border) => {
    writeFile(path.join(stateDir, 'agents', 'main', 'sessions', 'sessions.json'));
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runner = vi.fn<LegacySessionMigrationRunner>().mockResolvedValue({
      code: 1,
      stderr: 'Config clobber snapshot cap reached: rotating oldest snapshots.\n',
      stdout: [
        '│ Doctor could not apply config fixes: the repaired config still fails │',
        '│ validation. │',
        "│ - channels.qqbot.allowFrom: invalid config for plugin qqbot: must have │",
        "│   required property 'allowFrom' │",
        '│ - channels.qqbot.accounts: invalid config for plugin qqbot: must not │',
        '│   be valid │',
        '│ No config changes were written. │',
      ].join('\n').replaceAll('│', border),
    });
    const result = await migrateLegacySessionStorageWithDoctor({
      stateDir, configPath, runtimeRoot, electronNodeRuntimePath: process.execPath, env: {}, runner,
    });
    expect(result).toMatchObject({
      status: 'failed', code: 1,
      error: expect.stringContaining("channels.qqbot.allowFrom: invalid config for plugin qqbot: must have required property 'allowFrom'"),
    });
    if (!('error' in result)) throw new Error('Expected migration failure');
    expect(result.error).not.toContain('snapshot');
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('rotating oldest snapshots'));
  });

  test('surfaces structured session import issues', async () => {
    writeFile(path.join(stateDir, 'agents', 'main', 'sessions', 'sessions.json'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const runner = vi.fn<LegacySessionMigrationRunner>().mockResolvedValue({
      code: 1, stderr: '',
      stdout: JSON.stringify({ targets: [{ agentId: 'main', issues: [{ message: 'Transcript validation failed' }] }] }),
    });
    const result = await migrateLegacySessionStorageWithDoctor({
      stateDir, configPath, runtimeRoot, electronNodeRuntimePath: process.execPath, env: {}, runner,
    });
    expect(result).toMatchObject({
      status: 'failed', error: expect.stringContaining('main: Transcript validation failed'),
    });
  });

  test('fails closed when doctor exits successfully but leaves the legacy store', async () => {
    const legacyPath = path.join(stateDir, 'agents', 'main', 'sessions', 'sessions.json');
    writeFile(legacyPath);
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runner = vi.fn<LegacySessionMigrationRunner>().mockResolvedValue({
      code: 0,
      stdout: 'A legacy store was retained by doctor.',
      stderr: '',
    });

    const result = await migrateLegacySessionStorageWithDoctor({
      stateDir,
      configPath,
      runtimeRoot,
      electronNodeRuntimePath: process.execPath,
      env: {},
      runner,
    });

    expect(result).toEqual({
      status: 'failed',
      code: 0,
      error: 'OpenClaw doctor completed but 1 legacy session store(s) remain.',
    });
    expect(fs.existsSync(legacyPath)).toBe(true);
    expect(logError).toHaveBeenCalledWith(expect.stringContaining(JSON.stringify(legacyPath)));
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('modifiedAt'));
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('A legacy store was retained by doctor.'));
  });

  test('records lock owner and residual stores when doctor reports contention', async () => {
    const legacyPath = path.join(stateDir, 'agents', 'main', 'sessions', 'sessions.json');
    writeFile(legacyPath);
    const lockPayload = JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() });
    writeFile(`${configPath}.lock`, lockPayload);
    const logWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = vi.fn<LegacySessionMigrationRunner>().mockResolvedValue({
      code: 1, stdout: '', stderr: `file lock timeout for ${configPath}`,
    });
    const result = await migrateLegacySessionStorageWithDoctor({
      stateDir, configPath, runtimeRoot, electronNodeRuntimePath: process.execPath, env: {}, runner,
    });
    expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('file lock timeout') });
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining(`"ownerPid":${process.pid}`));
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('"ownerAlive":true'));
    expect(fs.readFileSync(`${configPath}.lock`, 'utf8')).toBe(lockPayload);
    expect(fs.existsSync(legacyPath)).toBe(true);
  });

  test('does not run when the bundled OpenClaw CLI is missing', async () => {
    fs.rmSync(path.join(runtimeRoot, 'openclaw.mjs'));
    writeFile(path.join(stateDir, 'agents', 'main', 'sessions', 'sessions.json'));
    const runner = vi.fn<LegacySessionMigrationRunner>();

    const result = await migrateLegacySessionStorageWithDoctor({
      stateDir,
      configPath,
      runtimeRoot,
      electronNodeRuntimePath: process.execPath,
      env: {},
      runner,
    });

    expect(result).toEqual({ status: 'skipped', reason: 'missing-openclaw-cli' });
    expect(runner).not.toHaveBeenCalled();
  });
});
