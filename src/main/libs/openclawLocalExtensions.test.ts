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
import { removeTreeNoFollowSync } from './removeTreeNoFollow';

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
    removeTreeNoFollowSync(root);
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

  test.each(['nested', 'root', 'dangling'])('removes a stale plugin with a %s junction without touching its target', (kind) => {
    const sentinel = writeManifest('dist/extensions', 'openai');
    const sentinelFile = path.join(sentinel, 'worker.js');
    fs.writeFileSync(sentinelFile, 'runtime worker must survive');
    const stale = path.join(runtime, 'extensions', 'ordinary-plugin');
    const link = kind === 'nested' ? path.join(stale, 'node_modules', 'openclaw') : stale;
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(kind === 'dangling' ? path.join(root, 'absent') : sentinel, link, 'junction');

    expect(cleanupStaleThirdPartyPluginsFromBundledDir(runtime, ['ordinary-plugin']))
      .toEqual(['ordinary-plugin']);
    expect(fs.lstatSync(stale, { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.readFileSync(sentinelFile, 'utf8')).toBe('runtime worker must survive');
  });

  test('reports cleanup failure without reporting a removal and can retry', () => {
    const stale = writeManifest('extensions', 'ordinary-plugin');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const originalRmdir = fs.rmdirSync;
    const removal = vi.spyOn(fs, 'rmdirSync').mockImplementation((target, options) => {
      if (target === stale) throw Object.assign(new Error('locked'), { code: 'EPERM' });
      return originalRmdir(target, options);
    });
    expect(cleanupStaleThirdPartyPluginsFromBundledDir(runtime, ['ordinary-plugin'])).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    removal.mockRestore();
    expect(cleanupStaleThirdPartyPluginsFromBundledDir(runtime, ['ordinary-plugin'])).toEqual(['ordinary-plugin']);
  });
});
