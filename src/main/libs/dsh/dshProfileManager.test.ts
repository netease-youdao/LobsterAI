import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  DSH_BASE_BUNDLE_NAME,
  DSH_CHANNELS_BUNDLE_NAME,
  DSH_HOST_BUNDLE_NAME,
  DSH_WEB_APP_BUNDLE_NAME,
} from '../../../shared/dshEngine/hostConstants';
import {
  buildIsolatedPnpmCacheEnv,
  ensureAppOwnedProfile,
  ensureDshLauncher,
  mergeAppOwnedProfileManifest,
  resolveBundledPnpmEntry,
  resolveDshLauncherPath,
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
    const pnpmWorkspacePath = path.join(profileDir, 'pnpm-workspace.yaml');
    expect(fs.existsSync(pnpmWorkspacePath)).toBe(true);
    const workspaceYaml = fs.readFileSync(pnpmWorkspacePath, 'utf8');
    expect(workspaceYaml).toContain('nodeLinker: hoisted');
    expect(workspaceYaml).toContain('autoInstallPeers: false');

    const userPatch = '- id: custom-user-row\n  config:\n    foo: bar\n';
    fs.writeFileSync(first.patchPath, userPatch, 'utf8');
    const userWorkspace = `${workspaceYaml}allowBuilds:\n  esbuild: true\n`;
    fs.writeFileSync(pnpmWorkspacePath, userWorkspace, 'utf8');

    ensureAppOwnedProfile({ profileDir, hostBundleDir });
    expect(fs.readFileSync(first.patchPath, 'utf8')).toBe(userPatch);
    expect(fs.readFileSync(pnpmWorkspacePath, 'utf8')).toBe(userWorkspace);
  });
});

describe('writeDshCliShim', () => {
  test('generates POSIX and Windows CLI shims with ELECTRON_RUN_AS_NODE and --expose-internals', () => {
    const root = createTempDir();
    const binDir = path.join(root, 'bin');

    const posixShim = writeDshCliShim({
      binDir,
      electronPath: '/Applications/LobsterAI.app/Contents/MacOS/LobsterAI',
      runtimeEntryPath: '/Applications/LobsterAI.app/Contents/Resources/dsh-runtime/lib/bin.js',
      profileDir: path.join(root, 'dsh-profile'),
      dshHomeDir: path.join(root, 'dsh-home'),
      platform: 'darwin',
    });
    const posixText = fs.readFileSync(posixShim, 'utf8');
    expect(posixText).toContain('ELECTRON_RUN_AS_NODE=1');
    expect(posixText).toContain('DSH_AGENTS_HOME=');
    expect(posixText).toContain('DSH_TELEMETRY_DISABLED=1');
    expect(posixText).toContain('pnpm_config_store_dir=');
    expect(posixText).toContain('pnpm_config_cache_dir=');
    expect(posixText).toContain('npm_config_store_dir=');
    expect(posixText).toContain('--expose-internals');

    const winShim = writeDshCliShim({
      binDir,
      electronPath: 'C:\\Program Files\\LobsterAI\\LobsterAI.exe',
      runtimeEntryPath: 'C:\\Program Files\\LobsterAI\\resources\\dsh-runtime\\lib\\bin.js',
      profileDir: 'C:\\Users\\demo\\AppData\\Roaming\\LobsterAI\\dsh-profile',
      dshHomeDir: 'C:\\Users\\demo\\AppData\\Roaming\\LobsterAI\\dsh-home',
      platform: 'win32',
    });
    expect(path.basename(winShim)).toBe('dsh.cmd');
    const winText = fs.readFileSync(winShim, 'utf8');
    expect(winText).toContain('set ELECTRON_RUN_AS_NODE=1');
    expect(winText).toContain('set "DSH_AGENTS_HOME=');
    expect(winText).toContain('set "DSH_TELEMETRY_DISABLED=1"');
    expect(winText).toContain('set "pnpm_config_store_dir=');
    expect(winText).toContain('set "pnpm_config_cache_dir=');
    expect(winText).toContain('set "npm_config_store_dir=');
    expect(winText).toContain('--expose-internals');
  });

  test('points CLI shim at generated bundled-pnpm launcher when launcherPath is supplied', () => {
    const root = createTempDir();
    const binDir = path.join(root, 'bin');
    const dshHomeDir = path.join(root, 'dsh-home');
    const launcherPath = resolveDshLauncherPath(dshHomeDir);

    const shim = writeDshCliShim({
      binDir,
      electronPath: '/Applications/LobsterAI.app/Contents/MacOS/LobsterAI',
      runtimeEntryPath: '/runtime/lib/bin.js',
      launcherPath,
      profileDir: path.join(dshHomeDir, 'profiles', 'lobsterai'),
      dshHomeDir,
      platform: 'darwin',
    });
    const text = fs.readFileSync(shim, 'utf8');
    expect(text).toContain(launcherPath);
    expect(text).not.toContain('/runtime/lib/bin.js');
  });
});

