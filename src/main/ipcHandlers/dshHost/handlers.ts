// IPC handlers for LobsterAI's primary DSH host status, HMR-backed plugin
// management (`pluginManager/*` Typert RPC with CLI fallback), and on-demand
// DSH Web View.

import { clipboard, dialog, ipcMain, shell } from 'electron';
import * as fs from 'fs';

import {
  DEFAULT_DSH_AGENT_PRESET_ID,
  DEFAULT_DSH_PERMISSION_PRESET,
  DSH_BUILTIN_DEVELOPER_AGENT_PRESET_IDS,
  DshHostIpc,
  DshPermissionPreset,
  DshPluginApplicationStatus,
  DshPluginUpdateOutcomeKind,
  type DshSessionRecovery,
} from '../../../shared/dshEngine/hostConstants';
import type { DshHostManager } from '../../libs/dsh/dshHostManager';
import type { DshNodeToolchain } from '../../libs/dsh/dshProfileManager';
import type {
  DshPluginBundleInfo,
  DshPluginInstallBundleOptions,
  DshPluginUpdateBundleOptions,
  DshPluginVersionList,
  DshTypertClient,
} from '../../libs/dsh/dshTypertClient';
import {
  buildEnrichedPluginEntries,
  classifyBundleSurface,
  type DshEnrichedPluginEntry,
  type DshPluginInspectResult,
  type DshPluginUpdateOutcome,
  normalizePluginChangeOutcome,
  normalizePluginUpdateOutcome,
  resolveLocalPathIfExists,
  validateOptionalRegistryUrl,
} from './pluginClassification';
import {
  readInstalledProfilePlugins,
  runDshPluginCommand,
  setProfilePluginEnabled,
  validatePluginInstallSpecifier,
  validatePluginPackageName,
} from './pluginOperations';

export {
  buildEnrichedPluginEntries,
  classifyBundleSurface,
  type DshEnrichedPluginEntry,
  type DshPluginInspectResult,
  type DshPluginMutationOutcome,
  type DshPluginPanelMetadata,
  type DshPluginSurfaceClassification,
  type DshPluginUpdateOutcome,
  extractPanelMetadataFromClientSource,
  isAllowedDshEmbedWebviewUrl,
  normalizePluginChangeOutcome,
  normalizePluginUpdateOutcome,
  validateOptionalRegistryUrl,
} from './pluginClassification';
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

export interface InstallPluginPayload {
  spec: string;
  registry?: string | null;
  approvedBuilds?: string[];
  enabled?: boolean;
  requestId?: string;
}

export interface InspectPluginPayload {
  spec: string;
  registry?: string | null;
}

export interface CheckPluginVersionsPayload {
  name: string;
  registry?: string | null;
}

export interface UpdatePluginPayload {
  name: string;
  version: string;
  registry?: string | null;
  spec?: string;
  requestId?: string;
}

export interface CheckPluginVersionsResponse {
  ok: boolean;
  checkedAt?: number;
  list?: DshPluginVersionList;
  error?: string;
}

export interface DshHostIpcDeps {
  getHostManager: () => DshHostManager | null;
  getRecoveryTask?: (sessionId: string) => DshSessionRecovery | null;
  getRuntimeDir: () => string;
  getExecutablePath: () => string;
  getNodeToolchain?: () => DshNodeToolchain | null;
  isAuthGateBlocked?: () => boolean;
  openEcosystemWindow?: (authenticatedUrl: string, routeHash?: string) => Promise<void> | void;
  closeEcosystemWindow?: () => void;
  syncAgentWorkspaces?: () => Promise<unknown> | void;
  getPermissionPreset?: (sessionId?: string) => {
    preset: DshPermissionPreset;
    defaultPreset: DshPermissionPreset;
  };
  setPermissionPreset?: (
    preset: DshPermissionPreset,
    sessionId?: string,
  ) => Promise<{ preset: DshPermissionPreset; defaultPreset: DshPermissionPreset }>;
}

function getLivePluginClient(manager: DshHostManager): DshTypertClient | null {
  if (typeof manager.isReady !== 'function' || !manager.isReady()) return null;
  if (typeof manager.getClient !== 'function') return null;
  try {
    const client = manager.getClient();
    if (client && typeof client.listPluginBundles === 'function') {
      return client;
    }
  } catch {
    return null;
  }
  return null;
}

