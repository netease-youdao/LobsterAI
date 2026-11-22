import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  DSH_BASE_BUNDLE_NAME,
  DSH_CHANNELS_BUNDLE_NAME,
  DSH_HOST_BUNDLE_NAME,
  DSH_PROFILE_NAME,
  DSH_WEB_APP_BUNDLE_NAME,
  DshHostIpc,
} from '../../../shared/dshEngine/hostConstants';
import type { DshHostManager } from '../../libs/dsh/dshHostManager';
import {
  readInstalledProfilePlugins,
  registerDshHostHandlers,
  runDshPluginCommand,
  setProfilePluginEnabled,
  validatePluginInstallSpecifier,
  validatePluginPackageName,
} from './handlers';

const { registeredHandlers, openExternalMock, openPathMock } = vi.hoisted(() => ({
  registeredHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  openExternalMock: vi.fn(),
  openPathMock: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, handler);
    }),
  },
  shell: {
    openExternal: openExternalMock,
    openPath: openPathMock,
  },
}));

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-dsh-host-ipc-'));
  tempDirs.push(dir);
  return dir;
}

function writeProfileManifest(profileDir: string, manifest: Record<string, unknown>): void {
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
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

beforeEach(() => {
  registeredHandlers.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('validatePluginInstallSpecifier', () => {
  test('accepts npm packages, git specs, tarball URLs, and local paths with spaces', () => {
    expect(validatePluginInstallSpecifier('@deepseek-ai/dsh-experimental-forge-bundle')).toBe(
      '@deepseek-ai/dsh-experimental-forge-bundle',
    );
    expect(validatePluginInstallSpecifier('  my-plugin@1.2.3  ')).toBe('my-plugin@1.2.3');
    expect(validatePluginInstallSpecifier('github:owner/repo#abcdef1234')).toBe('github:owner/repo#abcdef1234');
    expect(validatePluginInstallSpecifier('git+https://github.com/owner/repo.git#main')).toBe(
      'git+https://github.com/owner/repo.git#main',
    );
    expect(validatePluginInstallSpecifier('file:/Users/Alice Smith/my plugins/demo')).toBe(
      'file:/Users/Alice Smith/my plugins/demo',
    );
    expect(validatePluginInstallSpecifier('/Users/Alice Smith/my plugins/demo')).toBe(
      '/Users/Alice Smith/my plugins/demo',
    );
    expect(validatePluginInstallSpecifier('./my plugins/demo')).toBe('./my plugins/demo');
    expect(validatePluginInstallSpecifier('../my plugins/demo')).toBe('../my plugins/demo');
    expect(validatePluginInstallSpecifier('C:\\Program Files\\Lobster Plugins\\demo')).toBe(
      'C:\\Program Files\\Lobster Plugins\\demo',
    );
    expect(validatePluginInstallSpecifier('file:C:\\Program Files\\Lobster Plugins\\demo')).toBe(
      'file:C:\\Program Files\\Lobster Plugins\\demo',
    );
  });

  test('rejects leading option flags, non-path spaces, shell metacharacters, and control chars', () => {
    expect(validatePluginInstallSpecifier('')).toBeNull();
    expect(validatePluginInstallSpecifier('   ')).toBeNull();
    expect(validatePluginInstallSpecifier('--registry=https://evil.invalid')).toBeNull();
    expect(validatePluginInstallSpecifier('-D')).toBeNull();
    expect(validatePluginInstallSpecifier('-')).toBeNull();
    expect(validatePluginInstallSpecifier('foo bar')).toBeNull();
    expect(validatePluginInstallSpecifier('foo --ignore-scripts')).toBeNull();
    expect(validatePluginInstallSpecifier('foo;rm -rf /')).toBeNull();
    expect(validatePluginInstallSpecifier('foo&bar')).toBeNull();
    expect(validatePluginInstallSpecifier('foo|bar')).toBeNull();
    expect(validatePluginInstallSpecifier('foo>bar')).toBeNull();
    expect(validatePluginInstallSpecifier('foo<bar')).toBeNull();
    expect(validatePluginInstallSpecifier('foo`id`')).toBeNull();
    expect(validatePluginInstallSpecifier('foo$HOME')).toBeNull();
    expect(validatePluginInstallSpecifier('file:/tmp/my\nplugin')).toBeNull();
    expect(validatePluginInstallSpecifier('file:/tmp/my\rplugin')).toBeNull();
    expect(validatePluginInstallSpecifier('file:/tmp/my\0plugin')).toBeNull();
    expect(validatePluginInstallSpecifier('file:/tmp/my\tplugin')).toBeNull();
  });
});

describe('validatePluginPackageName', () => {
  test('accepts user package names and rejects built-in bundles or unsafe names', () => {
    expect(validatePluginPackageName('lobster-e2e-demo-plugin')).toBe('lobster-e2e-demo-plugin');
    expect(validatePluginPackageName('@xmanrui/dsh-im')).toBe('@xmanrui/dsh-im');
    expect(validatePluginPackageName('@deepseek-ai/dsh-subagent-claude-code')).toBe(
      '@deepseek-ai/dsh-subagent-claude-code',
    );

    expect(validatePluginPackageName(DSH_BASE_BUNDLE_NAME)).toBeNull();
    expect(validatePluginPackageName(DSH_WEB_APP_BUNDLE_NAME)).toBeNull();
    expect(validatePluginPackageName(DSH_HOST_BUNDLE_NAME)).toBeNull();
    expect(validatePluginPackageName(DSH_CHANNELS_BUNDLE_NAME)).toBeNull();
    expect(validatePluginPackageName('@lobsterai/any-internal')).toBeNull();
    expect(validatePluginPackageName('--global')).toBeNull();
    expect(validatePluginPackageName('foo bar')).toBeNull();
    expect(validatePluginPackageName('foo;bar')).toBeNull();
    expect(validatePluginPackageName('foo\0bar')).toBeNull();
  });
});

describe('readInstalledProfilePlugins', () => {
  test('lists enabled bundles and retains disabled user plugins from dependencies and optionalDependencies', () => {
    const profileDir = createTempDir();
    writeProfileManifest(profileDir, {
      name: 'lobsterai-dsh-profile',
      private: true,
      dependencies: {
        [DSH_HOST_BUNDLE_NAME]: 'file:/app/dsh-bundles/lobsterai-host',
        [DSH_CHANNELS_BUNDLE_NAME]: 'file:/app/dsh-bundles/lobsterai-channels',
        'enabled-user-plugin': '^1.0.0',
        'disabled-user-plugin': 'file:/tmp/disabled-plugin',
      },
      optionalDependencies: {
        'optional-disabled-plugin': '^2.3.0',
      },
      dsh: {
        profile: {
          bundles: [
            DSH_BASE_BUNDLE_NAME,
            DSH_WEB_APP_BUNDLE_NAME,
            DSH_HOST_BUNDLE_NAME,
            'enabled-user-plugin',
          ],
        },
      },
    });

    const plugins = readInstalledProfilePlugins(profileDir);
    expect(plugins).toEqual([
      { name: DSH_BASE_BUNDLE_NAME, specifier: 'bundled', managed: true, enabled: true },
      { name: DSH_WEB_APP_BUNDLE_NAME, specifier: 'bundled', managed: true, enabled: true },
      { name: DSH_HOST_BUNDLE_NAME, specifier: 'file:/app/dsh-bundles/lobsterai-host', managed: true, enabled: true },
      { name: 'enabled-user-plugin', specifier: '^1.0.0', managed: false, enabled: true },
      { name: 'optional-disabled-plugin', specifier: '^2.3.0', managed: false, enabled: false },
      { name: 'disabled-user-plugin', specifier: 'file:/tmp/disabled-plugin', managed: false, enabled: false },
    ]);
  });

  test('returns empty array when manifest is missing or invalid', () => {
    const profileDir = createTempDir();
    expect(readInstalledProfilePlugins(profileDir)).toEqual([]);
    fs.writeFileSync(path.join(profileDir, 'package.json'), '{not-json', 'utf8');
    expect(readInstalledProfilePlugins(profileDir)).toEqual([]);
  });
});

describe('setProfilePluginEnabled', () => {
  test('toggles a user plugin off and back on without dropping its dependency entry', () => {
    const profileDir = createTempDir();
    writeProfileManifest(profileDir, {
      name: 'lobsterai-dsh-profile',
      private: true,
      dependencies: {
        [DSH_HOST_BUNDLE_NAME]: 'file:/app/dsh-bundles/lobsterai-host',
        'demo-plugin': 'file:/tmp/demo-plugin',
      },
      dsh: {
        profile: {
          bundles: [
            DSH_BASE_BUNDLE_NAME,
            DSH_WEB_APP_BUNDLE_NAME,
            DSH_HOST_BUNDLE_NAME,
            'demo-plugin',
          ],
        },
      },
    });

    const disabled = setProfilePluginEnabled(profileDir, 'demo-plugin', false);
    expect(disabled.ok).toBe(true);
    expect(disabled.changed).toBe(true);
    expect(disabled.enabled).toBe(false);
    expect(disabled.plugins.find((p) => p.name === 'demo-plugin')).toEqual({
      name: 'demo-plugin',
      specifier: 'file:/tmp/demo-plugin',
      managed: false,
      enabled: false,
    });

    const manifestAfterDisable = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      dsh: { profile: { bundles: string[] } };
    };
    expect(manifestAfterDisable.dependencies['demo-plugin']).toBe('file:/tmp/demo-plugin');
    expect(manifestAfterDisable.dsh.profile.bundles).not.toContain('demo-plugin');

    const disableAgain = setProfilePluginEnabled(profileDir, 'demo-plugin', false);
    expect(disableAgain.ok).toBe(true);
    expect(disableAgain.changed).toBe(false);

    const enabled = setProfilePluginEnabled(profileDir, 'demo-plugin', true);
    expect(enabled.ok).toBe(true);
    expect(enabled.changed).toBe(true);
    expect(enabled.enabled).toBe(true);
    expect(enabled.plugins.find((p) => p.name === 'demo-plugin')?.enabled).toBe(true);
  });

  test('rejects managed bundles and packages not present in dependencies', () => {
    const profileDir = createTempDir();
    writeProfileManifest(profileDir, {
      name: 'lobsterai-dsh-profile',
      private: true,
      dependencies: {
        [DSH_HOST_BUNDLE_NAME]: 'file:/app/dsh-bundles/lobsterai-host',
      },
      dsh: {
        profile: {
          bundles: [DSH_BASE_BUNDLE_NAME, DSH_WEB_APP_BUNDLE_NAME, DSH_HOST_BUNDLE_NAME],
        },
      },
    });

    expect(setProfilePluginEnabled(profileDir, DSH_HOST_BUNDLE_NAME, false).ok).toBe(false);
    expect(setProfilePluginEnabled(profileDir, DSH_BASE_BUNDLE_NAME, false).ok).toBe(false);
    expect(setProfilePluginEnabled(profileDir, 'nonexistent-plugin', true).ok).toBe(false);
    expect(setProfilePluginEnabled(profileDir, '--bad-flag', true).ok).toBe(false);
  });
});

describe('registerDshHostHandlers plugin IPC', () => {
  test('handles SetPluginEnabled with integrity restoration and host restart', async () => {
    const temp = createTempDir();
    const dshHomeDir = path.join(temp, 'dsh-profile');
    const profileDir = path.join(dshHomeDir, 'profiles', 'lobsterai');
    writeProfileManifest(profileDir, {
      name: 'lobsterai-dsh-profile',
      private: true,
      dependencies: {
        [DSH_HOST_BUNDLE_NAME]: 'file:/app/dsh-bundles/lobsterai-host',
        'demo-plugin': 'file:/tmp/demo-plugin',
      },
      dsh: {
        profile: {
          bundles: [DSH_BASE_BUNDLE_NAME, DSH_WEB_APP_BUNDLE_NAME, DSH_HOST_BUNDLE_NAME, 'demo-plugin'],
        },
      },
    });

    const callOrder: string[] = [];
    const mockManager = {
      getStatus: () => ({
        phase: 'ready',
        origin: 'http://127.0.0.1:1234',
        authenticatedWebUrl: null,
        pid: 123,
        runtimeVersion: '0.2.2-rc.5',
        profileDir,
        dshHomeDir,
        cliShimPath: null,
        lastError: null,
        startedAt: Date.now(),
        restartCount: 0,
      }),
      ensureProfileIntegrity: vi.fn(() => {
        callOrder.push('ensureProfileIntegrity');
      }),
      restart: vi.fn(async () => {
        callOrder.push('restart');
      }),
      getNodeToolchain: () => null,
    } as unknown as DshHostManager;

    registerDshHostHandlers({
      getHostManager: () => mockManager,
      getRuntimeDir: () => path.join(temp, 'runtime'),
      getExecutablePath: () => process.execPath,
    });

    const setEnabledHandler = registeredHandlers.get(DshHostIpc.SetPluginEnabled);
    expect(setEnabledHandler).toBeDefined();

    const res = await setEnabledHandler!({}, 'demo-plugin', false) as {
      ok: boolean;
      changed?: boolean;
      enabled?: boolean;
      plugins: Array<{ name: string; enabled: boolean }>;
    };
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);
    expect(res.enabled).toBe(false);
    expect(callOrder).toEqual(['ensureProfileIntegrity', 'restart']);
    expect(res.plugins.find((p) => p.name === 'demo-plugin')?.enabled).toBe(false);

    // Repeating with same state does not trigger unnecessary restart.
    callOrder.length = 0;
    const noopRes = await setEnabledHandler!({}, 'demo-plugin', false) as { ok: boolean; changed?: boolean };
    expect(noopRes.ok).toBe(true);
    expect(noopRes.changed).toBe(false);
    expect(callOrder).toEqual([]);
  });

  test('InstallPlugin rejects flag injection and shell metacharacters without invoking runtime', async () => {
    const temp = createTempDir();
    const mockManager = {
      getStatus: () => ({
        profileDir: path.join(temp, 'profile'),
        dshHomeDir: temp,
        cliShimPath: null,
      }),
      ensureProfileIntegrity: vi.fn(),
      restart: vi.fn(),
    } as unknown as DshHostManager;

    registerDshHostHandlers({
      getHostManager: () => mockManager,
      getRuntimeDir: () => path.join(temp, 'runtime'),
      getExecutablePath: () => process.execPath,
    });

    const installHandler = registeredHandlers.get(DshHostIpc.InstallPlugin)!;
    const flagRes = await installHandler({}, '--registry=https://evil.invalid') as { ok: boolean; error?: string };
    expect(flagRes.ok).toBe(false);
    expect(flagRes.error).toContain('Invalid');

    const metaRes = await installHandler({}, 'pkg;echo pwned') as { ok: boolean; error?: string };
    expect(metaRes.ok).toBe(false);
    expect(mockManager.restart).not.toHaveBeenCalled();
  });
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
