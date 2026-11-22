// IPC handlers for LobsterAI's primary DSH host status, plugin ecosystem
// management (`dsh plugin`), and on-demand embedded DSH Ecosystem Web View.

import { spawn } from 'child_process';
import { ipcMain, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

import {
  DEFAULT_DSH_PERMISSION_PRESET,
  DSH_PROFILE_NAME,
  DshHostIpc,
  DshPermissionPreset,
} from '../../../shared/dshEngine/hostConstants';
import type { DshHostManager } from '../../libs/dsh/dshHostManager';
import {
  buildIsolatedDshBaseEnv,
  type DshNodeToolchain,
  prepareDshLaunchEntry,
} from '../../libs/dsh/dshProfileManager';
import { DSH_NODE_EXEC_ARGV } from '../../libs/dshRuntime';

export interface DshHostIpcDeps {
  getHostManager: () => DshHostManager | null;
  getRuntimeDir: () => string;
  getExecutablePath: () => string;
  getNodeToolchain?: () => DshNodeToolchain | null;
  openEcosystemWindow?: (authenticatedUrl: string, routeHash?: string) => Promise<void> | void;
  closeEcosystemWindow?: () => void;
  getPermissionPreset?: (sessionId?: string) => {
    preset: DshPermissionPreset;
    defaultPreset: DshPermissionPreset;
  };
  setPermissionPreset?: (
    preset: DshPermissionPreset,
    sessionId?: string,
  ) => Promise<{ preset: DshPermissionPreset; defaultPreset: DshPermissionPreset }>;
}

export interface DshProfilePluginInfo {
  name: string;
  specifier: string;
  managed: boolean;
}

const MANAGED_BUNDLES = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@lobsterai/dsh-bundle',
  '@lobsterai/dsh-channels',
]);

export function readInstalledProfilePlugins(profileDir: string): DshProfilePluginInfo[] {
  const pkgPath = path.join(profileDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      dsh?: { profile?: { bundles?: string[] } };
    };
    const bundles = Array.isArray(parsed.dsh?.profile?.bundles) ? parsed.dsh.profile.bundles : [];
    const deps = parsed.dependencies ?? {};
    return bundles.map((name) => ({
      name,
      specifier: deps[name] ?? 'bundled',
      managed: MANAGED_BUNDLES.has(name),
    }));
  } catch {
    return [];
  }
}

