// IPC handlers for LobsterAI's primary DSH host status, plugin ecosystem
// management (`dsh plugin`), and on-demand embedded DSH Ecosystem Web View.

import { spawn } from 'child_process';
import { ipcMain, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

import {
  DSH_PROFILE_NAME,
  DshHostIpc,
} from '../../../shared/dshEngine/hostConstants';
import type { DshHostManager } from '../../libs/dsh/dshHostManager';
import { DSH_NODE_EXEC_ARGV } from '../../libs/dshRuntime';

export interface DshHostIpcDeps {
  getHostManager: () => DshHostManager | null;
  getRuntimeDir: () => string;
  getExecutablePath: () => string;
  openEcosystemWindow?: (authenticatedUrl: string, routeHash?: string) => Promise<void> | void;
  closeEcosystemWindow?: () => void;
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

function runDshPluginCommand(options: {
  executablePath: string;
  runtimeDir: string;
  dshHomeDir: string;
  args: string[];
}): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const binPath = path.join(options.runtimeDir, 'lib', 'bin.js');
    const pmDir = path.join(options.runtimeDir, 'package-manager');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DSH_HOME: options.dshHomeDir,
      DSH_TELEMETRY_DISABLED: '1',
    };
    if (fs.existsSync(pmDir)) {
      const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
      env[pathKey] = env[pathKey] ? `${pmDir}${path.delimiter}${env[pathKey]}` : pmDir;
    }

    const child = spawn(
      options.executablePath,
      [...DSH_NODE_EXEC_ARGV, binPath, 'plugin', '--profile', DSH_PROFILE_NAME, ...options.args],
      { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
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
}
