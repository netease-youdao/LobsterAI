// IPC handlers for LobsterAI's primary DSH host status, plugin ecosystem
// management (`dsh plugin`), and on-demand embedded DSH Ecosystem Web View.

import { ipcMain, shell } from 'electron';
import * as fs from 'fs';

import {
  DEFAULT_DSH_PERMISSION_PRESET,
  DshHostIpc,
  DshPermissionPreset,
} from '../../../shared/dshEngine/hostConstants';
import type { DshHostManager } from '../../libs/dsh/dshHostManager';
import type { DshNodeToolchain } from '../../libs/dsh/dshProfileManager';
import {
  readInstalledProfilePlugins,
  runDshPluginCommand,
  setProfilePluginEnabled,
  validatePluginInstallSpecifier,
  validatePluginPackageName,
} from './pluginOperations';

export {
  type DshProfilePluginInfo,
  isManagedDshBundle,
  readInstalledProfilePlugins,
  runDshPluginCommand,
  type RunDshPluginCommandOptions,
  type RunDshPluginCommandResult,
  setProfilePluginEnabled,
  type SetProfilePluginEnabledResult,
  validatePluginInstallSpecifier,
  validatePluginPackageName,
} from './pluginOperations';

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
    const spec = validatePluginInstallSpecifier(packageSpec);
    if (!spec) {
      return { ok: false, error: 'Invalid package specifier' };
    }
    const status = manager.getStatus();
    const toolchain = deps.getNodeToolchain?.() ?? manager.getNodeToolchain?.() ?? null;
    const res = await runDshPluginCommand({
      executablePath: deps.getExecutablePath(),
      runtimeDir: deps.getRuntimeDir(),
      dshHomeDir: status.dshHomeDir,
      nodeToolchain: toolchain,
      toolchain,
      args: ['add', spec],
    });
    // Always restore LobsterAI managed bundles & symlinks before restarting DSH host.
    try {
      manager.ensureProfileIntegrity?.();
    } catch (error) {
      console.warn('[DSH Host] Failed to re-ensure profile integrity after plugin install:', error);
    }
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
    const name = validatePluginPackageName(packageName);
    if (!name) {
      return { ok: false, error: 'Cannot remove managed or invalid plugin package' };
    }
    const status = manager.getStatus();
    const toolchain = deps.getNodeToolchain?.() ?? manager.getNodeToolchain?.() ?? null;
    const res = await runDshPluginCommand({
      executablePath: deps.getExecutablePath(),
      runtimeDir: deps.getRuntimeDir(),
      dshHomeDir: status.dshHomeDir,
      nodeToolchain: toolchain,
      toolchain,
      args: ['remove', name],
    });
    // Always restore LobsterAI managed bundles & symlinks before restarting DSH host.
    try {
      manager.ensureProfileIntegrity?.();
    } catch (error) {
      console.warn('[DSH Host] Failed to re-ensure profile integrity after plugin remove:', error);
    }
    if (res.ok) {
      await manager.restart().catch((): void => undefined);
    }
    return {
      ...res,
      plugins: readInstalledProfilePlugins(status.profileDir),
    };
  });

  ipcMain.handle(
    DshHostIpc.SetPluginEnabled,
    async (_event, packageName: string, enabled: boolean) => {
      const manager = deps.getHostManager();
      if (!manager) return { ok: false, error: 'DSH host manager not initialized' };
      if (typeof enabled !== 'boolean') {
        return { ok: false, error: 'Invalid plugin enabled state' };
      }
      const status = manager.getStatus();
      const res = setProfilePluginEnabled(status.profileDir, packageName, enabled);
      if (!res.ok) {
        return res;
      }
      if (res.changed) {
        try {
          manager.ensureProfileIntegrity?.();
        } catch (error) {
          console.warn('[DSH Host] Failed to re-ensure profile integrity after plugin toggle:', error);
        }
        try {
          await manager.restart();
        } catch (error) {
          return {
            ok: false,
            changed: res.changed,
            enabled: res.enabled,
            error: error instanceof Error ? error.message : String(error),
            plugins: readInstalledProfilePlugins(status.profileDir),
          };
        }
      }
      return {
        ...res,
        plugins: readInstalledProfilePlugins(status.profileDir),
      };
    },
  );

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
