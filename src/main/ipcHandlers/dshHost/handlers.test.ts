import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { DSH_PROFILE_NAME, DshHostIpc } from '../../../shared/dshEngine/hostConstants';

const { registeredHandlers } = vi.hoisted(() => ({
  registeredHandlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, handler);
    }),
  },
  shell: {
    openExternal: vi.fn(),
    openPath: vi.fn(),
  },
}));

import { registerDshHostHandlers, runDshPluginCommand } from './handlers';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-dsh-host-ipc-'));
  tempDirs.push(dir);
  return dir;
}

function createMockRuntime(root: string): { runtimeDir: string; pnpmEntry: string } {
  const runtimeDir = path.join(root, 'mock-runtime');
  fs.mkdirSync(path.join(runtimeDir, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(runtimeDir, 'package-manager', 'pnpm', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'package.json'), JSON.stringify({ name: 'mock-dsh', type: 'module' }));
  fs.writeFileSync(
    path.join(runtimeDir, 'package-manager', 'pnpm', 'package.json'),
    JSON.stringify({ name: 'pnpm', version: '11.28.5', bin: { pnpm: 'bin/pnpm.mjs' } }),
  );
  const pnpmEntry = path.join(runtimeDir, 'package-manager', 'pnpm', 'bin', 'pnpm.mjs');
  fs.writeFileSync(pnpmEntry, 'console.log("11.28.5");\n');
  fs.writeFileSync(
    path.join(runtimeDir, 'lib', 'bin.js'),
    [
      'export async function runCli(options = {}) {',
      '  console.log(JSON.stringify({',
      '    cwd: process.cwd(),',
      '    execArgv: process.execArgv,',
      '    args: process.argv.slice(2),',
      '    packageManager: options.packageManager ?? null,',
      '    env: {',
      '      DSH_HOME: process.env.DSH_HOME ?? null,',
      '      DSH_AGENTS_HOME: process.env.DSH_AGENTS_HOME ?? null,',
      '      DSH_PROFILE: process.env.DSH_PROFILE ?? null,',
      '      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? null,',
      '      PNPM_HOME: process.env.PNPM_HOME ?? null,',
      '      npm_config_userconfig: process.env.npm_config_userconfig ?? null,',
      '      npm_config_globalconfig: process.env.npm_config_globalconfig ?? null,',
      '      npm_config_store_dir: process.env.npm_config_store_dir ?? null,',
      '      npm_config_cache: process.env.npm_config_cache ?? null,',
      '      PATH: process.env.PATH ?? null,',
      '    },',
      '  }));',
      '}',
      '',
    ].join('\n'),
  );
  return { runtimeDir, pnpmEntry };
}

afterEach(() => {
  registeredHandlers.clear();
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('runDshPluginCommand', () => {
  test('wires bundled pnpm launcher, pins cwd to dshHomeDir, and strips official env vars even with empty PATH', async () => {
    const root = createTempDir();
    const dshHomeDir = path.join(root, 'dsh-profile');
    const { runtimeDir, pnpmEntry } = createMockRuntime(root);

    const res = await runDshPluginCommand({
      executablePath: process.execPath,
      runtimeDir,
      dshHomeDir,
      args: ['add', '@example/plugin'],
      toolchain: { nodeShimDir: '/fake/node-shims', npmBinDir: '/fake/npm-bin', gitBinDir: null },
      skipElectronRunAsNode: true,
      baseEnv: {
        PATH: '',
        DSH_HOME: '/fake/official/.dsh',
        DSH_PROFILE: 'official',
        DEEPSEEK_API_KEY: 'sk-official-leak-test',
        PNPM_HOME: '/fake/global/pnpm',
        npm_config_userconfig: '/fake/global/.npmrc',
        npm_config_globalconfig: '/fake/global/npmrc',
      },
    });

    expect(res.ok, `stderr=${res.stderr}`).toBe(true);
    expect(res.exitCode).toBe(0);

    const parsed = JSON.parse(res.stdout) as {
      cwd: string;
      execArgv: string[];
      args: string[];
      packageManager: { command: string; args: string[]; env: Record<string, string> } | null;
      env: Record<string, string | null>;
    };

    expect(fs.realpathSync(parsed.cwd)).toBe(fs.realpathSync(dshHomeDir));
    expect(parsed.execArgv).toContain('--expose-internals');
    expect(parsed.args).toEqual(['plugin', '--profile', DSH_PROFILE_NAME, 'add', '@example/plugin']);
    expect(parsed.packageManager?.command).toBe(process.execPath);
    expect(parsed.packageManager?.args.map((p) => fs.realpathSync(p))).toEqual([fs.realpathSync(pnpmEntry)]);
    expect(parsed.packageManager?.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(parsed.packageManager?.env.LOBSTERAI_NPM_BIN_DIR).toBe('/fake/npm-bin');
    expect(parsed.packageManager?.env.PATH).toBe('/fake/node-shims');
    expect(parsed.env).toEqual({
      DSH_HOME: dshHomeDir,
      DSH_AGENTS_HOME: path.join(dshHomeDir, 'agents-home'),
      DSH_PROFILE: null,
      DEEPSEEK_API_KEY: null,
      PNPM_HOME: null,
      npm_config_userconfig: null,
      npm_config_globalconfig: null,
      npm_config_store_dir: path.join(dshHomeDir, 'cache', 'pnpm-store'),
      npm_config_cache: path.join(dshHomeDir, 'cache', 'npm-cache'),
      PATH: '',
    });
  });
});

describe('registerDshHostHandlers plugin IPC', () => {
  test('InstallPlugin forwards getNodeToolchain to bundled pnpm launcher and restarts host on success', async () => {
    const root = createTempDir();
    const dshHomeDir = path.join(root, 'dsh-profile');
    const profileDir = path.join(dshHomeDir, 'profiles', DSH_PROFILE_NAME);
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }));

    const { runtimeDir, pnpmEntry } = createMockRuntime(root);
    const restart = vi.fn(async () => undefined);
    const getNodeToolchain = vi.fn(() => ({
      electronPath: process.execPath,
      nodeShimDir: '/fake/shims',
      npmBinDir: null,
      gitBinDir: null,
    }));

    registerDshHostHandlers({
      getHostManager: () =>
        ({
          getStatus: () => ({ dshHomeDir, profileDir }),
          restart,
        }) as never,
      getRuntimeDir: () => runtimeDir,
      getExecutablePath: () => process.execPath,
      getNodeToolchain,
    });

    const handler = registeredHandlers.get(DshHostIpc.InstallPlugin);
    expect(handler).toBeDefined();

    const result = (await handler!({}, '@example/demo')) as { ok: boolean; stdout: string };
    expect(result.ok).toBe(true);
    expect(getNodeToolchain).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledTimes(1);

    const parsed = JSON.parse(result.stdout) as {
      packageManager: { command: string; args: string[] } | null;
    };
    expect(parsed.packageManager?.command).toBe(process.execPath);
    expect(parsed.packageManager?.args.map((p) => fs.realpathSync(p))).toEqual([fs.realpathSync(pnpmEntry)]);
  });
});
