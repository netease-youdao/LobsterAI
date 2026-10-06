import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  migrateLegacyOpenClawPluginInstalls,
  OpenClawPluginInstallMigrationStatus,
  runOpenClawPluginInstallMigrationProcess,
} from './openclawPluginInstallMigration';

describe('migrateLegacyOpenClawPluginInstalls', () => {
  let tempDir: string;
  let stateDir: string;
  let configPath: string;
  let runtimeRoot: string;

  const legacyConfig = {
    gateway: { mode: 'local' },
    plugins: {
      entries: { demo: { enabled: true } },
      installs: {
        demo: {
          source: 'npm',
          spec: 'demo@1.0.0',
          installPath: '/plugins/demo',
        },
      },
    },
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-plugin-install-migration-'));
    stateDir = path.join(tempDir, 'openclaw', 'state');
    configPath = path.join(stateDir, 'openclaw.json');
    runtimeRoot = path.join(tempDir, 'runtime');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, 'openclaw.mjs'), '', 'utf8');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const writeLegacyConfig = (): string => {
    const raw = `${JSON.stringify(legacyConfig, null, 2)}\n`;
    fs.writeFileSync(configPath, raw, { encoding: 'utf8', mode: 0o600 });
    return raw;
  };

  test('uses the official config unset write path and continues only after the key is removed', async () => {
    writeLegacyConfig();
    const runner = vi.fn(async (command: string, args: string[], options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
    }) => {
      expect(command).toBe('/electron/node');
      expect(args).toEqual([
        path.join(runtimeRoot, 'openclaw.mjs'),
        'config',
        'unset',
        'plugins.installs',
      ]);
      expect(options.cwd).toBe(runtimeRoot);
      expect(options.env).toMatchObject({
        OPENCLAW_HOME: path.dirname(stateDir),
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        ELECTRON_RUN_AS_NODE: '1',
        LOBSTER_APIKEY_0: 'secret',
      });
      const migrated = structuredClone(legacyConfig);
      delete (migrated.plugins as { installs?: unknown }).installs;
      fs.writeFileSync(configPath, `${JSON.stringify(migrated, null, 2)}\n`, 'utf8');
      return { code: 0, stdout: 'Removed plugins.installs.', stderr: '' };
    });

    const result = await migrateLegacyOpenClawPluginInstalls({
      configPath,
      stateDir,
      runtimeRoot,
      electronNodeRuntimePath: '/electron/node',
      env: {},
      secretEnvVars: { LOBSTER_APIKEY_0: 'secret' },
      runner,
    });

    expect(result).toEqual({ status: OpenClawPluginInstallMigrationStatus.Migrated });
    expect(runner).toHaveBeenCalledOnce();
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).plugins.installs).toBeUndefined();
  });

  test('restores the exact original config and reports failure when the official write fails', async () => {
    const originalRaw = writeLegacyConfig();
    const renameError = Object.assign(new Error('destination exists'), { code: 'EEXIST' });
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw renameError;
    });
    const runner = vi.fn(async () => {
      fs.writeFileSync(configPath, '{"gateway":{"mode":"local"}}\n', 'utf8');
      return { code: 1, stdout: '', stderr: 'plugin index is not writable' };
    });

    const result = await migrateLegacyOpenClawPluginInstalls({
      configPath,
      stateDir,
      runtimeRoot,
      electronNodeRuntimePath: '/electron/node',
      env: {},
      runner,
    });

    expect(result.status).toBe(OpenClawPluginInstallMigrationStatus.Failed);
    expect(result).toMatchObject({ error: expect.stringContaining('plugin index is not writable') });
    expect(fs.readFileSync(configPath, 'utf8')).toBe(originalRaw);
    expect(renameSpy).toHaveBeenCalledOnce();
  });

  test('is idempotent after a successful migration', async () => {
    writeLegacyConfig();
    const runner = vi.fn(async () => {
      const migrated = structuredClone(legacyConfig);
      delete (migrated.plugins as { installs?: unknown }).installs;
      fs.writeFileSync(configPath, `${JSON.stringify(migrated, null, 2)}\n`, 'utf8');
      return { code: 0, stdout: '', stderr: '' };
    });
    const params = {
      configPath,
      stateDir,
      runtimeRoot,
      electronNodeRuntimePath: '/electron/node',
      env: {},
      runner,
    };

    await expect(migrateLegacyOpenClawPluginInstalls(params)).resolves.toEqual({
      status: OpenClawPluginInstallMigrationStatus.Migrated,
    });
    await expect(migrateLegacyOpenClawPluginInstalls(params)).resolves.toEqual({
      status: OpenClawPluginInstallMigrationStatus.NotNeeded,
    });
    expect(runner).toHaveBeenCalledOnce();
  });

  test('force-settles after the timed-out child ignores the kill close lifecycle', async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    const spawnProcess = vi.fn(() => child) as unknown as typeof import('child_process').spawn;

    const processPromise = runOpenClawPluginInstallMigrationProcess(
      '/electron/node',
      ['/runtime/openclaw.mjs', 'config', 'unset', 'plugins.installs'],
      {
        cwd: runtimeRoot,
        env: {},
        timeoutMs: 5,
        killGraceMs: 5,
        spawnProcess,
      },
    );

    await expect(processPromise).rejects.toThrow('timed out after 5ms');
    expect(child.kill).toHaveBeenNthCalledWith(1);
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    child.emit('close', null);
    child.emit('error', new Error('late error'));
  });
});
