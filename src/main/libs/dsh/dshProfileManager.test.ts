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
  ensureAppOwnedProfile,
  mergeAppOwnedProfileManifest,
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
    expect(winText).toContain('--expose-internals');
  });
});