async function listEnrichedPlugins(
  manager: DshHostManager,
  profileDir: string,
  runtimeDir: string,
): Promise<{ plugins: DshEnrichedPluginEntry[]; hmrAvailable: boolean }> {
  const fallbackPlugins = readInstalledProfilePlugins(profileDir);
  const client = getLivePluginClient(manager);
  if (!client) {
    return {
      plugins: buildEnrichedPluginEntries({
        fallbackPlugins,
        profileDir,
        runtimeDir,
      }),
      hmrAvailable: false,
    };
  }

  let liveBundles: DshPluginBundleInfo[] | null = null;
  try {
    liveBundles = await client.listPluginBundles();
  } catch (error) {
    console.warn('[DSH Host] pluginManager/listBundles failed; falling back to profile manifest:', error);
  }

  return {
    plugins: buildEnrichedPluginEntries({
      liveBundles,
      fallbackPlugins,
      profileDir,
      runtimeDir,
    }),
    hmrAvailable: liveBundles !== null,
  };
}

function parseInstallRequest(raw: unknown): InstallPluginPayload | null {
  if (typeof raw === 'string') {
    return { spec: raw };
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    if (typeof record.spec !== 'string') return null;
    const approvedBuilds = Array.isArray(record.approvedBuilds)
      ? record.approvedBuilds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : undefined;
    return {
      spec: record.spec,
      ...(record.registry !== undefined ? { registry: record.registry as string | null } : {}),
      ...(approvedBuilds && approvedBuilds.length > 0 ? { approvedBuilds } : {}),
      ...(typeof record.enabled === 'boolean' ? { enabled: record.enabled } : {}),
      ...(typeof record.requestId === 'string' && record.requestId.trim()
        ? { requestId: record.requestId.trim() }
        : {}),
    };
  }
  return null;
}

function parseInspectRequest(raw: unknown): InspectPluginPayload | null {
  if (typeof raw === 'string') {
    return { spec: raw };
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    if (typeof record.spec !== 'string') return null;
    return {
      spec: record.spec,
      ...(record.registry !== undefined ? { registry: record.registry as string | null } : {}),
    };
  }
  return null;
}

const VALID_TARGET_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/;

function validatePluginTargetVersion(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || !VALID_TARGET_VERSION_PATTERN.test(trimmed)) return null;
  return trimmed;
}

function parseCheckVersionsRequest(raw: unknown): CheckPluginVersionsPayload | null {
  if (typeof raw === 'string') {
    return { name: raw };
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    if (typeof record.name !== 'string') return null;
    return {
      name: record.name,
      ...(record.registry !== undefined ? { registry: record.registry as string | null } : {}),
    };
  }
  return null;
}

function parseUpdatePluginRequest(raw: unknown): UpdatePluginPayload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.name !== 'string' || typeof record.version !== 'string') return null;
  return {
    name: record.name,
    version: record.version,
    ...(record.registry !== undefined ? { registry: record.registry as string | null } : {}),
    ...(typeof record.spec === 'string' && record.spec.trim() ? { spec: record.spec.trim() } : {}),
    ...(typeof record.requestId === 'string' && record.requestId.trim()
      ? { requestId: record.requestId.trim() }
      : {}),
  };
}

