import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test, vi } from 'vitest';

import {
  cleanupPluginInstallStagingDir,
  createPluginInstallStagingDir,
  publishStagedPluginDirectory,
} from './pluginInstallPublisher';

const tempRoots: string[] = [];

const createTempRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-plugin-publish-test-'));
  tempRoots.push(root);
  return root;
};

const writePlugin = (pluginDir: string, pluginId: string, marker: string): void => {
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'openclaw.plugin.json'),
    JSON.stringify({ id: pluginId }),
    'utf8',
  );
  fs.writeFileSync(path.join(pluginDir, 'marker.txt'), marker, 'utf8');
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('creates install staging beside the scanned extensions directory', async () => {
  const root = createTempRoot();
  const extensionsDir = path.join(root, 'third-party-extensions');
  fs.mkdirSync(extensionsDir, { recursive: true });

  const stagingDir = createPluginInstallStagingDir(extensionsDir);

  expect(path.dirname(path.dirname(stagingDir))).toBe(root);
  expect(stagingDir.startsWith(`${extensionsDir}${path.sep}`)).toBe(false);
  expect(fs.statSync(stagingDir).isDirectory()).toBe(true);

  await cleanupPluginInstallStagingDir(stagingDir);
  expect(fs.existsSync(stagingDir)).toBe(false);
});

test('publishes a staged plugin without recreating its runtime junction', async () => {
  const root = createTempRoot();
  const extensionsDir = path.join(root, 'third-party-extensions');
  const stagingDir = createPluginInstallStagingDir(extensionsDir);
  const stagedPluginDir = path.join(stagingDir, 'extensions', 'memory-tencentdb');
  const targetPluginDir = path.join(extensionsDir, 'memory-tencentdb');
  const runtimeDir = path.join(root, 'runtime');
  const runtimeLink = path.join(stagedPluginDir, 'node_modules', 'openclaw');

  writePlugin(stagedPluginDir, 'memory-tencentdb', 'new');
  fs.mkdirSync(path.dirname(runtimeLink), { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'openclaw.mjs'), 'runtime', 'utf8');
  fs.symlinkSync(runtimeDir, runtimeLink, process.platform === 'win32' ? 'junction' : 'dir');

  await publishStagedPluginDirectory(stagedPluginDir, targetPluginDir, 'memory-tencentdb');

  const publishedLink = path.join(targetPluginDir, 'node_modules', 'openclaw');
  expect(fs.lstatSync(publishedLink).isSymbolicLink()).toBe(true);
  expect(fs.realpathSync(publishedLink)).toBe(fs.realpathSync(runtimeDir));
  expect(fs.readFileSync(path.join(targetPluginDir, 'marker.txt'), 'utf8')).toBe('new');
});

test('restores a valid existing plugin when publishing the replacement fails', async () => {
  const root = createTempRoot();
  const extensionsDir = path.join(root, 'third-party-extensions');
  const stagingDir = createPluginInstallStagingDir(extensionsDir);
  const stagedPluginDir = path.join(stagingDir, 'extensions', 'example-plugin');
  const targetPluginDir = path.join(extensionsDir, 'example-plugin');
  writePlugin(stagedPluginDir, 'example-plugin', 'new');
  writePlugin(targetPluginDir, 'example-plugin', 'old');

  const rename = fs.promises.rename.bind(fs.promises);
  let renameCall = 0;
  vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
    renameCall += 1;
    if (renameCall === 2) {
      throw new Error('simulated publish failure');
    }
    await rename(source, destination);
  });

  await expect(
    publishStagedPluginDirectory(stagedPluginDir, targetPluginDir, 'example-plugin'),
  ).rejects.toThrow('simulated publish failure');

  expect(renameCall).toBe(3);
  expect(fs.readFileSync(path.join(targetPluginDir, 'marker.txt'), 'utf8')).toBe('old');
});

test('discards an incomplete existing directory when publishing fails', async () => {
  const root = createTempRoot();
  const extensionsDir = path.join(root, 'third-party-extensions');
  const stagingDir = createPluginInstallStagingDir(extensionsDir);
  const stagedPluginDir = path.join(stagingDir, 'extensions', 'example-plugin');
  const targetPluginDir = path.join(extensionsDir, 'example-plugin');
  writePlugin(stagedPluginDir, 'example-plugin', 'new');
  fs.mkdirSync(targetPluginDir, { recursive: true });
  fs.writeFileSync(path.join(targetPluginDir, 'partial.txt'), 'partial', 'utf8');

  const rename = fs.promises.rename.bind(fs.promises);
  let renameCall = 0;
  vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
    renameCall += 1;
    if (renameCall === 2) {
      throw new Error('simulated publish failure');
    }
    await rename(source, destination);
  });

  await expect(
    publishStagedPluginDirectory(stagedPluginDir, targetPluginDir, 'example-plugin'),
  ).rejects.toThrow('simulated publish failure');

  expect(renameCall).toBe(2);
  expect(fs.existsSync(targetPluginDir)).toBe(false);
});