export function runDshPluginCommand(options: {
  executablePath: string;
  runtimeDir: string;
  dshHomeDir: string;
  args: string[];
  toolchain?: DshNodeToolchain | null;
  baseEnv?: NodeJS.ProcessEnv;
  skipElectronRunAsNode?: boolean;
}): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    let env: NodeJS.ProcessEnv;
    let entryPath: string;
    try {
      fs.mkdirSync(options.dshHomeDir, { recursive: true, mode: 0o700 });
      env = buildIsolatedDshBaseEnv({
        baseEnv: options.baseEnv,
        dshHomeDir: options.dshHomeDir,
        skipElectronRunAsNode: options.skipElectronRunAsNode,
      });
      ({ entryPath } = prepareDshLaunchEntry({
        runtimeDir: options.runtimeDir,
        dshHomeDir: options.dshHomeDir,
        electronPath: options.executablePath,
        toolchain: options.toolchain,
        baseEnv: env,
      }));
    } catch (error) {
      resolve({
        ok: false,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: 1,
      });
      return;
    }

    const child = spawn(
      options.executablePath,
      [...DSH_NODE_EXEC_ARGV, entryPath, 'plugin', '--profile', DSH_PROFILE_NAME, ...options.args],
      {
        cwd: options.dshHomeDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      resolve({ ok: false, stdout, stderr: error.message, exitCode: 1 });
    });
    child.once('exit', (code) => {
      resolve({ ok: code === 0, stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

export function registerDshHostHandlers(deps: DshHostIpcDeps): void {
  ipcMain.handle(DshHostIpc.GetStatus, () => {
    const manager = deps.getHostManager();
    return manager ? manager.getStatus() : null;
  });

  ipcMain.handle(DshHostIpc.Restart, async () => {
    const manager = deps.getHostManager();
    if (!manager) return { ok: false, error: 'DSH host manager not initialized' };
    try {
      await manager.restart();
      return { ok: true, status: manager.getStatus() };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle(DshHostIpc.GetWebUrl, async () => {
    const manager = deps.getHostManager();
    if (!manager) return { ok: false, error: 'DSH host manager not initialized' };
    if (!manager.isReady()) {
      await manager.start();
    }
    return { ok: true, url: manager.getAuthenticatedWebUrl() };
  });

  ipcMain.handle(DshHostIpc.OpenEcosystemView, async (_event, routeHash?: string) => {
    const manager = deps.getHostManager();
    if (!manager) return { ok: false, error: 'DSH host manager not initialized' };
    if (!manager.isReady()) {
      await manager.start();
    }
    const url = manager.getAuthenticatedWebUrl();
    if (!url) return { ok: false, error: 'DSH web URL unavailable' };
    if (deps.openEcosystemWindow) {
      await deps.openEcosystemWindow(url, typeof routeHash === 'string' ? routeHash : undefined);
      return { ok: true, url };
    }
    await shell.openExternal(url);
    return { ok: true, url };
  });

  ipcMain.handle(DshHostIpc.CloseEcosystemView, () => {
    deps.closeEcosystemWindow?.();
    return { ok: true };
  });

  ipcMain.handle(DshHostIpc.ListPlugins, () => {
    const manager = deps.getHostManager();
    if (!manager) return { ok: false, plugins: [] };
    const status = manager.getStatus();
    return {
      ok: true,
      profileDir: status.profileDir,
      cliShimPath: status.cliShimPath,
      plugins: readInstalledProfilePlugins(status.profileDir),
    };
  });

  ipcMain.handle(DshHostIpc.InstallPlugin, async (_event, packageSpec: string) => {
    const manager = deps.getHostManager();
    if (!manager) return { ok: false, error: 'DSH host manager not initialized' };
    const spec = typeof packageSpec === 'string' ? packageSpec.trim() : '';
    if (!spec || /[\s;&|<>`$]/.test(spec)) {
      return { ok: false, error: 'Invalid package specifier' };
    }
    const status = manager.getStatus();
    const res = await runDshPluginCommand({
      executablePath: deps.getExecutablePath(),
      runtimeDir: deps.getRuntimeDir(),
      dshHomeDir: status.dshHomeDir,
      args: ['add', spec],
      toolchain: deps.getNodeToolchain?.() ?? null,
    });
    if (res.ok) {
      await manager.restart().catch((): void => undefined);
    }
    return {
      ...res,
      plugins: readInstalledProfilePlugins(status.profileDir),
    };
  });

  ipcMain.handle(DshHostIpc.RemovePlugin, async (_event, packageName: string) => {
    const manager = deps.getHostManager();
    if (!manager) return { ok: false, error: 'DSH host manager not initialized' };
    const name = typeof packageName === 'string' ? packageName.trim() : '';
    if (!name || MANAGED_BUNDLES.has(name) || /[\s;&|<>`$]/.test(name)) {
      return { ok: false, error: 'Cannot remove managed or invalid plugin package' };
    }
    const status = manager.getStatus();
    const res = await runDshPluginCommand({
      executablePath: deps.getExecutablePath(),
      runtimeDir: deps.getRuntimeDir(),
      dshHomeDir: status.dshHomeDir,
      args: ['remove', name],
      toolchain: deps.getNodeToolchain?.() ?? null,
    });
    if (res.ok) {
      await manager.restart().catch((): void => undefined);
    }
    return {
      ...res,
      plugins: readInstalledProfilePlugins(status.profileDir),
    };
  });

  ipcMain.handle(DshHostIpc.OpenProfileDir, async () => {
    const manager = deps.getHostManager();
    if (!manager) return { ok: false };
    const { profileDir } = manager.getStatus();
    if (fs.existsSync(profileDir)) {
      await shell.openPath(profileDir);
      return { ok: true, profileDir };
    }
    return { ok: false };
  });

  ipcMain.handle(DshHostIpc.GetPermissionPreset, (_event, sessionId?: string) => {
    const resolvedSessionId = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : undefined;
    if (deps.getPermissionPreset) {
      return { ok: true, ...deps.getPermissionPreset(resolvedSessionId) };
    }
    return {
      ok: true,
      preset: DEFAULT_DSH_PERMISSION_PRESET,
      defaultPreset: DEFAULT_DSH_PERMISSION_PRESET,
    };
  });

  ipcMain.handle(
    DshHostIpc.SetPermissionPreset,
    async (_event, payload: { preset?: string; sessionId?: string }) => {
      const rawPreset = typeof payload?.preset === 'string' ? payload.preset.trim() : '';
      const preset =
        rawPreset === DshPermissionPreset.ReadOnly
        || rawPreset === DshPermissionPreset.WorkspaceWrite
        || rawPreset === DshPermissionPreset.FullAccess
          ? rawPreset
          : null;
      if (!preset) {
        return { ok: false, error: `Unsupported permission preset: "${rawPreset}"` };
      }
      const sessionId = typeof payload?.sessionId === 'string' && payload.sessionId.trim()
        ? payload.sessionId.trim()
        : undefined;
      if (!deps.setPermissionPreset) {
        return { ok: false, error: 'Permission preset handler is not configured' };
      }
      try {
        const result = await deps.setPermissionPreset(preset, sessionId);
        return { ok: true, ...result };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );
}
