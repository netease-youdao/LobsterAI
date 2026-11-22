import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  DSH_BASE_BUNDLE_NAME,
  DSH_CHANNELS_BUNDLE_NAME,
  DSH_HOST_BUNDLE_NAME,
  DSH_PROFILE_NAME,
  DSH_WEB_APP_BUNDLE_NAME,
} from '../../../shared/dshEngine/hostConstants';
import {
  buildIsolatedDshBaseEnv,
  ensureAppOwnedProfile,
  mergeAppOwnedProfileManifest,
  prepareDshLaunchEntry,
  resolveBundledPnpmEntry,
  writeDshCliShim,
} from './dshProfileManager';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-dsh-profile-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('mergeAppOwnedProfileManifest', () => {
  test('initializes core bundle order and links host bundle', () => {
    const result = mergeAppOwnedProfileManifest(null, {
      hostBundleDir: '/opt/lobsterai/dsh-bundles/lobsterai-host',
    });

    expect(result.bundles).toEqual([
      DSH_BASE_BUNDLE_NAME,
      DSH_WEB_APP_BUNDLE_NAME,
      DSH_HOST_BUNDLE_NAME,
    ]);
    expect(result.preservedUserBundles).toEqual([]);
    expect(result.manifest.dependencies?.[DSH_HOST_BUNDLE_NAME]).toMatch(/^file:/);
    expect(result.manifest.dependencies?.[DSH_CHANNELS_BUNDLE_NAME]).toBeUndefined();
  });

  test('preserves user-installed bundles and dependencies across upgrades', () => {
    const existing = {
      name: 'lobsterai-dsh-profile',
      private: true,
      dependencies: {
        '@lobsterai/dsh-bundle': 'file:///old/path',
        '@xmanrui/dsh-im': '1.2.0',
        '@deepseek-ai/dsh-subagent-claude-code': '0.2.2-rc.5',
      },
      dsh: {
        profile: {
          bundles: [
            DSH_BASE_BUNDLE_NAME,
            '@xmanrui/dsh-im',
            DSH_WEB_APP_BUNDLE_NAME,
            '@deepseek-ai/dsh-experimental-agent-team-profile',
            '@deepseek-ai/dsh-subagent-claude-code',
          ],
        },
      },
    };

    const result = mergeAppOwnedProfileManifest(existing, {
      hostBundleDir: '/new/lobsterai/dsh-bundles/lobsterai-host',
      channelsBundleDir: '/new/lobsterai/dsh-bundles/lobsterai-channels',
    });

    expect(result.bundles).toEqual([
      DSH_BASE_BUNDLE_NAME,
      DSH_WEB_APP_BUNDLE_NAME,
      DSH_HOST_BUNDLE_NAME,
      DSH_CHANNELS_BUNDLE_NAME,
      '@xmanrui/dsh-im',
      '@deepseek-ai/dsh-experimental-agent-team-profile',
      '@deepseek-ai/dsh-subagent-claude-code',
    ]);
    expect(result.preservedUserBundles).toEqual([
      '@xmanrui/dsh-im',
      '@deepseek-ai/dsh-experimental-agent-team-profile',
      '@deepseek-ai/dsh-subagent-claude-code',
    ]);
    expect(result.manifest.dependencies?.['@xmanrui/dsh-im']).toBe('1.2.0');
    expect(result.manifest.dependencies?.[DSH_HOST_BUNDLE_NAME]).toContain('/new/lobsterai/dsh-bundles/lobsterai-host');
    expect(result.manifest.dependencies?.[DSH_CHANNELS_BUNDLE_NAME]).toContain('/new/lobsterai/dsh-bundles/lobsterai-channels');
  });
});

describe('ensureAppOwnedProfile', () => {
  test('creates valid manifest and empty cordis.patch.yml without clobbering user edits', () => {
    const root = createTempDir();
    const profileDir = path.join(root, 'dsh-profile');
    const hostBundleDir = path.join(root, 'host-bundle');

    const first = ensureAppOwnedProfile({ profileDir, hostBundleDir });
    expect(fs.existsSync(first.manifestPath)).toBe(true);
    expect(fs.readFileSync(first.patchPath, 'utf8')).toBe('[]\n');

    const userPatch = '- id: custom-user-row\n  config:\n    foo: bar\n';
    fs.writeFileSync(first.patchPath, userPatch, 'utf8');

    ensureAppOwnedProfile({ profileDir, hostBundleDir });
    expect(fs.readFileSync(first.patchPath, 'utf8')).toBe(userPatch);
  });
});

