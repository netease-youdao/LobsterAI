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
  DshPluginApplicationStatus,
  DshPluginAvailability,
  DshPluginPanelKind,
  DshPluginSurface,
  DshPluginUpdateKind,
  DshPluginUpdateOutcomeKind,
} from '../../../shared/dshEngine/hostConstants';
import type { DshHostManager } from '../../libs/dsh/dshHostManager';
import type {
  DshPluginBundleInfo,
  DshPluginChangeResult,
  DshPluginUpdateResult,
  DshPluginVersionList,
} from '../../libs/dsh/dshTypertClient';
import {
  buildEnrichedPluginEntries,
  classifyBundleSurface,
  extractPanelMetadataFromClientSource,
  isAllowedDshEmbedWebviewUrl,
  normalizePluginUpdateOutcome,
  readInstalledProfilePlugins,
  registerDshHostHandlers,
  runDshPluginCommand,
  setProfilePluginEnabled,
  validateOptionalRegistryUrl,
  validatePluginInstallSpecifier,
  validatePluginPackageName,
} from './handlers';

const {
  registeredHandlers,
  openExternalMock,
  openPathMock,
  writeTextMock,
  showOpenDialogMock,
} = vi.hoisted(() => ({
  registeredHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  openExternalMock: vi.fn(),
  openPathMock: vi.fn(),
  writeTextMock: vi.fn(),
  showOpenDialogMock: vi.fn(),
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
  clipboard: {
    writeText: writeTextMock,
  },
  dialog: {
    showOpenDialog: showOpenDialogMock,
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

describe('classifyBundleSurface & buildEnrichedPluginEntries', () => {
  test('classifies native host, hybrid host+web, and web-only theme bundles accurately', () => {
    const profileDir = createTempDir();
    const nm = path.join(profileDir, 'node_modules');

    fs.mkdirSync(path.join(nm, '@acme', 'host-tool'), { recursive: true });
    fs.writeFileSync(
      path.join(nm, '@acme', 'host-tool', 'package.json'),
      JSON.stringify({ name: '@acme/host-tool', version: '1.0.0' }),
    );

    fs.mkdirSync(path.join(nm, '@acme', 'web-panel'), { recursive: true });
    fs.writeFileSync(
      path.join(nm, '@acme', 'web-panel', 'package.json'),
      JSON.stringify({
        name: '@acme/web-panel',
        version: '1.0.0',
        dsh: { client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-layout'] } },
      }),
    );

    fs.mkdirSync(path.join(nm, '@acme', 'dark-skin'), { recursive: true });
    fs.writeFileSync(
      path.join(nm, '@acme', 'dark-skin', 'package.json'),
      JSON.stringify({
        name: '@acme/dark-skin',
        version: '1.0.0',
        dsh: { client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-theme'] } },
      }),
    );

    expect(
      classifyBundleSurface({
        name: '@acme/tool-bundle',
        rows: [{ moduleName: '@acme/host-tool' }],
        profileDir,
      }),
    ).toMatchObject({
      surface: DshPluginSurface.Native,
      hasHostCapability: true,
      hasWebClient: false,
      isThemePlugin: false,
    });

    expect(
      classifyBundleSurface({
        name: '@acme/hybrid-bundle',
        rows: [{ moduleName: '@acme/host-tool' }, { moduleName: '@acme/web-panel' }],
        profileDir,
      }),
    ).toMatchObject({
      surface: DshPluginSurface.Hybrid,
      hasHostCapability: true,
      hasWebClient: true,
      isThemePlugin: false,
    });

    expect(
      classifyBundleSurface({
        name: '@acme/skin-bundle',
        rows: [{ moduleName: '@acme/dark-skin' }],
        profileDir,
      }),
    ).toMatchObject({
      surface: DshPluginSurface.WebOnly,
      hasHostCapability: false,
      hasWebClient: true,
      isThemePlugin: true,
    });

    // Dual-face single-package bundle (like dsh-media-desk: host entry registers tools + dsh.client web UI).
    fs.mkdirSync(path.join(nm, 'dsh-media-desk', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(nm, 'dsh-media-desk', 'package.json'),
      JSON.stringify({
        name: 'dsh-media-desk',
        version: '2.7.2',
        main: 'src/host.js',
        dsh: {
          bundle: { patch: './cordis.patch.yml' },
          client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-runtime'] },
        },
      }),
    );
    fs.writeFileSync(
      path.join(nm, 'dsh-media-desk', 'src', 'host.js'),
      'export function apply(ctx) { ctx.tools.register({ name: "media_desk" }); }\n',
    );
    expect(
      classifyBundleSurface({
        name: 'dsh-media-desk',
        rows: [{ moduleName: 'dsh-media-desk' }],
        profileDir,
      }),
    ).toMatchObject({
      surface: DshPluginSurface.Hybrid,
      hasHostCapability: true,
      hasWebClient: true,
      isThemePlugin: false,
    });

    // Heuristic pre-install detection when manifest is not on disk yet.
    expect(
      classifyBundleSurface({
        name: 'dsh-nord-theme-bundle',
        description: 'Nord dark theme skin for DSH',
      }),
    ).toMatchObject({
      surface: DshPluginSurface.WebOnly,
      isThemePlugin: true,
      heuristicOnly: true,
    });
  });

  test('filters out uninstalled DSH optional/catalog bundles while keeping installed user and core bundles', () => {
    const profileDir = createTempDir();
    const liveBundles: DshPluginBundleInfo[] = [
      {
        name: DSH_BASE_BUNDLE_NAME,
        official: false,
        availability: 'installation',
        version: '0.2.2-rc.5',
        enabled: true,
        installed: false,
        optional: false,
        removable: false,
        rows: [],
        overrides: [],
      },
      {
        name: '@deepseek-ai/dsh-experimental-voice-input-bundle',
        official: true,
        availability: 'installation',
        version: '0.2.2-rc.5',
        enabled: false,
        installed: false,
        optional: true,
        removable: false,
        rows: [],
        overrides: [],
      },
      {
        name: '@deepseek-ai/dsh-subagent-claude-code',
        official: true,
        availability: 'missing',
        enabled: false,
        installed: false,
        optional: false,
        removable: false,
        rows: [],
        overrides: [],
      },
      {
        name: '@acme/my-plugin',
        official: false,
        availability: 'profile',
        version: '1.2.3',
        meta: {
          title: { en: 'My Plugin', zh: '我的插件' },
          description: { en: 'Adds tools', zh: '添加实用工具' },
          icon: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
        },
        enabled: true,
        installed: true,
        source: '^1.2.3',
        optional: false,
        removable: true,
        rows: [{ rowId: 'tool', moduleName: '@acme/my-plugin', entryId: 'e1' }],
        overrides: [],
      },
    ];

    const entries = buildEnrichedPluginEntries({
      liveBundles,
      fallbackPlugins: [
        { name: DSH_BASE_BUNDLE_NAME, specifier: 'bundled', managed: true, enabled: true },
        { name: '@acme/my-plugin', specifier: '^1.2.3', managed: false, enabled: true },
      ],
      profileDir,
    });

    expect(entries.map((e) => e.name)).toEqual([DSH_BASE_BUNDLE_NAME, '@acme/my-plugin']);
    const userEntry = entries.find((e) => e.name === '@acme/my-plugin');
    expect(userEntry).toMatchObject({
      name: '@acme/my-plugin',
      version: '1.2.3',
      title: { en: 'My Plugin', zh: '我的插件' },
      description: { en: 'Adds tools', zh: '添加实用工具' },
      icon: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      managed: false,
      enabled: true,
      removable: true,
      surface: DshPluginSurface.Native,
      isThemePlugin: false,
      rowCount: 1,
      activeRowCount: 1,
    });
  });

  test('validates optional registry URLs safely', () => {
    expect(validateOptionalRegistryUrl(undefined)).toBeNull();
    expect(validateOptionalRegistryUrl(null)).toBeNull();
    expect(validateOptionalRegistryUrl('https://registry.npmmirror.com/')).toBe('https://registry.npmmirror.com/');
    expect(validateOptionalRegistryUrl('ftp://bad.example/')).toBe(false);
    expect(validateOptionalRegistryUrl('https://user:pass@evil.example/')).toBe(false);
    expect(validateOptionalRegistryUrl('not a url')).toBe(false);
  });

  test('extracts panelId and localized panelLabel from dsh-media-desk style client bundles', () => {
    const mediaDeskClient = `
      var Pt = "media-desk";
      e.slots.register({name:"main",key:Pt},Gn);
      e.slots.register({name:"sidebar.panellist",id:Pt,order:5,label:()=>n("\\u81EA\\u5A92\\u4F53\\u5DE5\\u4F5C\\u53F0")},Wn);
    `;
    expect(extractPanelMetadataFromClientSource(mediaDeskClient)).toEqual({
      panelId: 'media-desk',
      panelKind: DshPluginPanelKind.Main,
      panelLabel: { en: '自媒体工作台', zh: '自媒体工作台' },
    });

    // Literal main key + i18n dotted key in label wrapper skips raw i18n key.
    const i18nClient = `
      ctx.slots.register({ name: 'main', key: 'forge-board' }, Board);
      ctx.slots.register({ name: 'sidebar.panellist', id: 'forge-board', label: () => t('sidebar.forge') }, Icon);
    `;
    expect(extractPanelMetadataFromClientSource(i18nClient)).toEqual({
      panelId: 'forge-board',
      panelKind: DshPluginPanelKind.Main,
    });

    // tsdown / rolldown / oxc minified bundle using backtick template literals (e.g. dsh-context).
    const tsdownBacktickClient =
      'let Xd=`dsh-context`;function Zd(e,t,n,r,i){return[e.slots.inject(`main`,()=>e.slots.register({name:`main`,key:Xd,locale:i},n)),e.slots.inject(`sidebar.panellist`,()=>e.slots.register({name:`sidebar.panellist`,id:Xd,order:20,label:()=>r(`ov.title`),locale:i},w))]}';
    expect(extractPanelMetadataFromClientSource(tsdownBacktickClient)).toEqual({
      panelId: 'dsh-context',
      panelKind: DshPluginPanelKind.Main,
    });

    // settings.section plugin (e.g. dsh-pocket): detects section id, marks SettingsSection,
    // and skips single-word translator keys like translate("section").
    const pocketClient = `
      ctx.slots.inject(
        "settings.section",
        () => ctx.slots.register(
          {
            name: "settings.section",
            id: "pocket",
            order: 1,
            label: () => translate("section"),
            inject: () => ({ rpcCall, t: translate })
          },
          PocketSettingsTab
        )
      );
    `;
    expect(extractPanelMetadataFromClientSource(pocketClient, 'dsh-pocket')).toEqual({
      panelId: 'pocket',
      panelKind: DshPluginPanelKind.SettingsSection,
    });

    // settings.section plugin with direct localized label retains panelLabel.
    const labeledSettingsClient = `
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register({ id: 'remote-sync', name: 'settings.section', label: () => '远程同步' }, Tab)
      );
    `;
    expect(extractPanelMetadataFromClientSource(labeledSettingsClient)).toEqual({
      panelId: 'remote-sync',
      panelKind: DshPluginPanelKind.SettingsSection,
      panelLabel: { en: '远程同步', zh: '远程同步' },
    });

    // Built-in reserved settings.section ids are never misclassified as plugin panels.
    const reservedSettingsClient = `
      ctx.slots.register({ name: 'settings.section', id: 'general' }, GeneralPatch);
    `;
    expect(extractPanelMetadataFromClientSource(reservedSettingsClient, 'custom-patch')).toEqual({});

    // Non-panel client plugin (no main, sidebar.panellist, or settings.section slot) yields empty metadata.
    const widgetOnly = `ctx.slots.register({ name: 'sidebar.footer.action', id: 'badge' }, Badge);`;
    expect(extractPanelMetadataFromClientSource(widgetOnly, 'widget-row')).toEqual({});
  });

  test('classifies webServer dual-face plugin as Hybrid with extracted panel metadata', () => {
    const profileDir = createTempDir();
    const pkgDir = path.join(profileDir, 'node_modules', 'dsh-media-desk');
    fs.mkdirSync(path.join(pkgDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({
        name: 'dsh-media-desk',
        main: 'src/host.js',
        exports: {
          '.': './src/host.js',
          './client': './dist/client.js',
        },
        dsh: {
          bundle: { patch: './cordis.patch.yml' },
          client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-runtime'] },
        },
      }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(pkgDir, 'cordis.patch.yml'),
      '- insert:\n    - id: media-desk\n      name: dsh-media-desk\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(pkgDir, 'src', 'host.js'),
      'export const inject = ["webServer", "connection"]; export function apply(ctx) { ctx.webServer.register({ path: "/media-desk" }); }',
      'utf8',
    );
    fs.writeFileSync(
      path.join(pkgDir, 'dist', 'client.js'),
      'var Pt="media-desk";e.slots.register({name:"main",key:Pt},G);e.slots.register({name:"sidebar.panellist",id:Pt,label:()=>n("\\u81EA\\u5A92\\u4F53\\u5DE5\\u4F5C\\u53F0")},W);',
      'utf8',
    );

    expect(
      classifyBundleSurface({
        name: 'dsh-media-desk',
        rows: [{ rowId: 'media-desk', moduleName: 'dsh-media-desk' }],
        profileDir,
      }),
    ).toEqual({
      surface: DshPluginSurface.Hybrid,
      hasHostCapability: true,
      hasWebClient: true,
      isThemePlugin: false,
      panelId: 'media-desk',
      panelKind: DshPluginPanelKind.Main,
      panelLabel: { en: '自媒体工作台', zh: '自媒体工作台' },
    });
  });

  test('classifies dsh-pocket settings.section dual-face plugin as Hybrid with SettingsSection panel metadata', () => {
    const profileDir = createTempDir();
    const pkgDir = path.join(profileDir, 'node_modules', 'dsh-pocket');
    fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(pkgDir, 'client'), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({
        name: 'dsh-pocket',
        main: 'lib/index.js',
        exports: {
          '.': { default: './lib/index.js' },
          './client': './client/client.js',
        },
        dsh: {
          bundle: { patch: './cordis.patch.yml' },
          client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-slots'] },
        },
      }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(pkgDir, 'cordis.patch.yml'),
      '- insert:\n    - id: dsh-pocket\n      name: dsh-pocket\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(pkgDir, 'lib', 'index.js'),
      'const inject = ["connection", "webServer"]; export function apply(ctx) {}',
      'utf8',
    );
    fs.writeFileSync(
      path.join(pkgDir, 'client', 'client.js'),
      'ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id: "pocket", order: 1, label: () => translate("section") }, Tab));',
      'utf8',
    );

    expect(
      classifyBundleSurface({
        name: 'dsh-pocket',
        rows: [{ rowId: 'dsh-pocket', moduleName: 'dsh-pocket' }],
        profileDir,
      }),
    ).toEqual({
      surface: DshPluginSurface.Hybrid,
      hasHostCapability: true,
      hasWebClient: true,
      isThemePlugin: false,
      panelId: 'pocket',
      panelKind: DshPluginPanelKind.SettingsSection,
    });
  });

  test('validates embedded plugin webview URLs strictly against live DSH host origin', () => {
    const origin = 'http://127.0.0.1:4321';
    expect(
      isAllowedDshEmbedWebviewUrl('http://127.0.0.1:4321/?token=abc#lobster-embed=1&panel=media-desk', origin),
    ).toBe(true);
    expect(isAllowedDshEmbedWebviewUrl('http://127.0.0.1:4321/', origin)).toBe(true);
    expect(isAllowedDshEmbedWebviewUrl('http://127.0.0.1:9999/', origin)).toBe(false);
    expect(isAllowedDshEmbedWebviewUrl('https://evil.example/?token=abc', origin)).toBe(false);
    expect(isAllowedDshEmbedWebviewUrl('about:blank', origin)).toBe(false);
    expect(isAllowedDshEmbedWebviewUrl('javascript:alert(1)', origin)).toBe(false);
    expect(isAllowedDshEmbedWebviewUrl('http://127.0.0.1:4321/', null)).toBe(false);
  });
});

describe('registerDshHostHandlers live HMR Typert RPC path', () => {
  test('installs, toggles, and removes plugins via Typert pluginManager without forcing host restart', async () => {
    const temp = createTempDir();
    const dshHomeDir = path.join(temp, 'dsh-profile');
    const profileDir = path.join(dshHomeDir, 'profiles', DSH_PROFILE_NAME);
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

    let installedBundles: DshPluginBundleInfo[] = [
      {
        name: DSH_BASE_BUNDLE_NAME,
        official: false,
        availability: 'installation',
        version: '0.2.2-rc.5',
        enabled: true,
        installed: false,
        optional: false,
        removable: false,
        rows: [],
        overrides: [],
      },
    ];

    const mockClient = {
      listPluginBundles: vi.fn(async () => installedBundles),
      inspectPluginSpec: vi.fn(async (spec: string) => ({
        status: 'accepted' as const,
        kind: 'registry' as const,
        name: spec,
        version: '1.0.0',
        description: 'A cool Nord theme skin',
        bundle: true,
        registry: 'https://registry.npmmirror.com/',
      })),
      installPluginBundle: vi.fn(async (spec: string): Promise<DshPluginChangeResult> => {
        installedBundles = [
          ...installedBundles,
          {
            name: spec,
            official: false,
            availability: 'profile',
            version: '1.0.0',
            enabled: true,
            installed: true,
            optional: false,
            removable: true,
            rows: [],
            overrides: [],
          },
        ];
        return {
          changed: true,
          application: 'applied',
          stage: 'install',
          target: spec,
          enabled: true,
          bundle: spec,
          version: '1.0.0',
          approvedBuilds: ['esbuild'],
          registries: ['https://registry.npmmirror.com/'],
          packageResult: {
            exitCode: 0,
            output: 'added 1 package',
            truncated: false,
            logPath: '/tmp/install.log',
          },
        };
      }),
      setPluginBundleEnabled: vi.fn(async (name: string, enabled: boolean): Promise<DshPluginChangeResult> => {
        installedBundles = installedBundles.map((b) => (b.name === name ? { ...b, enabled } : b));
        return {
          changed: true,
          application: 'restart-required',
          restartReason: 'host-module',
          stage: 'enable',
          target: name,
          enabled,
        };
      }),
      removePluginBundle: vi.fn(async (name: string): Promise<DshPluginChangeResult> => {
        installedBundles = installedBundles.filter((b) => b.name !== name);
        return {
          changed: true,
          application: 'applied',
          stage: 'remove',
          target: name,
        };
      }),
      cancelPluginInstall: vi.fn(async () => ({ status: 'cancelled' as const })),
      getPluginRegistries: vi.fn(async () => ({
        registry: null,
        fallbackRegistries: ['https://registry.npmmirror.com/'],
        resolved: 'https://registry.npmjs.org/',
      })),
      probeFastestPluginRegistry: vi.fn(async () => 'https://registry.npmmirror.com/'),
    };

    const restartMock = vi.fn(async () => undefined);
    const ensureIntegrityMock = vi.fn();
    const mockManager = {
      isReady: () => true,
      getClient: () => mockClient,
      getStatus: () => ({
        phase: 'ready',
        origin: 'http://127.0.0.1:4321',
        authenticatedWebUrl: 'http://127.0.0.1:4321/?token=abc',
        pid: 999,
        runtimeVersion: '0.2.2-rc.5',
        profileDir,
        dshHomeDir,
        cliShimPath: path.join(dshHomeDir, 'bin', 'dsh'),
        lastError: null,
        startedAt: Date.now(),
        restartCount: 0,
      }),
      ensureProfileIntegrity: ensureIntegrityMock,
      restart: restartMock,
    } as unknown as DshHostManager;

    registerDshHostHandlers({
      getHostManager: () => mockManager,
      getRuntimeDir: () => path.join(temp, 'runtime'),
      getExecutablePath: () => process.execPath,
    });

    // 1. Inspect detects theme warning hint before install.
    const inspectRes = (await registeredHandlers.get(DshHostIpc.InspectPlugin)!({}, {
      spec: '@acme/nord-theme',
      registry: 'https://registry.npmmirror.com/',
    })) as { ok: boolean; status?: string; surface?: string; isThemePlugin?: boolean };
    expect(inspectRes).toMatchObject({
      ok: true,
      status: 'accepted',
      surface: DshPluginSurface.WebOnly,
      isThemePlugin: true,
    });

    // 2. Install applies via HMR without restarting host.
    const installRes = (await registeredHandlers.get(DshHostIpc.InstallPlugin)!({}, {
      spec: '@acme/demo-tools',
      registry: 'https://registry.npmmirror.com/',
      requestId: 'req-1',
    })) as {
      ok: boolean;
      application?: string;
      stage?: string;
      approvedBuilds?: string[];
      registries?: Array<string | null>;
      exitCode?: number | null;
      restartRequired?: boolean;
      plugins: Array<{ name: string }>;
    };
    expect(installRes.ok).toBe(true);
    expect(installRes.application).toBe(DshPluginApplicationStatus.Applied);
    expect(installRes.stage).toBe('install');
    expect(installRes.approvedBuilds).toEqual(['esbuild']);
    expect(installRes.registries).toEqual(['https://registry.npmmirror.com/']);
    expect(installRes.exitCode).toBe(0);
    expect(installRes.restartRequired).toBe(false);
    expect(installRes.plugins.some((p) => p.name === '@acme/demo-tools')).toBe(true);
    expect(restartMock).not.toHaveBeenCalled();
    expect(ensureIntegrityMock).toHaveBeenCalledTimes(1);

    // 3. Toggle surfaces restartRequired when DSH reports restart-required without auto-restarting.
    const toggleRes = (await registeredHandlers.get(DshHostIpc.SetPluginEnabled)!({}, '@acme/demo-tools', false)) as {
      ok: boolean;
      application?: string;
      restartRequired?: boolean;
      restartReason?: string;
    };
    expect(toggleRes.ok).toBe(true);
    expect(toggleRes.application).toBe(DshPluginApplicationStatus.RestartRequired);
    expect(toggleRes.restartRequired).toBe(true);
    expect(toggleRes.restartReason).toBe('host-module');
    expect(restartMock).not.toHaveBeenCalled();

    // 4. Remove unloads via HMR without restarting host.
    const removeRes = (await registeredHandlers.get(DshHostIpc.RemovePlugin)!({}, '@acme/demo-tools')) as {
      ok: boolean;
      restartRequired?: boolean;
      plugins: Array<{ name: string }>;
    };
    expect(removeRes.ok).toBe(true);
    expect(removeRes.restartRequired).toBe(false);
    expect(removeRes.plugins.some((p) => p.name === '@acme/demo-tools')).toBe(false);
    expect(restartMock).not.toHaveBeenCalled();

    // 5. Registries, cancel, copy CLI, and local dir picker handlers work cleanly.
    const regRes = (await registeredHandlers.get(DshHostIpc.GetPluginRegistries)!({})) as {
      ok: boolean;
      fastest?: string | null;
    };
    expect(regRes.ok).toBe(true);
    expect(regRes.fastest).toBe('https://registry.npmmirror.com/');

    const cancelRes = (await registeredHandlers.get(DshHostIpc.CancelPluginInstall)!({}, 'req-1')) as {
      ok: boolean;
      status?: string;
    };
    expect(cancelRes).toEqual({ ok: true, status: 'cancelled' });

    const copyRes = (await registeredHandlers.get(DshHostIpc.CopyCliShimCommand)!({})) as { ok: boolean };
    expect(copyRes.ok).toBe(true);
    expect(writeTextMock).toHaveBeenCalledWith(path.join(dshHomeDir, 'bin', 'dsh'));

    showOpenDialogMock.mockResolvedValueOnce({ canceled: false, filePaths: ['/tmp/my-local-plugin'] });
    const pickRes = (await registeredHandlers.get(DshHostIpc.PickLocalPluginDir)!({})) as {
      ok: boolean;
      canceled?: boolean;
      path?: string | null;
    };
    expect(pickRes).toEqual({ ok: true, canceled: false, path: '/tmp/my-local-plugin' });
  });

  test('OpenEcosystemView refreshes agent workspaces before opening the DSH view window', async () => {
    const order: string[] = [];
    const manager = {
      isReady: vi.fn(() => true),
      start: vi.fn(),
      getAuthenticatedWebUrl: vi.fn(() => 'http://127.0.0.1:4321/#token=abc'),
    } as unknown as DshHostManager;

    registerDshHostHandlers({
      getHostManager: () => manager,
      getRuntimeDir: () => '/tmp/runtime',
      getExecutablePath: () => '/tmp/electron',
      syncAgentWorkspaces: async () => {
        order.push('sync');
      },
      openEcosystemWindow: () => {
        order.push('open');
      },
    });

    const result = await registeredHandlers.get(DshHostIpc.OpenEcosystemView)!({});
    expect(result).toEqual({ ok: true, url: 'http://127.0.0.1:4321/#token=abc' });
    expect(order).toEqual(['sync', 'open']);
  });

  test('normalizePluginUpdateOutcome classifies all server update outcomes and extracts failure output', () => {
    const baseChange = (overrides: Partial<DshPluginChangeResult> = {}): DshPluginChangeResult => ({
      changed: false,
      application: 'failed',
      stage: 'install',
      target: '@acme/demo',
      ...overrides,
    });

    const applied = normalizePluginUpdateOutcome(
      {
        from: '1.0.0',
        to: '1.2.0',
        step: 'install',
        result: baseChange({ changed: true, application: 'applied', stage: 'enable' }),
      },
      [],
    );
    expect(applied).toMatchObject({
      ok: true,
      outcome: DshPluginUpdateOutcomeKind.Applied,
      restartRequired: false,
    });

    const restartRequired = normalizePluginUpdateOutcome(
      {
        from: '1.0.0',
        to: '1.2.0',
        step: 'install',
        result: baseChange({
          changed: true,
          application: 'restart-required',
          restartReason: 'host-module',
        }),
      },
      [],
    );
    expect(restartRequired).toMatchObject({
      ok: true,
      outcome: DshPluginUpdateOutcomeKind.RestartRequired,
      restartRequired: true,
      restartReason: 'host-module',
    });

    const checkRefused = normalizePluginUpdateOutcome(
      {
        from: '1.0.0',
        to: '2.0.0',
        step: 'check',
        result: baseChange({
          error: { code: 'incompatible-version', diagnostic: 'needs newer DSH' },
        }),
      },
      [],
    );
    expect(checkRefused).toMatchObject({
      ok: false,
      outcome: DshPluginUpdateOutcomeKind.CheckRefused,
      errorCode: 'incompatible-version',
    });

    const removeFailed = normalizePluginUpdateOutcome(
      {
        from: '1.0.0',
        to: '1.2.0',
        step: 'remove',
        result: baseChange({ stage: 'remove', error: { code: 'bundle-in-use' } }),
      },
      [],
    );
    expect(removeFailed).toMatchObject({
      ok: false,
      outcome: DshPluginUpdateOutcomeKind.RemoveFailed,
      errorCode: 'bundle-in-use',
    });

    const kept = normalizePluginUpdateOutcome(
      {
        from: '1.0.0',
        to: '1.2.0',
        step: 'install',
        result: baseChange({ error: { code: 'operation-error', diagnostic: 'no-hmr rollback' } }),
      },
      [],
    );
    expect(kept).toMatchObject({
      ok: false,
      outcome: DshPluginUpdateOutcomeKind.InstallFailedKept,
    });

    const restored = normalizePluginUpdateOutcome(
      {
        from: '1.0.0',
        to: '1.2.0',
        step: 'install',
        result: baseChange({
          packageResult: {
            exitCode: 1,
            output: 'ERR_PNPM_FETCH_404',
            truncated: false,
            logPath: '/tmp/install.log',
            kind: 'not-found',
          },
        }),
        restore: baseChange({ changed: true, application: 'applied', stage: 'enable' }),
      },
      [],
    );
    expect(restored).toMatchObject({
      ok: false,
      outcome: DshPluginUpdateOutcomeKind.InstallFailedRestored,
      restored: true,
      output: 'ERR_PNPM_FETCH_404',
      failureKind: 'not-found',
    });

    const broken = normalizePluginUpdateOutcome(
      {
        from: '1.0.0',
        to: '1.2.0',
        step: 'install',
        result: baseChange({ error: { code: 'operation-error', diagnostic: 'install boom' } }),
        restore: baseChange({
          error: { code: 'operation-error', diagnostic: 'restore boom' },
          packageResult: {
            exitCode: 1,
            output: 'restore stderr',
            truncated: false,
            logPath: '/tmp/restore.log',
          },
        }),
      },
      [],
    );
    expect(broken).toMatchObject({
      ok: false,
      outcome: DshPluginUpdateOutcomeKind.InstallFailedBroken,
      restored: false,
      restoreError: 'restore boom',
      output: 'restore stderr',
    });
  });

  test('handles CheckPluginVersions and UpdatePlugin IPCs with integrity protection and validation', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-dsh-update-ipc-'));
    tempDirs.push(temp);
    const dshHomeDir = path.join(temp, 'dsh-home');
    const profileDir = path.join(dshHomeDir, 'profiles', DSH_PROFILE_NAME);
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, 'package.json'),
      JSON.stringify({
        name: 'lobsterai-dsh-profile',
        private: true,
        dependencies: {
          '@acme/demo-tools': '1.0.0',
        },
        dsh: {
          profile: {
            bundles: [DSH_BASE_BUNDLE_NAME, '@acme/demo-tools'],
          },
        },
      }),
    );

    let currentVersion = '1.0.0';
    const listPluginBundles = vi.fn(async (): Promise<DshPluginBundleInfo[]> => [
      {
        name: DSH_BASE_BUNDLE_NAME,
        official: false,
        availability: 'installation',
        version: '0.2.2-rc.5',
        enabled: true,
        installed: false,
        optional: false,
        removable: false,
        rows: [],
        overrides: [],
      },
      {
        name: '@acme/demo-tools',
        official: false,
        availability: 'profile',
        version: currentVersion,
        source: `@acme/demo-tools@${currentVersion}`,
        enabled: true,
        installed: true,
        optional: false,
        removable: true,
        update: 'registry',
        rows: [],
        overrides: [],
      },
    ]);
    const listPluginVersions = vi.fn(async (): Promise<DshPluginVersionList> => ({
      status: 'listed',
      installed: currentVersion,
      registry: 'https://registry.npmmirror.com/',
      attempts: [{ registry: 'https://registry.npmmirror.com/' }],
      versions: [
        {
          version: '1.2.0',
          publishedAt: '2026-11-25T10:00:00.000Z',
          tags: ['latest'],
          prerelease: false,
          bundle: true,
        },
      ],
      omitted: 0,
    }));
    const updatePluginBundle = vi.fn(
      async (_name: string, version: string): Promise<DshPluginUpdateResult> => {
        const previous = currentVersion;
        currentVersion = version;
        return {
          from: previous,
          to: version,
          step: 'install',
          result: {
            changed: true,
            application: 'applied',
            stage: 'enable',
            target: '@acme/demo-tools',
            bundle: '@acme/demo-tools',
            version,
          },
        };
      },
    );

    const ensureIntegrityMock = vi.fn();
    let hostReady = true;
    const mockManager = {
      isReady: () => hostReady,
      getClient: () => ({
        listPluginBundles,
        listPluginVersions,
        updatePluginBundle,
      }),
      getStatus: () => ({
        phase: hostReady ? 'ready' : 'stopped',
        origin: 'http://127.0.0.1:4321',
        authenticatedWebUrl: 'http://127.0.0.1:4321/?token=abc',
        pid: 999,
        runtimeVersion: '0.2.2-rc.5',
        profileDir,
        dshHomeDir,
        cliShimPath: path.join(dshHomeDir, 'bin', 'dsh'),
        lastError: null,
        startedAt: Date.now(),
        restartCount: 0,
      }),
      ensureProfileIntegrity: ensureIntegrityMock,
    } as unknown as DshHostManager;

    registerDshHostHandlers({
      getHostManager: () => mockManager,
      getRuntimeDir: () => path.join(temp, 'runtime'),
      getExecutablePath: () => process.execPath,
    });

    // 1. ListPlugins preserves availability, update kind, and source.
    const listRes = (await registeredHandlers.get(DshHostIpc.ListPlugins)!({})) as {
      ok: boolean;
      plugins: Array<{
        name: string;
        availability?: string;
        update?: string;
        source?: string;
      }>;
    };
    expect(listRes.plugins.find((p) => p.name === '@acme/demo-tools')).toMatchObject({
      availability: DshPluginAvailability.Profile,
      update: DshPluginUpdateKind.Registry,
      source: '@acme/demo-tools@1.0.0',
    });

    // 2. CheckPluginVersions rejects managed packages and invalid registry URLs.
    expect(
      await registeredHandlers.get(DshHostIpc.CheckPluginVersions)!({}, DSH_HOST_BUNDLE_NAME),
    ).toMatchObject({ ok: false });
    expect(
      await registeredHandlers.get(DshHostIpc.CheckPluginVersions)!({}, {
        name: '@acme/demo-tools',
        registry: 'file:///etc/passwd',
      }),
    ).toMatchObject({ ok: false });

    // 3. CheckPluginVersions succeeds for third-party registry plugin.
    const checkRes = (await registeredHandlers.get(DshHostIpc.CheckPluginVersions)!({}, {
      name: '@acme/demo-tools',
    })) as { ok: boolean; checkedAt?: number; list?: DshPluginVersionList };
    expect(checkRes.ok).toBe(true);
    expect(typeof checkRes.checkedAt).toBe('number');
    expect(checkRes.list?.status).toBe('listed');

    // 4. UpdatePlugin validates inputs.
    expect(
      await registeredHandlers.get(DshHostIpc.UpdatePlugin)!({}, {
        name: DSH_BASE_BUNDLE_NAME,
        version: '0.3.0',
      }),
    ).toMatchObject({ ok: false, outcome: DshPluginUpdateOutcomeKind.CheckRefused });
    expect(
      await registeredHandlers.get(DshHostIpc.UpdatePlugin)!({}, {
        name: '@acme/demo-tools',
        version: '--evil-flag',
      }),
    ).toMatchObject({ ok: false, outcome: DshPluginUpdateOutcomeKind.CheckRefused });

    // 5. UpdatePlugin runs HMR update, preserves profile integrity, and returns updated plugins.
    const updateRes = (await registeredHandlers.get(DshHostIpc.UpdatePlugin)!({}, {
      name: '@acme/demo-tools',
      version: '1.2.0',
      registry: 'https://registry.npmmirror.com/',
      requestId: 'upd-42',
    })) as {
      ok: boolean;
      outcome: string;
      from: string;
      to: string;
      plugins: Array<{ name: string; version?: string }>;
    };
    expect(updateRes).toMatchObject({
      ok: true,
      outcome: DshPluginUpdateOutcomeKind.Applied,
      from: '1.0.0',
      to: '1.2.0',
    });
    expect(updateRes.plugins.find((p) => p.name === '@acme/demo-tools')?.version).toBe('1.2.0');
    expect(updatePluginBundle).toHaveBeenCalledWith('@acme/demo-tools', '1.2.0', {
      registry: 'https://registry.npmmirror.com/',
      requestId: 'upd-42',
    });
    expect(ensureIntegrityMock).toHaveBeenCalledTimes(1);

    // 6. Transport failure returns TransportLost while still calling ensureProfileIntegrity.
    updatePluginBundle.mockRejectedValueOnce(new Error('socket hung up'));
    const lostRes = (await registeredHandlers.get(DshHostIpc.UpdatePlugin)!({}, {
      name: '@acme/demo-tools',
      version: '1.3.0',
    })) as { ok: boolean; outcome: string; error?: string };
    expect(lostRes).toMatchObject({
      ok: false,
      outcome: DshPluginUpdateOutcomeKind.TransportLost,
      error: 'socket hung up',
    });
    expect(ensureIntegrityMock).toHaveBeenCalledTimes(2);

    // 7. Offline host rejects both check and update cleanly.
    hostReady = false;
    expect(
      await registeredHandlers.get(DshHostIpc.CheckPluginVersions)!({}, '@acme/demo-tools'),
    ).toMatchObject({ ok: false, error: 'DSH host is not ready' });
    expect(
      await registeredHandlers.get(DshHostIpc.UpdatePlugin)!({}, {
        name: '@acme/demo-tools',
        version: '1.3.0',
      }),
    ).toMatchObject({
      ok: false,
      outcome: DshPluginUpdateOutcomeKind.TransportLost,
      error: 'DSH host is not ready',
    });
  });

  test('ListPluginModels returns filtered plugin models when host is ready and fails soft when offline', async () => {
    let hostReady = true;
    const listPluginModels = vi.fn(async () => ({
      groups: [
        {
          providerId: 'our-free-model',
          providerName: 'Our Free Model',
          models: [
            {
              id: 'deepseek-v4.1-flash',
              name: 'DeepSeek V4.1 Flash',
              providerId: 'our-free-model',
              providerName: 'Our Free Model',
            },
          ],
        },
      ],
      models: [
        {
          id: 'deepseek-v4.1-flash',
          name: 'DeepSeek V4.1 Flash',
          providerId: 'our-free-model',
          providerName: 'Our Free Model',
        },
      ],
      failures: [],
      fetchedAt: 1000,
    }));
    const manager = {
      isReady: () => hostReady,
      listPluginModels,
    } as unknown as DshHostManager;

    registerDshHostHandlers({
      getHostManager: () => manager,
      getRuntimeDir: () => '/tmp/runtime',
      getExecutablePath: () => '/tmp/electron',
    });

    const readyRes = await registeredHandlers.get(DshHostIpc.ListPluginModels)!({}, { forceRefresh: true });
    expect(readyRes).toMatchObject({
      ok: true,
      fetchedAt: 1000,
      models: [{ id: 'deepseek-v4.1-flash', providerId: 'our-free-model' }],
    });
    expect(listPluginModels).toHaveBeenCalledWith({ forceRefresh: true });

    hostReady = false;
    const offlineRes = await registeredHandlers.get(DshHostIpc.ListPluginModels)!({});
    expect(offlineRes).toMatchObject({ ok: false, groups: [], models: [], failures: [] });
  });

  test('ListAgentPresets and ListPluginSkills filter, sort, and fail soft when host is offline', async () => {
    let hostReady = true;
    const listAgentPresets = vi.fn(async () => [
      { id: 'pi-plus', name: 'Pi+模式', order: 6, isDefault: false },
      { id: 'standard', name: 'standard', order: 1, isDefault: false },
      { id: 'broken-mode', name: 'Broken', order: 1, broken: 'missing', isDefault: false },
      { id: 'lobsterai', name: 'LobsterAI', order: 0, isDefault: true },
      { id: 'pi', name: 'Pi 模式', order: 5, isDefault: false },
    ]);
    const listPluginSkills = vi.fn(async () => [
      {
        name: 'guizang-page',
        description: 'Page design skill',
        provider: 'guizang-design',
        modelInvocable: true,
        userInvocable: true,
      },
    ]);
    const manager = {
      isReady: () => hostReady,
      listAgentPresets,
      listPluginSkills,
    } as unknown as DshHostManager;

    registerDshHostHandlers({
      getHostManager: () => manager,
      getRuntimeDir: () => '/tmp/runtime',
      getExecutablePath: () => '/tmp/electron',
    });

    const presetRes = await registeredHandlers.get(DshHostIpc.ListAgentPresets)!({});
    expect(presetRes).toMatchObject({
      ok: true,
      hasThirdPartyPresets: true,
      defaultPresetId: 'lobsterai',
    });
    expect(
      (presetRes as { usablePresets: Array<{ id: string }> }).usablePresets.map((p) => p.id),
    ).toEqual(['lobsterai', 'standard', 'pi', 'pi-plus']);

    // Built-in DSH developer presets alone do not count as third-party presets.
    listAgentPresets.mockResolvedValueOnce([
      { id: 'lobsterai', name: 'LobsterAI', order: 0, isDefault: true },
      { id: 'standard', name: 'standard', order: 1, isDefault: false },
      { id: 'ptc', name: 'ptc', order: 2, isDefault: false },
    ]);
    expect(await registeredHandlers.get(DshHostIpc.ListAgentPresets)!({})).toMatchObject({
      ok: true,
      hasThirdPartyPresets: false,
    });

    const skillRes = await registeredHandlers.get(DshHostIpc.ListPluginSkills)!({}, { cwd: '/tmp/proj' });
    expect(skillRes).toEqual({
      ok: true,
      skills: [
        {
          name: 'guizang-page',
          description: 'Page design skill',
          provider: 'guizang-design',
          modelInvocable: true,
          userInvocable: true,
        },
      ],
    });
    expect(listPluginSkills).toHaveBeenCalledWith('/tmp/proj');

    hostReady = false;
    expect(await registeredHandlers.get(DshHostIpc.ListAgentPresets)!({})).toMatchObject({
      ok: false,
      usablePresets: [],
      hasThirdPartyPresets: false,
    });
    expect(await registeredHandlers.get(DshHostIpc.ListPluginSkills)!({})).toEqual({
      ok: false,
      skills: [],
    });
  });
});