describe('ensureDshLauncher & buildIsolatedPnpmCacheEnv', () => {
  test('pins both pnpm_config_* and npm_config_* under <dshHomeDir>/cache', () => {
    const posixEnv = buildIsolatedPnpmCacheEnv('/tmp/dsh-home', 'darwin');
    expect(posixEnv).toEqual({
      pnpm_config_store_dir: '/tmp/dsh-home/cache/pnpm-store',
      pnpm_config_cache_dir: '/tmp/dsh-home/cache/pnpm-cache',
      npm_config_store_dir: '/tmp/dsh-home/cache/pnpm-store',
      npm_config_cache: '/tmp/dsh-home/cache/npm-cache',
    });

    const winEnv = buildIsolatedPnpmCacheEnv('C:\\Users\\demo\\dsh-home', 'win32');
    expect(winEnv.pnpm_config_store_dir).toBe('C:\\Users\\demo\\dsh-home\\cache\\pnpm-store');
    expect(winEnv.pnpm_config_cache_dir).toBe('C:\\Users\\demo\\dsh-home\\cache\\pnpm-cache');
  });

  test('generates <dshHomeDir>/dsh-launcher/launch.mjs wired with bundled pnpm and isolated caches', () => {
    const root = createTempDir();
    const dshHomeDir = path.join(root, 'dsh-home');
    const runtimeDir = path.join(root, 'runtime');
    const binPath = path.join(runtimeDir, 'lib', 'bin.js');
    const pnpmDir = path.join(runtimeDir, 'package-manager', 'pnpm');
    const pnpmBin = path.join(pnpmDir, 'bin', 'pnpm.mjs');

    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    fs.writeFileSync(binPath, 'export async function runCli() {}\n', 'utf8');
    fs.mkdirSync(path.dirname(pnpmBin), { recursive: true });
    fs.writeFileSync(
      path.join(pnpmDir, 'package.json'),
      JSON.stringify({ name: 'pnpm', bin: { pnpm: 'bin/pnpm.mjs' } }),
      'utf8',
    );
    fs.writeFileSync(pnpmBin, '// fake pnpm\n', 'utf8');

    expect(resolveBundledPnpmEntry(runtimeDir)).toBe(fs.realpathSync(pnpmBin));

    const launchEntry = ensureDshLauncher({
      dshHomeDir,
      runtimeDir,
      executablePath: '/Apps/Electron',
      toolchain: { nodeShimDir: '/shims', npmBinDir: '/npm/bin', gitBinDir: null },
      baseEnv: { PATH: '' },
      delimiter: ':',
      platform: 'darwin',
    });

    expect(launchEntry).toBe(resolveDshLauncherPath(dshHomeDir));
    const source = fs.readFileSync(launchEntry, 'utf8');
    expect(source).toContain('runCli');
    expect(source).toContain(fs.realpathSync(pnpmBin));
    expect(source).toContain('"pnpm_config_store_dir"');
    expect(source).toContain('"pnpm_config_cache_dir"');
    expect(source).toContain('/shims');
  });

  test('falls back to runtime lib/bin.js when runtime bundles no pnpm', () => {
    const root = createTempDir();
    const dshHomeDir = path.join(root, 'dsh-home');
    const runtimeDir = path.join(root, 'runtime');
    const binPath = path.join(runtimeDir, 'lib', 'bin.js');
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    fs.writeFileSync(binPath, 'export async function runCli() {}\n', 'utf8');

    const launchEntry = ensureDshLauncher({
      dshHomeDir,
      runtimeDir,
      executablePath: '/Apps/Electron',
    });
    expect(launchEntry).toBe(fs.realpathSync(binPath));
  });
});
