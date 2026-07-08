import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const {
  buildGitEnv,
  buildNpmPackEnv,
  copyDirRecursive,
  copyInstalledPluginToCache,
  findInstalledPluginDir,
  isGitSpec,
  isLocalPathSpec,
  parseGitSpec,
  resolveGitPackSpec,
  resolvePluginInstallSource,
} = require('../scripts/ensure-openclaw-plugins.cjs');

describe('ensure-openclaw-plugins', () => {
  test('detects local path specs', () => {
    expect(isLocalPathSpec('/tmp/openclaw-nim-channel')).toBe(true);
    expect(isLocalPathSpec('./plugins/openclaw-nim-channel')).toBe(true);
    expect(isLocalPathSpec('@scope/openclaw-plugin')).toBe(false);
  });

  test('detects git specs from GitHub', () => {
    expect(isGitSpec('git+https://github.com/netease-im/openclaw-nim-channel.git')).toBe(true);
    expect(isGitSpec('https://github.com/netease-im/openclaw-nim-channel.git')).toBe(true);
    expect(isGitSpec('github:netease-im/openclaw-nim-channel')).toBe(true);
    expect(isGitSpec('@scope/openclaw-plugin')).toBe(false);
  });

  test('appends version as git ref when the spec has no hash', () => {
    expect(resolveGitPackSpec(
      'git+https://github.com/netease-im/openclaw-nim-channel.git',
      '1.0.3',
    )).toBe('git+https://github.com/netease-im/openclaw-nim-channel.git#1.0.3');

    expect(resolveGitPackSpec(
      'git+https://github.com/netease-im/openclaw-nim-channel.git#main',
      '1.0.3',
    )).toBe('git+https://github.com/netease-im/openclaw-nim-channel.git#main');
  });

  test('resolves git sources to packed installs', () => {
    expect(resolvePluginInstallSource({
      id: 'openclaw-nim-channel',
      npm: 'git+https://github.com/netease-im/openclaw-nim-channel.git',
      version: '1.0.3',
    })).toEqual({
      kind: 'git',
      gitSpec: 'git+https://github.com/netease-im/openclaw-nim-channel.git#1.0.3',
      pinnedDisplaySpec: 'git+https://github.com/netease-im/openclaw-nim-channel.git#1.0.3',
    });
  });

  test('parses git specs into clone url and ref', () => {
    expect(parseGitSpec(
      'git+https://github.com/netease-im/openclaw-nim-channel.git',
      '1.1.0',
    )).toEqual({
      cloneUrl: 'https://github.com/netease-im/openclaw-nim-channel.git',
      ref: '1.1.0',
    });

    expect(parseGitSpec(
      'github:netease-im/openclaw-nim-channel#main',
      '1.1.0',
    )).toEqual({
      cloneUrl: 'https://github.com/netease-im/openclaw-nim-channel.git',
      ref: 'main',
    });
  });

  test('clears conflicting npm prefer env vars for git pack', () => {
    process.env.npm_config_prefer_offline = 'true';
    process.env.npm_config_prefer_online = 'true';
    process.env.NPM_CONFIG_PREFER_OFFLINE = 'true';
    process.env.NPM_CONFIG_PREFER_ONLINE = 'true';

    expect(buildNpmPackEnv()).toMatchObject({
      npm_config_prefer_offline: '',
      npm_config_prefer_online: '',
      NPM_CONFIG_PREFER_OFFLINE: '',
      NPM_CONFIG_PREFER_ONLINE: '',
    });

    delete process.env.npm_config_prefer_offline;
    delete process.env.npm_config_prefer_online;
    delete process.env.NPM_CONFIG_PREFER_OFFLINE;
    delete process.env.NPM_CONFIG_PREFER_ONLINE;
  });

  test('disables interactive git prompts for clone', () => {
    expect(buildGitEnv()).toMatchObject({
      GIT_TERMINAL_PROMPT: '0',
    });
  });

  test('preserves existing registry and local path behavior', () => {
    expect(resolvePluginInstallSource({
      id: 'moltbot-popo',
      npm: 'moltbot-popo',
      version: '2.0.7',
      registry: 'https://npm.nie.netease.com',
    })).toEqual({
      kind: 'packed',
      packSpec: 'moltbot-popo@2.0.7',
      pinnedDisplaySpec: 'moltbot-popo@2.0.7',
      registry: 'https://npm.nie.netease.com',
    });

    expect(resolvePluginInstallSource({
      id: 'local-plugin',
      npm: '/tmp/local-plugin',
      version: '1.0.0',
    })).toEqual({
      kind: 'direct',
      installSpec: '/tmp/local-plugin',
      pinnedDisplaySpec: '/tmp/local-plugin',
    });
  });

  test('finds plugins installed in the legacy extensions directory', () => {
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-plugin-layout-'));
    const pluginDir = path.join(stagingDir, 'extensions', 'actual-plugin-id');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'actual-plugin-id' }),
    );

    expect(
      findInstalledPluginDir(stagingDir, {
        id: 'actual-plugin-id',
        npm: '@example/plugin',
      }),
    ).toBe(pluginDir);

    fs.rmSync(stagingDir, { recursive: true, force: true });
  });

  test('finds npm plugins installed in isolated OpenClaw projects', () => {
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-plugin-layout-'));
    const pluginDir = path.join(
      stagingDir,
      'npm',
      'projects',
      'example-plugin-123',
      'node_modules',
      '@example',
      'plugin',
    );
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'manifest-id-differs' }),
    );
    fs.writeFileSync(
      path.join(pluginDir, 'package.json'),
      JSON.stringify({ name: '@example/plugin' }),
    );

    expect(
      findInstalledPluginDir(stagingDir, {
        id: 'configured-plugin-id',
        npm: '@example/plugin',
      }),
    ).toBe(pluginDir);

    fs.rmSync(stagingDir, { recursive: true, force: true });
  });

  test('does not copy the OpenClaw host peer link into plugin caches', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-plugin-copy-'));
    const sourceDir = path.join(tempDir, 'source');
    const targetDir = path.join(tempDir, 'target');
    const hostDir = path.join(tempDir, 'host-openclaw');
    fs.mkdirSync(path.join(sourceDir, 'node_modules'), { recursive: true });
    fs.mkdirSync(hostDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'index.js'), 'export {};\n');
    fs.writeFileSync(path.join(hostDir, 'host.js'), 'export {};\n');
    fs.symlinkSync(hostDir, path.join(sourceDir, 'node_modules', 'openclaw'), 'junction');

    copyDirRecursive(sourceDir, targetDir);

    expect(fs.existsSync(path.join(targetDir, 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'node_modules', 'openclaw'))).toBe(false);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('copies isolated npm project dependencies into plugin caches', () => {
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-plugin-project-'));
    const projectNodeModulesDir = path.join(stagingDir, 'npm', 'projects', 'example', 'node_modules');
    const pluginDir = path.join(projectNodeModulesDir, '@example', 'plugin');
    const dependencyDir = path.join(projectNodeModulesDir, 'image-size');
    const openclawPeerDir = path.join(stagingDir, 'host-openclaw');
    const cacheDir = path.join(stagingDir, 'cache');

    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(dependencyDir, { recursive: true });
    fs.mkdirSync(openclawPeerDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'index.js'), "require('image-size');\n");
    fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({ name: '@example/plugin' }));
    fs.writeFileSync(path.join(dependencyDir, 'index.js'), 'module.exports = {};\n');
    fs.symlinkSync(openclawPeerDir, path.join(projectNodeModulesDir, 'openclaw'), 'junction');

    copyInstalledPluginToCache(pluginDir, cacheDir);

    expect(fs.existsSync(path.join(cacheDir, 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, 'node_modules', 'image-size', 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, 'node_modules', '@example', 'plugin'))).toBe(false);
    expect(fs.existsSync(path.join(cacheDir, 'node_modules', 'openclaw'))).toBe(false);

    fs.rmSync(stagingDir, { recursive: true, force: true });
  });
});