export function registerDshHostHandlers(deps: DshHostIpcDeps): void {
  ipcMain.handle(DshHostIpc.GetStatus, () => {
    const manager = deps.getHostManager();
    return manager ? manager.getStatus() : null;
  });

  ipcMain.handle(DshHostIpc.GetSessionRecovery, (_event, sessionId: string): DshSessionRecovery | null => {
    const since = deps.getHostManager()?.getDisconnectedAt();
    if (since == null) return null;
    const task = deps.getRecoveryTask?.(sessionId);
    return task ? { ...task, since: Math.max(since, task.since) } : null;
  });


  ipcMain.handle(DshHostIpc.Restart, async () => {
    if (deps.isAuthGateBlocked?.()) return { ok: false, error: 'Authentication is required.' };
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
    if (deps.isAuthGateBlocked?.()) return { ok: false, error: 'Authentication is required.' };
    const manager = deps.getHostManager();
    if (!manager) return { ok: false, error: 'DSH host manager not initialized' };
    if (!manager.isReady()) {
      await manager.start();
    }
    return { ok: true, url: manager.getAuthenticatedWebUrl() };
  });

  ipcMain.handle(DshHostIpc.OpenEcosystemView, async (_event, routeHash?: string) => {
    if (deps.isAuthGateBlocked?.()) return { ok: false, error: 'Authentication is required.' };
    const manager = deps.getHostManager();
    if (!manager) return { ok: false, error: 'DSH host manager not initialized' };
    if (!manager.isReady()) {
      await manager.start();
    }
    const url = manager.getAuthenticatedWebUrl();
    if (!url) return { ok: false, error: 'DSH web URL unavailable' };
    if (deps.syncAgentWorkspaces) {
      try {
        await deps.syncAgentWorkspaces();
      } catch (error) {
        console.warn('[DSH Host] Failed to refresh agent workspaces before opening ecosystem view:', error);
      }
    }
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

  ipcMain.handle(DshHostIpc.ListPlugins, async () => {
    const manager = deps.getHostManager();
    if (!manager) return { ok: false, plugins: [], hmrAvailable: false };
    const status = manager.getStatus();
    const { plugins, hmrAvailable } = await listEnrichedPlugins(
      manager,
      status.profileDir,
      deps.getRuntimeDir(),
    );
    return {
      ok: true,
      profileDir: status.profileDir,
      cliShimPath: status.cliShimPath,
      hmrAvailable,
      plugins,
    };
  });

  ipcMain.handle(
    DshHostIpc.ListPluginModels,
    async (_event, options?: { forceRefresh?: boolean }) => {
      const manager = deps.getHostManager();
      if (!manager || !manager.isReady() || typeof manager.listPluginModels !== 'function') {
        return { ok: false, groups: [], models: [], failures: [], fetchedAt: Date.now() };
      }
      try {
        const snapshot = await manager.listPluginModels({
          forceRefresh: options?.forceRefresh === true,
        });
        return { ok: true, ...snapshot };
      } catch (error) {
        console.warn('[DSH Host] Failed to fetch DSH plugin model catalog:', error);
        return {
          ok: false,
          groups: [],
          models: [],
          failures: [],
          fetchedAt: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle(DshHostIpc.ListAgentPresets, async () => {
    const manager = deps.getHostManager();
    if (!manager || !manager.isReady() || typeof manager.listAgentPresets !== 'function') {
      return {
        ok: false,
        presets: [],
        usablePresets: [],
        hasThirdPartyPresets: false,
        defaultPresetId: DEFAULT_DSH_AGENT_PRESET_ID,
      };
    }
    try {
      const rawPresets = await manager.listAgentPresets();
      const sorted = [...rawPresets].sort((a, b) => {
        const orderA = typeof a.order === 'number' ? a.order : Number.MAX_SAFE_INTEGER;
        const orderB = typeof b.order === 'number' ? b.order : Number.MAX_SAFE_INTEGER;
        if (orderA !== orderB) return orderA - orderB;
        return a.id.localeCompare(b.id);
      });
      const usablePresets = sorted.filter((preset) => !preset.broken);
      const defaultPresetId =
        usablePresets.find((preset) => preset.isDefault)?.id ?? DEFAULT_DSH_AGENT_PRESET_ID;
      const builtinDeveloperIds = new Set<string>(DSH_BUILTIN_DEVELOPER_AGENT_PRESET_IDS);
      const hasThirdPartyPresets = usablePresets.some((preset) => {
        const id = preset.id.trim().toLowerCase();
        return id !== DEFAULT_DSH_AGENT_PRESET_ID && !builtinDeveloperIds.has(id);
      });
      return {
        ok: true,
        presets: sorted,
        usablePresets,
        hasThirdPartyPresets,
        defaultPresetId,
      };
    } catch (error) {
      console.warn('[DSH Host] Failed to list DSH agent presets:', error);
      return {
        ok: false,
        presets: [],
        usablePresets: [],
        hasThirdPartyPresets: false,
        defaultPresetId: DEFAULT_DSH_AGENT_PRESET_ID,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle(
    DshHostIpc.ListPluginSkills,
    async (_event, options?: { cwd?: string }) => {
      const manager = deps.getHostManager();
      if (!manager || !manager.isReady() || typeof manager.listPluginSkills !== 'function') {
        return { ok: false, skills: [] };
      }
      try {
        const cwd = typeof options?.cwd === 'string' && options.cwd.trim() ? options.cwd.trim() : undefined;
        const skills = await manager.listPluginSkills(cwd);
        return { ok: true, skills };
      } catch (error) {
        console.warn('[DSH Host] Failed to list DSH plugin skills:', error);
        return {
          ok: false,
          skills: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle(DshHostIpc.GetPluginRegistries, async () => {
    const manager = deps.getHostManager();
    if (!manager) return { ok: false, error: 'DSH host manager not initialized' };
    const client = getLivePluginClient(manager);
    if (!client) {
      return {
        ok: true,
        registry: null,
        fallbackRegistries: ['https://registry.npmmirror.com/'],
        resolved: null,
        fastest: null,
      };
    }
    const [registriesOutcome, fastestOutcome] = await Promise.allSettled([
      client.getPluginRegistries(),
      typeof client.probeFastestPluginRegistry === 'function'
        ? client.probeFastestPluginRegistry()
        : Promise.resolve(null),
    ]);
    const registries = registriesOutcome.status === 'fulfilled'
      ? registriesOutcome.value
      : {
          registry: null,
          fallbackRegistries: ['https://registry.npmmirror.com/'],
          resolved: null,
        };
    const fastest = fastestOutcome.status === 'fulfilled' ? fastestOutcome.value : null;
    return {
      ok: true,
      registry: registries.registry,
      fallbackRegistries: [...registries.fallbackRegistries],
      resolved: registries.resolved,
      fastest,
    };
  });

  ipcMain.handle(
    DshHostIpc.InspectPlugin,
    async (_event, rawRequest: unknown): Promise<DshPluginInspectResult> => {
      const manager = deps.getHostManager();
      if (!manager) return { ok: false, error: 'DSH host manager not initialized' };
      const parsed = parseInspectRequest(rawRequest);
      if (!parsed) return { ok: false, error: 'Invalid inspect request' };
      const spec = validatePluginInstallSpecifier(parsed.spec);
      if (!spec) return { ok: false, error: 'Invalid package specifier' };

      const registry = validateOptionalRegistryUrl(parsed.registry);
      if (registry === false) {
        return { ok: false, error: 'Invalid registry URL' };
      }

      const status = manager.getStatus();
      const localDir = resolveLocalPathIfExists(spec);
      const client = getLivePluginClient(manager);
      if (!client || typeof client.inspectPluginSpec !== 'function') {
        const surfaceInfo = classifyBundleSurface({
          name: localDir ? undefined : spec,
          profileDir: status.profileDir,
          runtimeDir: deps.getRuntimeDir(),
          localDir: localDir ?? undefined,
        });
        return {
          ok: true,
          status: 'accepted',
          kind: localDir ? 'path' : 'registry',
          name: localDir ? undefined : spec,
          bundle: null,
          registry,
          surface: surfaceInfo.surface,
          isThemePlugin: surfaceInfo.isThemePlugin,
          heuristicOnly: surfaceInfo.heuristicOnly,
        };
      }

      try {
        const inspectOptions = parsed.registry !== undefined ? { registry } : undefined;
        const inspection = await client.inspectPluginSpec(spec, inspectOptions);
        if (inspection.status === 'refused') {
          return {
            ok: true,
            status: 'refused',
            problem: inspection.problem,
            reason: inspection.reason,
            registries: inspection.registries,
          };
        }
        const surfaceInfo = classifyBundleSurface({
          name: inspection.name,
          description: inspection.description,
          profileDir: status.profileDir,
          runtimeDir: deps.getRuntimeDir(),
          localDir: inspection.kind === 'path' ? (localDir ?? undefined) : undefined,
        });
        return {
          ok: true,
          status: 'accepted',
          kind: inspection.kind,
          name: inspection.name,
          version: inspection.version,
          description: inspection.description,
          bundle: inspection.bundle,
          registry: inspection.registry,
          host: inspection.host,
          surface: surfaceInfo.surface,
          isThemePlugin: surfaceInfo.isThemePlugin,
          heuristicOnly: surfaceInfo.heuristicOnly,
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle(DshHostIpc.InstallPlugin, async (_event, rawRequest: unknown) => {
    if (deps.isAuthGateBlocked?.()) return { ok: false, error: 'Authentication is required.' };
    const manager = deps.getHostManager();
    if (!manager) return { ok: false, error: 'DSH host manager not initialized' };
    const parsed = parseInstallRequest(rawRequest);
    const spec = parsed ? validatePluginInstallSpecifier(parsed.spec) : null;
    if (!parsed || !spec) {
      return { ok: false, error: 'Invalid package specifier' };
    }
    const registry = validateOptionalRegistryUrl(parsed.registry);
    if (registry === false) {
      return { ok: false, error: 'Invalid registry URL' };
    }

    const status = manager.getStatus();
    const client = getLivePluginClient(manager);

    // Primary path: live DSH pluginManager RPC with HMR hot-apply (no forced restart).
    if (client && typeof client.installPluginBundle === 'function') {
      try {
        const installOptions: DshPluginInstallBundleOptions = {
          enabled: parsed.enabled ?? true,
          ...(parsed.registry !== undefined ? { registry } : {}),
          ...(parsed.approvedBuilds ? { approvedBuilds: parsed.approvedBuilds } : {}),
          ...(parsed.requestId ? { requestId: parsed.requestId } : {}),
        };
        const change = await client.installPluginBundle(spec, installOptions);
        try {
          manager.ensureProfileIntegrity?.();
        } catch (error) {
          console.warn('[DSH Host] Failed to re-ensure profile integrity after live plugin install:', error);
        }
        const { plugins } = await listEnrichedPlugins(
          manager,
          status.profileDir,
          deps.getRuntimeDir(),
        );
        return normalizePluginChangeOutcome(change, plugins);
      } catch (error) {
        const { plugins } = await listEnrichedPlugins(
          manager,
          status.profileDir,
          deps.getRuntimeDir(),
        );
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          plugins,
        };
      }
    }

    // Fallback path when DSH host is offline: run bundled CLI and restart host.
    const toolchain = deps.getNodeToolchain?.() ?? manager.getNodeToolchain?.() ?? null;
    const res = await runDshPluginCommand({
      executablePath: deps.getExecutablePath(),
      runtimeDir: deps.getRuntimeDir(),
      dshHomeDir: status.dshHomeDir,
      nodeToolchain: toolchain,
      toolchain,
      args: ['add', spec],
    });
    try {
      manager.ensureProfileIntegrity?.();
    } catch (error) {
      console.warn('[DSH Host] Failed to re-ensure profile integrity after plugin install:', error);
    }
    if (res.ok) {
      await manager.restart().catch((): void => undefined);
    }
    const { plugins } = await listEnrichedPlugins(
      manager,
      status.profileDir,
      deps.getRuntimeDir(),
    );
    return {
      ...res,
      application: res.ok ? DshPluginApplicationStatus.Applied : DshPluginApplicationStatus.Failed,
      restartRequired: false,
      plugins,
    };
  });

  ipcMain.handle(DshHostIpc.CancelPluginInstall, async (_event, requestId: string) => {
    const manager = deps.getHostManager();
    if (!manager) return { ok: false, error: 'DSH host manager not initialized' };
    const trimmed = typeof requestId === 'string' ? requestId.trim() : '';
    if (!trimmed) return { ok: false, error: 'Invalid requestId' };
    const client = getLivePluginClient(manager);
    if (!client || typeof client.cancelPluginInstall !== 'function') {
      return { ok: false, status: 'not-running' };
    }
    try {
      const res = await client.cancelPluginInstall(trimmed);
      return { ok: true, status: res.status };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle(DshHostIpc.RemovePlugin, async (_event, packageName: string) => {
    if (deps.isAuthGateBlocked?.()) return { ok: false, error: 'Authentication is required.' };
    const manager = deps.getHostManager();
    if (!manager) return { ok: false, error: 'DSH host manager not initialized' };
    const name = validatePluginPackageName(packageName);
    if (!name) {
      return { ok: false, error: 'Cannot remove managed or invalid plugin package' };
    }
    const status = manager.getStatus();
    const client = getLivePluginClient(manager);

    // Primary path: live DSH pluginManager RPC with HMR hot-unload (no forced restart).
    if (client && typeof client.removePluginBundle === 'function') {
      try {
        const change = await client.removePluginBundle(name);
        try {
          manager.ensureProfileIntegrity?.();
        } catch (error) {
          console.warn('[DSH Host] Failed to re-ensure profile integrity after live plugin remove:', error);
        }
        const { plugins } = await listEnrichedPlugins(
          manager,
          status.profileDir,
          deps.getRuntimeDir(),
        );
        return normalizePluginChangeOutcome(change, plugins);
      } catch (error) {
        const { plugins } = await listEnrichedPlugins(
          manager,
          status.profileDir,
          deps.getRuntimeDir(),
        );
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          plugins,
        };
      }
    }

    // Fallback path when DSH host is offline.
    const toolchain = deps.getNodeToolchain?.() ?? manager.getNodeToolchain?.() ?? null;
    const res = await runDshPluginCommand({
      executablePath: deps.getExecutablePath(),
      runtimeDir: deps.getRuntimeDir(),
      dshHomeDir: status.dshHomeDir,
      nodeToolchain: toolchain,
      toolchain,
      args: ['remove', name],
    });
    try {
      manager.ensureProfileIntegrity?.();
    } catch (error) {
      console.warn('[DSH Host] Failed to re-ensure profile integrity after plugin remove:', error);
    }
    if (res.ok) {
      await manager.restart().catch((): void => undefined);
    }
    const { plugins } = await listEnrichedPlugins(
      manager,
      status.profileDir,
      deps.getRuntimeDir(),
    );
    return {
      ...res,
      application: res.ok ? DshPluginApplicationStatus.Applied : DshPluginApplicationStatus.Failed,
      restartRequired: false,
      plugins,
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
      const name = validatePluginPackageName(packageName);
      if (!name) {
        const status = manager.getStatus();
        const { plugins } = await listEnrichedPlugins(
          manager,
          status.profileDir,
          deps.getRuntimeDir(),
        );
        return {
          ok: false,
          error: 'Cannot toggle managed or invalid plugin package',
          plugins,
        };
      }

      const status = manager.getStatus();
      const client = getLivePluginClient(manager);

      // Primary path: live DSH pluginManager RPC with HMR hot-toggle (no forced restart).
      if (client && typeof client.setPluginBundleEnabled === 'function') {
        try {
          const change = await client.setPluginBundleEnabled(name, enabled);
          try {
            manager.ensureProfileIntegrity?.();
          } catch (error) {
            console.warn('[DSH Host] Failed to re-ensure profile integrity after live plugin toggle:', error);
          }
          const { plugins } = await listEnrichedPlugins(
            manager,
            status.profileDir,
            deps.getRuntimeDir(),
          );
          return normalizePluginChangeOutcome(change, plugins);
        } catch (error) {
          const { plugins } = await listEnrichedPlugins(
            manager,
            status.profileDir,
            deps.getRuntimeDir(),
          );
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            plugins,
          };
        }
      }

      // Fallback path when DSH host is offline.
      const res = setProfilePluginEnabled(status.profileDir, name, enabled);
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
        application: DshPluginApplicationStatus.Applied,
        restartRequired: false,
        plugins: buildEnrichedPluginEntries({
          fallbackPlugins: res.plugins,
          profileDir: status.profileDir,
          runtimeDir: deps.getRuntimeDir(),
        }),
      };
    },
  );

  ipcMain.handle(
    DshHostIpc.CheckPluginVersions,
    async (_event, rawRequest: unknown): Promise<CheckPluginVersionsResponse> => {
      const manager = deps.getHostManager();
      if (!manager) return { ok: false, error: 'DSH host manager not initialized' };
      const parsed = parseCheckVersionsRequest(rawRequest);
      const name = parsed ? validatePluginPackageName(parsed.name) : null;
      if (!parsed || !name) {
        return { ok: false, error: 'Cannot check versions for managed or invalid plugin package' };
      }
      const registry = validateOptionalRegistryUrl(parsed.registry);
      if (registry === false) {
        return { ok: false, error: 'Invalid registry URL' };
      }
      const client = getLivePluginClient(manager);
      if (!client || typeof client.listPluginVersions !== 'function') {
        return { ok: false, error: 'DSH host is not ready' };
      }
      try {
        const listOptions = parsed.registry !== undefined ? { registry } : undefined;
        const list = await client.listPluginVersions(name, listOptions);
        return {
          ok: true,
          checkedAt: Date.now(),
          list,
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle(
    DshHostIpc.UpdatePlugin,
    async (_event, rawRequest: unknown): Promise<DshPluginUpdateOutcome> => {
      const manager = deps.getHostManager();
      if (!manager) {
        return {
          ok: false,
          outcome: DshPluginUpdateOutcomeKind.TransportLost,
          from: '',
          to: '',
          error: 'DSH host manager not initialized',
          plugins: [],
        };
      }
      const status = manager.getStatus();
      const parsed = parseUpdatePluginRequest(rawRequest);
      const name = parsed ? validatePluginPackageName(parsed.name) : null;
      const version = parsed ? validatePluginTargetVersion(parsed.version) : null;
      if (!parsed || !name || !version) {
        const { plugins } = await listEnrichedPlugins(
          manager,
          status.profileDir,
          deps.getRuntimeDir(),
        );
        return {
          ok: false,
          outcome: DshPluginUpdateOutcomeKind.CheckRefused,
          from: '',
          to: version ?? '',
          errorCode: 'invalid-spec',
          error: 'Cannot update managed or invalid plugin package',
          plugins,
        };
      }
      const registry = validateOptionalRegistryUrl(parsed.registry);
      if (registry === false) {
        const { plugins } = await listEnrichedPlugins(
          manager,
          status.profileDir,
          deps.getRuntimeDir(),
        );
        return {
          ok: false,
          outcome: DshPluginUpdateOutcomeKind.CheckRefused,
          from: '',
          to: version,
          errorCode: 'invalid-spec',
          error: 'Invalid registry URL',
          plugins,
        };
      }
      const validatedSpec =
        parsed.spec !== undefined ? validatePluginInstallSpecifier(parsed.spec) : undefined;
      if (parsed.spec !== undefined && !validatedSpec) {
        const { plugins } = await listEnrichedPlugins(
          manager,
          status.profileDir,
          deps.getRuntimeDir(),
        );
        return {
          ok: false,
          outcome: DshPluginUpdateOutcomeKind.CheckRefused,
          from: '',
          to: version,
          errorCode: 'invalid-spec',
          error: 'Invalid update package specifier',
          plugins,
        };
      }

      const client = getLivePluginClient(manager);
      if (!client || typeof client.updatePluginBundle !== 'function') {
        const { plugins } = await listEnrichedPlugins(
          manager,
          status.profileDir,
          deps.getRuntimeDir(),
        );
        return {
          ok: false,
          outcome: DshPluginUpdateOutcomeKind.TransportLost,
          from: '',
          to: version,
          error: 'DSH host is not ready',
          plugins,
        };
      }

      try {
        const updateOptions: DshPluginUpdateBundleOptions = {
          ...(parsed.registry !== undefined ? { registry } : {}),
          ...(validatedSpec ? { spec: validatedSpec } : {}),
          ...(parsed.requestId ? { requestId: parsed.requestId } : {}),
        };
        const rawOutcome = await client.updatePluginBundle(name, version, updateOptions);
        try {
          manager.ensureProfileIntegrity?.();
        } catch (error) {
          console.warn('[DSH Host] Failed to re-ensure profile integrity after live plugin update:', error);
        }
        const { plugins } = await listEnrichedPlugins(
          manager,
          status.profileDir,
          deps.getRuntimeDir(),
        );
        return normalizePluginUpdateOutcome(rawOutcome, plugins);
      } catch (error) {
        try {
          manager.ensureProfileIntegrity?.();
        } catch (integrityError) {
          console.warn(
            '[DSH Host] Failed to re-ensure profile integrity after failed plugin update:',
            integrityError,
          );
        }
        const { plugins } = await listEnrichedPlugins(
          manager,
          status.profileDir,
          deps.getRuntimeDir(),
        );
        return {
          ok: false,
          outcome: DshPluginUpdateOutcomeKind.TransportLost,
          from: '',
          to: version,
          error: error instanceof Error ? error.message : String(error),
          plugins,
        };
      }
    },
  );

  ipcMain.handle(DshHostIpc.PickLocalPluginDir, async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory'],
    });
    if (res.canceled || res.filePaths.length === 0) {
      return { ok: true, canceled: true, path: null };
    }
    return { ok: true, canceled: false, path: res.filePaths[0] };
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

  ipcMain.handle(DshHostIpc.CopyCliShimCommand, () => {
    const manager = deps.getHostManager();
    if (!manager) return { ok: false, error: 'DSH host manager not initialized' };
    const { cliShimPath } = manager.getStatus();
    if (!cliShimPath) return { ok: false, error: 'CLI path unavailable' };
    clipboard.writeText(cliShimPath);
    return { ok: true, cliShimPath };
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
