import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  DshHostPhase,
  DshOpsAction,
  DshPermissionPreset,
  DshSearchPolicy,
} from '../../../shared/dshEngine/hostConstants';
import { isDshWebCommand } from '../dshOrphanReaper';
import {
  buildIsolatedDshChildEnv,
  DshHostManager,
  resolveBundledDshPaths,
} from './dshHostManager';
import type { DshTypertClient } from './dshTypertClient';

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
    const execute = (toolName: unknown, extra: Record<string, unknown> = {}) => fetch(
      `${manager['bridgeUrl']}/dsh-bridge/tool-execute`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${manager['bridgeSecret']}` },
        body: JSON.stringify({ toolName, ...extra }),
      },
    );
    try {
      expect(await (await execute('sample')).json()).toEqual({ via: 'registered' });
      expect((await execute(123)).status).toBe(400);
      expect((await execute('   ')).status).toBe(400);
      expect(fallback).not.toHaveBeenCalled();
      expect(await (await execute('provider_tool', { workspaceDir: '/tmp/proj-alpha' })).json()).toEqual({
        via: 'provider',
      });
      expect(fallback).toHaveBeenCalledWith(expect.objectContaining({
        toolName: 'provider_tool',
        workspaceDir: '/tmp/proj-alpha',
        signal: expect.any(AbortSignal),
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
    const memoryRes = await manager.syncMemoryPolicy({ enabled: false });
    const toolsRes = await manager.syncHostTools([]);
    const agentsRes = await manager.syncAgents([]);
    const bindingsRes = await manager.syncSubagentBindings([], { replace: true });

    expect(provRes).toEqual({ deferred: true });
    expect(mcpRes).toEqual({ deferred: true });
    expect(skillRes).toEqual({ deferred: true });
    expect(memoryRes).toEqual({ deferred: true });
    expect(toolsRes).toEqual({ deferred: true });
    expect(agentsRes).toEqual({ deferred: true });
    expect(bindingsRes).toEqual({ deferred: true });
  });

  test('buildIsolatedDshChildEnv strips official DSH, DeepSeek, and global pnpm/npm config env vars without mutating PATH', () => {
    const temp = createTempDir();
    const dshHomeDir = path.join(temp, 'userData', 'dsh-profile');
    const runtimeDir = path.join(temp, 'runtime');
    fs.mkdirSync(path.join(runtimeDir, 'package-manager'), { recursive: true });

    const env = buildIsolatedDshChildEnv({
      baseEnv: {
        PATH: '/usr/bin',
        DSH_HOME: '/Users/alice/.dsh',
        DSH_AGENTS_HOME: '/Users/alice/.agents',
        DSH_BUNDLED_SKILL_DIR: '/opt/native-dsh/skills',
        DSH_PROFILE: 'desktop',
        DEEPSEEK_API_KEY: 'sk-official-secret',
        DEEPSEEK_BASE_URL: 'https://official.example',
        DEEPSEEK_SEARCH_BASE_URL: 'https://search.example',
        PNPM_HOME: '/Users/alice/.local/share/pnpm',
        npm_config_store_dir: '/Users/alice/.local/share/pnpm/store',
        npm_config_cache: '/Users/alice/.npm',
        npm_config_userconfig: '/Users/alice/.npmrc',
        npm_config_globalconfig: '/etc/npmrc',
        NPM_CONFIG_USERCONFIG: '/Users/alice/.npmrc-upper',
        HOME: '/Users/alice',
      },
      dshHomeDir,
      bridgeUrl: 'http://127.0.0.1:41234',
      bridgeSecret: 'secret',
      workspacesDir: path.join(temp, 'userData', 'workspaces'),
      skillsDir: path.join(temp, 'userData', 'SKILLs'),
      searchPolicy: DshSearchPolicy.DeepSeekNativeOnly,
      runtimeDir,
    });

    expect(env.DSH_HOME).toBe(dshHomeDir);
    expect(env.DSH_AGENTS_HOME).toBe(path.join(dshHomeDir, 'agents-home'));
    expect(env.DSH_TELEMETRY_DISABLED).toBe('1');
    expect(env.DSH_BUNDLED_SKILL_DIR).toBeUndefined();
    expect(env.DSH_PROFILE).toBeUndefined();
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.DEEPSEEK_BASE_URL).toBeUndefined();
    expect(env.DEEPSEEK_SEARCH_BASE_URL).toBeUndefined();
    expect(env.PNPM_HOME).toBeUndefined();
    expect(env.npm_config_userconfig).toBeUndefined();
    expect(env.npm_config_globalconfig).toBeUndefined();
    expect(env.NPM_CONFIG_USERCONFIG).toBeUndefined();
    expect(env.npm_config_store_dir).toBe(path.join(dshHomeDir, 'cache', 'pnpm-store'));
    expect(env.npm_config_cache).toBe(path.join(dshHomeDir, 'cache', 'npm-cache'));
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/Users/alice');
  });

  test('caches per-session permission presets independently from default and replays both on restart', async () => {
    const temp = createTempDir();
    const manager = new DshHostManager({
      userDataDir: temp,
      runtimeDir: path.join(temp, 'runtime'),
      hostBundleDir: path.join(temp, 'host-bundle'),
      skillsDir: path.join(temp, 'skills'),
      executablePath: process.execPath,
      skipElectronRunAsNode: true,
    });

    await manager.setPermissionPreset(DshPermissionPreset.WorkspaceWrite);
    await manager.setPermissionPreset(DshPermissionPreset.FullAccess, 'dsh-sess-a');
    await manager.setPermissionPreset(DshPermissionPreset.ReadOnly, 'dsh-sess-b');

    const callOps = vi.fn(async () => ({ ok: true }));
    manager['phase'] = DshHostPhase.Ready;
    manager['client'] = {
      isConnected: () => true,
      callOps,
    } as never;

    await manager['replayCachedSyncs']();
    expect(callOps).toHaveBeenCalledWith(DshOpsAction.SetPermissionPreset, {
      preset: DshPermissionPreset.WorkspaceWrite,
    });
    expect(callOps).toHaveBeenCalledWith(DshOpsAction.SetPermissionPreset, {
      preset: DshPermissionPreset.FullAccess,
      sessionId: 'dsh-sess-a',
    });
    expect(callOps).toHaveBeenCalledWith(DshOpsAction.SetPermissionPreset, {
      preset: DshPermissionPreset.ReadOnly,
      sessionId: 'dsh-sess-b',
    });

    // Deleting a session evicts its cached per-session preset so it is not replayed.
    callOps.mockClear();
    await manager.deleteSessionFiles('dsh-sess-a');
    await manager['replayCachedSyncs']();
    expect(callOps).not.toHaveBeenCalledWith(DshOpsAction.SetPermissionPreset, {
      preset: DshPermissionPreset.FullAccess,
      sessionId: 'dsh-sess-a',
    });
    expect(callOps).toHaveBeenCalledWith(DshOpsAction.SetPermissionPreset, {
      preset: DshPermissionPreset.ReadOnly,
      sessionId: 'dsh-sess-b',
    });
  });

  test('replays cached sync payloads before transitioning phase to Ready', async () => {
    const temp = createTempDir();
    const runtimeDir = path.join(temp, 'runtime');
    const hostBundleDir = path.join(temp, 'host-bundle');
    fs.mkdirSync(path.join(runtimeDir, 'lib'), { recursive: true });
    fs.mkdirSync(hostBundleDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, 'lib', 'bin.js'), '// stub\n');
    fs.writeFileSync(path.join(runtimeDir, 'package.json'), '{"version":"0.2.2-rc.5"}');

    const order: string[] = [];
    const fakeClient = {
      connect: vi.fn(async () => ({ origin: 'http://127.0.0.1:41234', hostHome: temp })),
      isConnected: vi.fn(() => true),
      callOps: vi.fn(async (action: string) => {
        order.push(`ops:${action}`);
        return { ok: true };
      }),
      close: vi.fn(async () => undefined),
    };

    const manager = new DshHostManager({
      userDataDir: path.join(temp, 'userData'),
      runtimeDir,
      hostBundleDir,
      skillsDir: path.join(temp, 'skills'),
      executablePath: process.execPath,
      skipElectronRunAsNode: true,
      clientFactory: () => fakeClient as unknown as ReturnType<DshHostManager['getClient']>,
    });

    vi.spyOn(manager as unknown as { spawnAndWaitForLaunchUrl: () => Promise<string> }, 'spawnAndWaitForLaunchUrl')
      .mockResolvedValue('http://127.0.0.1:41234/?token=test');

    manager.on('phaseChange', (phase: DshHostPhase) => {
      order.push(`phase:${phase}`);
    });

    // Pre-cache a providers payload before start.
    await manager.syncProviders({
      providers: [
        {
          id: 'p1',
          api: 'openai-completions',
          baseURL: 'http://127.0.0.1:9999/v1',
          models: [{ id: 'm1' }],
        },
      ],
    });

    try {
      await manager.start();
      const syncIdx = order.indexOf('ops:syncProviders');
      const readyIdx = order.indexOf('phase:ready');
      expect(syncIdx).toBeGreaterThan(-1);
      expect(readyIdx).toBeGreaterThan(-1);
      expect(syncIdx).toBeLessThan(readyIdx);
    } finally {
      await manager.stop();
    }
  });

  test('spawns via bundled-pnpm launcher with cwd pinned to dshHomeDir, scrubbed env, and reaper-compatible argv', async () => {
    const temp = createTempDir();
    const userDataDir = path.join(temp, 'userData');
    const runtimeDir = path.join(temp, 'mock-runtime');
    const hostBundleDir = path.join(temp, 'host-bundle');
    const skillsDir = path.join(temp, 'skills');
    const probePath = path.join(temp, 'spawn-probe.json');

    fs.mkdirSync(path.join(runtimeDir, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(runtimeDir, 'package-manager', 'pnpm', 'bin'), { recursive: true });
    fs.mkdirSync(hostBundleDir, { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });

    fs.writeFileSync(path.join(runtimeDir, 'package.json'), JSON.stringify({ version: '0.2.2-rc.5', type: 'module' }));
    fs.writeFileSync(
      path.join(runtimeDir, 'package-manager', 'pnpm', 'package.json'),
      JSON.stringify({ name: 'pnpm', version: '11.28.5', bin: { pnpm: 'bin/pnpm.mjs' } }),
    );
    const pnpmEntry = path.join(runtimeDir, 'package-manager', 'pnpm', 'bin', 'pnpm.mjs');
    fs.writeFileSync(pnpmEntry, 'console.log("11.28.5");\n');
    fs.writeFileSync(
      path.join(runtimeDir, 'lib', 'bin.js'),
      [
        'import * as fs from "node:fs";',
        `const probePath = ${JSON.stringify(probePath)};`,
        'export async function runCli(options = {}) {',
        '  fs.writeFileSync(probePath, JSON.stringify({',
        '    cwd: process.cwd(),',
        '    execArgv: process.execArgv,',
        '    argv: process.argv,',
        '    packageManager: options.packageManager ?? null,',
        '    env: {',
        '      DSH_HOME: process.env.DSH_HOME ?? null,',
        '      DSH_AGENTS_HOME: process.env.DSH_AGENTS_HOME ?? null,',
        '      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? null,',
        '      PNPM_HOME: process.env.PNPM_HOME ?? null,',
        '      npm_config_userconfig: process.env.npm_config_userconfig ?? null,',
        '      npm_config_globalconfig: process.env.npm_config_globalconfig ?? null,',
        '      PATH: process.env.PATH ?? null,',
        '    },',
        '  }));',
        '  console.log("dsh web: http://127.0.0.1:43210/?token=test-token");',
        '  setInterval(() => {}, 1000);',
        '}',
        '',
      ].join('\n'),
    );

    const fakeClient = {
      connect: vi.fn(async () => undefined),
      callOps: vi.fn(async () => ({ ok: true })),
      isConnected: vi.fn(() => true),
      close: vi.fn(async () => undefined),
    } as unknown as DshTypertClient;

    const manager = new DshHostManager({
      userDataDir,
      runtimeDir,
      hostBundleDir,
      skillsDir,
      executablePath: process.execPath,
      skipElectronRunAsNode: true,
      clientFactory: () => fakeClient,
      baseEnv: {
        PATH: '',
        DSH_HOME: '/fake/official/.dsh',
        DEEPSEEK_API_KEY: 'sk-official-leak-test',
        PNPM_HOME: '/fake/global/pnpm',
        npm_config_userconfig: '/fake/global/.npmrc',
        npm_config_globalconfig: '/fake/global/npmrc',
      },
    });

    try {
      await manager.start();
      const status = manager.getStatus();
      const launcherPath = path.join(status.dshHomeDir, 'dsh-launcher', 'launch.mjs');
      expect(fs.existsSync(launcherPath)).toBe(true);
      expect(status.cliShimPath && fs.readFileSync(status.cliShimPath, 'utf8')).toContain(launcherPath);

      const probe = JSON.parse(fs.readFileSync(probePath, 'utf8')) as {
        cwd: string;
        execArgv: string[];
        argv: string[];
        packageManager: { command: string; args: string[]; env: Record<string, string> } | null;
        env: Record<string, string | null>;
      };

      expect(fs.realpathSync(probe.cwd)).toBe(fs.realpathSync(status.dshHomeDir));
      expect(probe.execArgv).toContain('--expose-internals');
      expect(fs.realpathSync(probe.argv[1])).toBe(fs.realpathSync(launcherPath));
      expect(probe.packageManager?.command).toBe(process.execPath);
      expect(probe.packageManager?.args.map((p) => fs.realpathSync(p))).toEqual([fs.realpathSync(pnpmEntry)]);
      expect(probe.packageManager?.env.ELECTRON_RUN_AS_NODE).toBe('1');
      expect(probe.env).toEqual({
        DSH_HOME: status.dshHomeDir,
        DSH_AGENTS_HOME: path.join(status.dshHomeDir, 'agents-home'),
        DEEPSEEK_API_KEY: null,
        PNPM_HOME: null,
        npm_config_userconfig: null,
        npm_config_globalconfig: null,
        PATH: '',
      });

      const reconstructedCommand = [process.execPath, ...probe.execArgv, ...probe.argv.slice(1)].join(' ');
      expect(isDshWebCommand(reconstructedCommand, process.execPath)).toBe(true);
    } finally {
      await manager.stop();
    }
  });
});
