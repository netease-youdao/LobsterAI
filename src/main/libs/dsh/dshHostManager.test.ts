import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { DshHostPhase, DshSearchPolicy } from '../../../shared/dshEngine/hostConstants';
import {
  buildIsolatedDshChildEnv,
  DshHostManager,
  resolveBundledDshPaths,
} from './dshHostManager';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-dsh-host-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveBundledDshPaths', () => {
  test('resolves dev layout under vendor/dsh-runtime/current and dsh-bundles/', () => {
    const root = createTempDir();
    const res = resolveBundledDshPaths({ isPackaged: false, appRootDir: root });
    expect(res.runtimeDir).toBe(path.join(root, 'vendor', 'dsh-runtime', 'current'));
    expect(res.hostBundleDir).toBe(path.join(root, 'dsh-bundles', 'lobsterai-host'));
    expect(res.channelsBundleDir).toBeNull();
  });

  test('resolves packaged layout under resourcesPath and detects channels bundle when present', () => {
    const resources = createTempDir();
    const channelsDir = path.join(resources, 'dsh-bundles', 'lobsterai-channels');
    fs.mkdirSync(channelsDir, { recursive: true });
    fs.writeFileSync(path.join(channelsDir, 'package.json'), '{"name":"@lobsterai/dsh-channels"}');

    const res = resolveBundledDshPaths({
      isPackaged: true,
      appRootDir: '/ignored',
      resourcesDir: resources,
    });
    expect(res.runtimeDir).toBe(path.join(resources, 'dsh-runtime'));
    expect(res.hostBundleDir).toBe(path.join(resources, 'dsh-bundles', 'lobsterai-host'));
    expect(res.channelsBundleDir).toBe(channelsDir);
  });
});

