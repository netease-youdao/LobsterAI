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
      '--non-interactive',
      '--fix',
    ]);
    expect(options.cwd).toBe(runtimeRoot);
    expect(options.env.EXISTING).toBe('1');
    expect(options.env.OPENCLAW_HOME).toBe(path.dirname(stateDir));
    expect(options.env.OPENCLAW_STATE_DIR).toBe(stateDir);
    expect(options.env.OPENCLAW_CONFIG_PATH).toBe(configPath);
    expect(options.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  test('fails closed when doctor exits successfully but leaves the legacy store', async () => {
    const legacyPath = path.join(stateDir, 'agents', 'main', 'sessions', 'sessions.json');
    writeFile(legacyPath);
    const runner = vi.fn<LegacySessionMigrationRunner>().mockResolvedValue({
      code: 0,
      stdout: '',
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