function createMockRuntime(root: string, options: { withBundledPnpm?: boolean } = {}): {
  runtimeDir: string;
  pnpmEntry: string | null;
} {
  const runtimeDir = path.join(root, 'mock-runtime');
  fs.mkdirSync(path.join(runtimeDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'package.json'), JSON.stringify({ name: 'mock-dsh', type: 'module' }));
  fs.writeFileSync(
    path.join(runtimeDir, 'lib', 'bin.js'),
    [
      'export async function runCli(opts = {}) {',
      '  console.log(JSON.stringify({',
      '    args: process.argv.slice(2),',
      '    packageManager: opts.packageManager ?? null,',
      '    env: {',
      '      DSH_HOME: process.env.DSH_HOME ?? null,',
      '      DSH_AGENTS_HOME: process.env.DSH_AGENTS_HOME ?? null,',
      '      DSH_PROFILE: process.env.DSH_PROFILE ?? null,',
      '      dsh_custom: process.env.dsh_custom ?? null,',
      '      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? null,',
      '      DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL ?? null,',
      '      PNPM_HOME: process.env.PNPM_HOME ?? null,',
      '      npm_config_userconfig: process.env.npm_config_userconfig ?? null,',
      '      npm_config_globalconfig: process.env.npm_config_globalconfig ?? null,',
      '      npm_config_store_dir: process.env.npm_config_store_dir ?? null,',
      '      npm_config_cache: process.env.npm_config_cache ?? null,',
      '      ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? null,',
      '    },',
      '  }));',
      '}',
      'if (import.meta.main) await runCli();',
      '',
    ].join('\n'),
  );

  let pnpmEntry: string | null = null;
  if (options.withBundledPnpm) {
    const pnpmDir = path.join(runtimeDir, 'package-manager', 'pnpm');
    fs.mkdirSync(path.join(pnpmDir, 'bin'), { recursive: true });
    fs.writeFileSync(
      path.join(pnpmDir, 'package.json'),
      JSON.stringify({ name: 'pnpm', version: '11.28.5', bin: { pnpm: 'bin/pnpm.mjs' } }),
    );
    pnpmEntry = path.join(pnpmDir, 'bin', 'pnpm.mjs');
    fs.writeFileSync(pnpmEntry, 'console.log("11.28.5");\n');
  }
  return { runtimeDir, pnpmEntry };
}

describe('buildIsolatedDshBaseEnv', () => {
  test('strips official dsh, DeepSeek credential/endpoint, and global pnpm/npm config env vars', () => {
    const root = createTempDir();
    const dshHomeDir = path.join(root, 'dsh-home');
    const env = buildIsolatedDshBaseEnv({
      baseEnv: {
        PATH: '/usr/bin',
        HOME: '/Users/alice',
        DSH_HOME: '/Users/alice/.dsh',
        DSH_PROFILE: 'web',
        dsh_custom: 'leak',
        DEEPSEEK_API_KEY: 'sk-official-leak',
        DEEPSEEK_BASE_URL: 'https://official.example',
        DEEPSEEK_SEARCH_BASE_URL: 'https://search.example',
        PNPM_HOME: '/Users/alice/.local/share/pnpm',
        pnpm_config_store_dir: '/Users/alice/.local/share/pnpm/v11',
        pnpm_config_cache_dir: '/Users/alice/.cache/pnpm',
        pnpm_config_userconfig: '/Users/alice/.pnpmrc',
        npm_config_store_dir: '/Users/alice/.pnpm-store',
        npm_config_cache: '/Users/alice/.npm',
        npm_config_userconfig: '/Users/alice/.npmrc',
        npm_config_globalconfig: '/etc/npmrc',
        NPM_CONFIG_USERCONFIG: '/Users/alice/.npmrc-upper',
      },
      dshHomeDir,
    });

    expect(env.DSH_HOME).toBe(dshHomeDir);
    expect(env.DSH_AGENTS_HOME).toBe(path.join(dshHomeDir, 'agents-home'));
    expect(env.DSH_TELEMETRY_DISABLED).toBe('1');
    expect(env.pnpm_config_store_dir).toBe(path.join(dshHomeDir, 'cache', 'pnpm-store'));
    expect(env.pnpm_config_cache_dir).toBe(path.join(dshHomeDir, 'cache', 'pnpm-cache'));
    expect(env.pnpm_config_userconfig).toBeUndefined();
    expect(env.npm_config_store_dir).toBe(path.join(dshHomeDir, 'cache', 'pnpm-store'));
    expect(env.npm_config_cache).toBe(path.join(dshHomeDir, 'cache', 'npm-cache'));
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(env.DSH_PROFILE).toBeUndefined();
    expect(env.dsh_custom).toBeUndefined();
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.DEEPSEEK_BASE_URL).toBeUndefined();
    expect(env.DEEPSEEK_SEARCH_BASE_URL).toBeUndefined();
    expect(env.PNPM_HOME).toBeUndefined();
    expect(env.npm_config_userconfig).toBeUndefined();
    expect(env.npm_config_globalconfig).toBeUndefined();
    expect(env.NPM_CONFIG_USERCONFIG).toBeUndefined();
    expect(env.HOME).toBe('/Users/alice');
    expect(env.PATH).toBe('/usr/bin');
  });
});