describe('DshHostManager', () => {
  test('dispatches named tools and delegates provider tools only for valid names', async () => {
    const temp = createTempDir();
    const manager = new DshHostManager({
      userDataDir: temp,
      runtimeDir: path.join(temp, 'runtime'),
      hostBundleDir: path.join(temp, 'bundle'),
      skillsDir: path.join(temp, 'skills'),
      executablePath: process.execPath,
    });
    const fallback = vi.fn(() => ({ via: 'provider' }));
    const unregisterOld = manager.registerBridgeToolHandler('sample', () => ({ via: 'old' }));
    const unregister = manager.registerBridgeToolHandler('sample', () => ({ via: 'registered' }));
    unregisterOld();
    manager.setFallbackBridgeToolHandler(fallback);
    await manager['ensureBridgeServer']();
    const execute = (toolName: unknown) => fetch(`${manager['bridgeUrl']}/dsh-bridge/tool-execute`, {
      method: 'POST',
      headers: { authorization: `Bearer ${manager['bridgeSecret']}` },
      body: JSON.stringify({ toolName }),
    });
    try {
      expect(await (await execute('sample')).json()).toEqual({ via: 'registered' });
      expect((await execute(123)).status).toBe(400);
      expect((await execute('   ')).status).toBe(400);
      expect(fallback).not.toHaveBeenCalled();
      expect(await (await execute('provider_tool')).json()).toEqual({ via: 'provider' });
      expect(fallback).toHaveBeenCalledWith(expect.objectContaining({
        toolName: 'provider_tool', signal: expect.any(AbortSignal),
      }));
      unregister();
      manager.setFallbackBridgeToolHandler(null);
      expect((await execute('sample')).status).toBe(404);
    } finally {
      await manager.stop();
    }
  });

  test('reports initial stopped status and fails clearly when runtime binary is missing', async () => {
    const temp = createTempDir();
    const manager = new DshHostManager({
      userDataDir: path.join(temp, 'userData'),
      runtimeDir: path.join(temp, 'missing-runtime'),
      hostBundleDir: path.join(temp, 'host-bundle'),
      skillsDir: path.join(temp, 'skills'),
      executablePath: process.execPath,
      skipElectronRunAsNode: true,
    });

    expect(manager.getStatus().phase).toBe(DshHostPhase.Stopped);
    expect(manager.isReady()).toBe(false);

    // Attach error listener so EventEmitter does not throw unhandled error.
    const errors: Error[] = [];
    manager.on('error', (err: Error) => errors.push(err));

    await expect(manager.start()).rejects.toThrow(/DSH runtime binary not found/);
    expect(manager.getStatus().phase).toBe(DshHostPhase.Failed);
    expect(errors.length).toBe(1);

    await manager.stop();
    expect(manager.getStatus().phase).toBe(DshHostPhase.Stopped);
  });

  test('caches sync payloads safely while stopped before host is ready', async () => {
    const temp = createTempDir();
    const manager = new DshHostManager({
      userDataDir: path.join(temp, 'userData'),
      runtimeDir: path.join(temp, 'runtime'),
      hostBundleDir: path.join(temp, 'host-bundle'),
      skillsDir: path.join(temp, 'skills'),
      executablePath: process.execPath,
      skipElectronRunAsNode: true,
    });

    const provRes = await manager.syncProviders({ providers: [] });
    const mcpRes = await manager.syncMcpServers([]);
    const skillRes = await manager.syncSkillsPolicy({ disabledIds: ['foo'] });
    const toolsRes = await manager.syncHostTools([]);
    const agentsRes = await manager.syncAgents([]);
    const bindingsRes = await manager.syncSubagentBindings([], { replace: true });

    expect(provRes).toEqual({ deferred: true });
    expect(mcpRes).toEqual({ deferred: true });
    expect(skillRes).toEqual({ deferred: true });
    expect(toolsRes).toEqual({ deferred: true });
    expect(agentsRes).toEqual({ deferred: true });
    expect(bindingsRes).toEqual({ deferred: true });
  });

  test('buildIsolatedDshChildEnv strips inherited native DSH_* vars and isolates home, agents-home, and pnpm store', () => {
    const temp = createTempDir();
    const dshHomeDir = path.join(temp, 'userData', 'dsh-profile');
    const env = buildIsolatedDshChildEnv({
      baseEnv: {
        PATH: '/usr/bin',
        DSH_HOME: '/Users/alice/.dsh',
        DSH_AGENTS_HOME: '/Users/alice/.agents',
        DSH_BUNDLED_SKILL_DIR: '/opt/native-dsh/skills',
        DSH_PROFILE: 'desktop',
        npm_config_store_dir: '/Users/alice/.local/share/pnpm/store',
        npm_config_cache: '/Users/alice/.npm',
        HOME: '/Users/alice',
      },
      dshHomeDir,
      bridgeUrl: 'http://127.0.0.1:41234',
      bridgeSecret: 'secret',
      workspacesDir: path.join(temp, 'userData', 'workspaces'),
      skillsDir: path.join(temp, 'userData', 'SKILLs'),
      searchPolicy: DshSearchPolicy.DeepSeekNativeOnly,
      runtimeDir: path.join(temp, 'runtime'),
    });

    expect(env.DSH_HOME).toBe(dshHomeDir);
    expect(env.DSH_AGENTS_HOME).toBe(path.join(dshHomeDir, 'agents-home'));
    expect(env.DSH_TELEMETRY_DISABLED).toBe('1');
    expect(env.DSH_BUNDLED_SKILL_DIR).toBeUndefined();
    expect(env.DSH_PROFILE).toBeUndefined();
    expect(env.npm_config_store_dir).toBe(path.join(dshHomeDir, 'cache', 'pnpm-store'));
    expect(env.npm_config_cache).toBe(path.join(dshHomeDir, 'cache', 'npm-cache'));
    expect(env.HOME).toBe('/Users/alice');
    expect(env.SKILLS_ROOT).toBe(path.join(temp, 'userData', 'SKILLs'));
    expect(env.LOBSTERAI_SKILLS_ROOT).toBe(path.join(temp, 'userData', 'SKILLs'));
  });

  test('buildIsolatedDshChildEnv injects skill runtime vars, preserves TZ, and merges runtime PATH dirs without leaking DSH_*', () => {
    const temp = createTempDir();
    const dshHomeDir = path.join(temp, 'userData', 'dsh-profile');
    const runtimeDir = path.join(temp, 'runtime');
    const pmDir = path.join(runtimeDir, 'package-manager');
    fs.mkdirSync(pmDir, { recursive: true });
    const skillsDir = path.join(temp, 'userData', 'SKILLs');
    const bridgeFile = path.join(temp, 'userData', 'web-search-bridge.json');
    const nodeShimDir = path.join(temp, 'userData', 'cowork', 'bin');
    const pythonDir = path.join(temp, 'userData', 'runtimes', 'python-win');

    const withInheritedTz = buildIsolatedDshChildEnv({
      baseEnv: {
        PATH: `/usr/bin${path.delimiter}/bin`,
        TZ: 'America/Los_Angeles',
      },
      dshHomeDir,
      bridgeUrl: 'http://127.0.0.1:41234',
      bridgeSecret: 'secret',
      workspacesDir: path.join(temp, 'userData', 'workspaces'),
      skillsDir,
      searchPolicy: DshSearchPolicy.DeepSeekNativeOnly,
      runtimeDir,
      executablePath: '/Apps/LobsterAI Helper',
      webSearchBridgeFile: bridgeFile,
      timeZone: 'Asia/Shanghai',
      nodeShimDir,
      npmBinDir: '/Apps/resources/npm/bin',
      prependPathDirs: [pythonDir],
      appendPathDirs: ['/opt/homebrew/bin', '/usr/bin'],
      extraEnv: {
        LOBSTERAI_PYTHON_ROOT: pythonDir,
        PYTHONUTF8: '1',
        DSH_HOME: '/should/be/ignored',
        npm_config_cache: '/should/be/ignored',
      },
    });

    expect(withInheritedTz.SKILLS_ROOT).toBe(skillsDir);
    expect(withInheritedTz.LOBSTERAI_SKILLS_ROOT).toBe(skillsDir);
    expect(withInheritedTz.LOBSTERAI_ELECTRON_PATH).toBe('/Apps/LobsterAI Helper');
    expect(withInheritedTz.LOBSTERAI_WEB_SEARCH_BRIDGE_FILE).toBe(bridgeFile);
    expect(withInheritedTz.LOBSTERAI_NPM_BIN_DIR).toBe('/Apps/resources/npm/bin');
    expect(withInheritedTz.LOBSTERAI_PYTHON_ROOT).toBe(pythonDir);
    expect(withInheritedTz.PYTHONUTF8).toBe('1');
    expect(withInheritedTz.DSH_HOME).toBe(dshHomeDir);
    expect(withInheritedTz.npm_config_cache).toBe(path.join(dshHomeDir, 'cache', 'npm-cache'));
    expect(withInheritedTz.TZ).toBe('America/Los_Angeles');

    const pathParts = (withInheritedTz.PATH ?? '').split(path.delimiter);
    expect(pathParts).toEqual([pmDir, pythonDir, '/usr/bin', '/bin', nodeShimDir, '/opt/homebrew/bin']);

    const withoutInheritedTz = buildIsolatedDshChildEnv({
      baseEnv: { PATH: '/usr/bin' },
      dshHomeDir,
      bridgeUrl: 'http://127.0.0.1:41234',
      bridgeSecret: 'secret',
      workspacesDir: path.join(temp, 'userData', 'workspaces'),
      skillsDir,
      searchPolicy: DshSearchPolicy.DeepSeekNativeOnly,
      runtimeDir,
      timeZone: 'Asia/Shanghai',
    });
    expect(withoutInheritedTz.TZ).toBe('Asia/Shanghai');
  });
});
