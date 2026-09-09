import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const environment = vi.hoisted(() => ({ appPath: '', packaged: false }));
vi.mock('electron', () => ({
  app: {
    get isPackaged() { return environment.packaged; },
    getAppPath: () => environment.appPath,
  },
}));

import {
  cleanupStaleThirdPartyPluginsFromBundledDir,
  listBundledOpenClawExtensionIds,
  listBundledOpenClawExtensionManifests,
  resolveOpenClawExtensionPluginId,
} from './openclawLocalExtensions';

describe('runtime-bundled preinstalled extensions', () => {
  const originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
  let root: string;
  let runtime: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-extension-layout-'));
    environment.appPath = root;
    environment.packaged = false;
    runtime = path.join(root, 'vendor', 'openclaw-runtime', 'current');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ openclaw: { plugins: [
      { id: 'discord', npm: '@openclaw/discord', runtimeBundled: true },
      { id: 'ordinary-plugin', npm: 'ordinary-plugin' },
    ] } }));
    // Electron adds this property to process at runtime.
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      get: () => path.join(root, 'resources'),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalResourcesPath) Object.defineProperty(process, 'resourcesPath', originalResourcesPath);
    else Reflect.deleteProperty(process, 'resourcesPath');
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeManifest(base: string, directoryId: string, pluginId = directoryId): string {
    const dir = path.join(runtime, base, directoryId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'openclaw.plugin.json'), JSON.stringify({ id: pluginId }));
    return dir;
  }

  test.each([false, true])('resolves Discord for config sync (packaged=%s)', (packaged) => {
    environment.packaged = packaged;
    if (packaged) {
      runtime = path.join(root, 'resources', 'cfmind');
    }
    const discordDir = writeManifest('dist/extensions', 'discord');
    writeManifest('dist/extensions', 'openai');
    writeManifest('third-party-extensions', 'ordinary-plugin', 'ordinary-channel');
    expect(resolveOpenClawExtensionPluginId('discord')).toBe('discord');
    expect(resolveOpenClawExtensionPluginId('ordinary-plugin')).toBe('ordinary-channel');
    expect(listBundledOpenClawExtensionIds().sort()).toEqual(['discord', 'ordinary-plugin']);
    expect(listBundledOpenClawExtensionManifests().find(item => item.pluginId === 'discord')?.directory)
      .toBe(discordDir);
  });

  test('preserves shipped Discord during startup cleanup but removes stale third-party copies', () => {
    const discord = writeManifest('dist/extensions', 'discord');
    const legacyDiscord = writeManifest('extensions', 'discord');
    const ordinary = writeManifest('dist/extensions', 'ordinary-plugin');
    const core = writeManifest('dist/extensions', 'openai');
    cleanupStaleThirdPartyPluginsFromBundledDir(runtime, ['discord', 'ordinary-plugin']);
    expect(fs.existsSync(discord)).toBe(true);
    expect(fs.existsSync(core)).toBe(true);
    expect(fs.existsSync(legacyDiscord)).toBe(false);
    expect(fs.existsSync(ordinary)).toBe(false);
  });
});