describe('prepareDshLaunchEntry', () => {
  test('generates bundled-pnpm launcher wiring runCli({ packageManager }) when bundled pnpm exists', () => {
    const root = createTempDir();
    const dshHomeDir = path.join(root, 'dsh-home');
    const { runtimeDir, pnpmEntry } = createMockRuntime(root, { withBundledPnpm: true });

    expect(resolveBundledPnpmEntry(runtimeDir)).toBe(pnpmEntry);

    const prepared = prepareDshLaunchEntry({
      runtimeDir,
      dshHomeDir,
      electronPath: process.execPath,
      toolchain: { nodeShimDir: '/fake/shims', npmBinDir: '/fake/npm/bin', gitBinDir: null },
      baseEnv: { PATH: '' },
    });

    expect(prepared.usesBundledPnpm).toBe(true);
    expect(prepared.entryPath).toBe(path.join(dshHomeDir, 'dsh-launcher', 'launch.mjs'));
    expect(fs.existsSync(prepared.entryPath)).toBe(true);

    const run = spawnSync(process.execPath, [prepared.entryPath, '--profile', DSH_PROFILE_NAME, '--dump-config'], {
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    const output = JSON.parse(run.stdout) as {
      args: string[];
      packageManager: { command: string; args: string[]; env: Record<string, string> };
    };
    expect(output.args).toEqual(['--profile', DSH_PROFILE_NAME, '--dump-config']);
    expect(output.packageManager.command).toBe(process.execPath);
    expect(output.packageManager.args).toEqual([pnpmEntry]);
    expect(output.packageManager.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(output.packageManager.env.LOBSTERAI_NPM_BIN_DIR).toBe('/fake/npm/bin');
    expect(output.packageManager.env.PATH).toBe('/fake/shims');
  });

  test('falls back cleanly to lib/bin.js when runtime bundles no pnpm', () => {
    const root = createTempDir();
    const dshHomeDir = path.join(root, 'dsh-home');
    const { runtimeDir } = createMockRuntime(root, { withBundledPnpm: false });

    expect(resolveBundledPnpmEntry(runtimeDir)).toBeNull();
    const prepared = prepareDshLaunchEntry({
      runtimeDir,
      dshHomeDir,
      electronPath: process.execPath,
    });
    expect(prepared.usesBundledPnpm).toBe(false);
    expect(prepared.entryPath).toBe(path.join(runtimeDir, 'lib', 'bin.js'));
  });
});

describe('writeDshCliShim', () => {
  test('generates POSIX and Windows CLI shims with env scrubbing, default profile, and launcher wiring', () => {
    const root = createTempDir();
    const binDir = path.join(root, 'bin');

    const posixShim = writeDshCliShim({
      binDir,
      electronPath: '/Applications/LobsterAI.app/Contents/MacOS/LobsterAI',
      runtimeEntryPath: '/Applications/LobsterAI.app/Contents/Resources/dsh-launcher/launch.mjs',
      profileDir: path.join(root, 'dsh-profile'),
      dshHomeDir: path.join(root, 'dsh-home'),
      platform: 'darwin',
    });
    const posixText = fs.readFileSync(posixShim, 'utf8');
    expect(posixText).toContain('#!/bin/sh');
    expect(posixText).toContain('DEEPSEEK_API_KEY');
    expect(posixText).toContain('PNPM_HOME');
    expect(posixText).toContain('npm_config_userconfig');
    expect(posixText).toContain('ELECTRON_RUN_AS_NODE=1');
    expect(posixText).toContain('DSH_AGENTS_HOME=');
    expect(posixText).toContain('DSH_TELEMETRY_DISABLED=1');
    expect(posixText).toContain('npm_config_store_dir=');
    expect(posixText).toContain('--expose-internals');
    expect(posixText).toContain(`--profile '${DSH_PROFILE_NAME}'`);

    const winShim = writeDshCliShim({
      binDir,
      electronPath: 'C:\\Program Files\\LobsterAI\\LobsterAI.exe',
      runtimeEntryPath: 'C:\\Users\\demo\\AppData\\Roaming\\LobsterAI\\dsh-home\\dsh-launcher\\launch.mjs',
      profileDir: 'C:\\Users\\demo\\AppData\\Roaming\\LobsterAI\\dsh-profile',
      dshHomeDir: 'C:\\Users\\demo\\AppData\\Roaming\\LobsterAI\\dsh-home',
      platform: 'win32',
    });
    expect(path.basename(winShim)).toBe('dsh.cmd');
    const winText = fs.readFileSync(winShim, 'utf8');
    expect(winText).toContain('for /f "delims==" %%V in (\'set DSH_ 2^>nul\') do set "%%V="');
    expect(winText).toContain('set "DEEPSEEK_API_KEY="');
    expect(winText).toContain('set "PNPM_HOME="');
    expect(winText).toContain('set "npm_config_userconfig="');
    expect(winText).toContain('set ELECTRON_RUN_AS_NODE=1');
    expect(winText).toContain('set "DSH_AGENTS_HOME=');
    expect(winText).toContain('set "DSH_TELEMETRY_DISABLED=1"');
    expect(winText).toContain('set "npm_config_store_dir=');
    expect(winText).toContain('--expose-internals');
    expect(winText).toContain(`--profile ${DSH_PROFILE_NAME}`);
  });

  test.skipIf(process.platform === 'win32')(
    'POSIX shim strips official env vars, defaults --profile lobsterai, and runs bundled pnpm launcher even with empty PATH',
    () => {
      const root = createTempDir();
      const dshHomeDir = path.join(root, 'dsh-home');
      const profileDir = path.join(dshHomeDir, 'profiles', DSH_PROFILE_NAME);
      const binDir = path.join(dshHomeDir, 'bin');
      const { runtimeDir, pnpmEntry } = createMockRuntime(root, { withBundledPnpm: true });

      const shimPath = writeDshCliShim({
        binDir,
        electronPath: process.execPath,
        runtimeDir,
        profileDir,
        dshHomeDir,
        baseEnv: { PATH: '' },
      });

      const runShim = (args: string[]) => {
        const res = spawnSync(shimPath, args, {
          encoding: 'utf8',
          env: {
            PATH: '',
            DSH_HOME: '/fake/official/.dsh',
            DSH_PROFILE: 'official-desktop',
            dsh_custom: 'leak-me',
            DEEPSEEK_API_KEY: 'sk-official-leak-test',
            DEEPSEEK_BASE_URL: 'https://official.invalid',
            PNPM_HOME: '/fake/global/pnpm',
            npm_config_userconfig: '/fake/global/.npmrc',
            npm_config_globalconfig: '/fake/global/npmrc',
          },
        });
        expect(res.status, `stderr=${res.stderr}`).toBe(0);
        return JSON.parse(res.stdout) as {
          args: string[];
          packageManager: { command: string; args: string[] } | null;
          env: Record<string, string | null>;
        };
      };

      // 1. Flag-only invocation defaults --profile lobsterai & scrubs all official env vars.
      const dumpRes = runShim(['--dump-config']);
      expect(dumpRes.args).toEqual(['--profile', DSH_PROFILE_NAME, '--dump-config']);
      expect(dumpRes.packageManager?.command).toBe(process.execPath);
      expect(dumpRes.packageManager?.args).toEqual([pnpmEntry]);
      expect(dumpRes.env).toEqual({
        DSH_HOME: dshHomeDir,
        DSH_AGENTS_HOME: path.join(dshHomeDir, 'agents-home'),
        DSH_PROFILE: null,
        dsh_custom: null,
        DEEPSEEK_API_KEY: null,
        DEEPSEEK_BASE_URL: null,
        PNPM_HOME: null,
        npm_config_userconfig: null,
        npm_config_globalconfig: null,
        npm_config_store_dir: path.join(dshHomeDir, 'cache', 'pnpm-store'),
        npm_config_cache: path.join(dshHomeDir, 'cache', 'npm-cache'),
        ELECTRON_RUN_AS_NODE: '1',
      });

      // 2. Zero-arg invocation defaults --profile lobsterai.
      expect(runShim([]).args).toEqual(['--profile', DSH_PROFILE_NAME]);

      // 3. `plugin` subcommand injects --profile lobsterai after `plugin` when omitted.
      expect(runShim(['plugin', 'add', '@foo/bar']).args).toEqual([
        'plugin',
        '--profile',
        DSH_PROFILE_NAME,
        'add',
        '@foo/bar',
      ]);

      // 4. Explicit --profile (flag or =form), help/version, and positional profiles are preserved.
      expect(runShim(['plugin', '--profile', 'custom', 'add', '@foo/bar']).args).toEqual([
        'plugin',
        '--profile',
        'custom',
        'add',
        '@foo/bar',
      ]);
      expect(runShim(['plugin', '--help']).args).toEqual(['plugin', '--help']);
      expect(runShim(['--profile=custom', '--dump-config']).args).toEqual(['--profile=custom', '--dump-config']);
      expect(runShim(['--version']).args).toEqual(['--version']);
      expect(runShim(['headless', 'hello world']).args).toEqual(['headless', 'hello world']);
    },
  );
});
