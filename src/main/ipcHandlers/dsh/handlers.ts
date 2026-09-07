// IPC + lifecycle wiring for the experimental DeepSeek Harness feature:
// enable/disable flag, engine state queries, and the workbench window. dsh
// stays independent from the main agent: it is never registered as an MCP
// server and no task is forwarded to it through LobsterAI. Keeps all dsh
// wiring out of main.ts except one register call.

import { BrowserWindow, ipcMain } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  DSH_CONFIG_STORE_KEY,
  DshFeatureConfig,
  DshIpcChannel,
} from '../../../shared/dshEngine/constants';
import type { ProviderConfig } from '../../../shared/providers/types';
import { DshManagedSettings, DshPlanProviderInput, renderDshManagedSettings } from '../../libs/dshConfigSync';
import { getDshEngineManager } from '../../libs/dshEngineManager';
import {
  clearWriterLock,
  DshSharedHomeDecision,
  resolveSharedDataHome,
  writeWriterLock,
} from '../../libs/dshSharedHome';

export interface DshStoreLike {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
}

export interface DshHandlerDeps {
  getStore: () => DshStoreLike;
  getProviders: () => Record<string, ProviderConfig>;
  /** The billed plan routed through the token proxy; null when unavailable. */
  getPlanProvider: () => DshPlanProviderInput | null;
  getDefaultCwd: () => string;
  getWorkbenchTitle: () => string;
}

let moduleDeps: DshHandlerDeps | null = null;
let workbenchWindow: BrowserWindow | null = null;

// The canonical dsh home. Using it directly — rather than a private copy —
// is what makes installed plugins, credentials, agent presets, settings, and
// history identical to a standalone `npx @deepseek-ai/dsh`.
function standaloneDshHome(): string {
  return path.join(os.homedir(), '.dsh');
}

// Earlier builds wrote a composition patch that switched shipped rows off.
// That home is exclusively ours, so any patch file left there is a leftover
// from that version and would keep disabling capabilities on the fallback
// path. The machine's own ~/.dsh patch layer is the user's and never touched.
function removeLegacyPrivatePatchLayer(privateHome: string): void {
  const legacyPatch = path.join(privateHome, 'cordis.patch.yml');
  try {
    if (fs.existsSync(legacyPatch)) {
      fs.rmSync(legacyPatch);
      console.log('[DSH] Removed a legacy composition patch from the private home');
    }
  } catch (error) {
    console.warn('[DSH] Could not remove the legacy private patch layer', error);
  }
}

function readDshFeatureConfig(store: DshStoreLike): DshFeatureConfig {
  return { enabled: store.get<DshFeatureConfig>(DSH_CONFIG_STORE_KEY)?.enabled === true };
}

export function isDshFeatureEnabled(store: DshStoreLike): boolean {
  return readDshFeatureConfig(store).enabled;
}

function computeManagedSettings(): DshManagedSettings | null {
  if (!moduleDeps) return null;
  const providers = moduleDeps.getProviders();
  const firstUsable = Object.entries(providers).find(
    ([, config]) => config?.enabled !== false && !!config?.apiKey && (config?.models?.length ?? 0) > 0
  );
  const planProvider = moduleDeps.getPlanProvider();
  // Only prefer a user provider as the default when there is no plan; the plan
  // needs no key of the user's own, so it is the safer out-of-the-box default.
  const preferredDefault =
    !planProvider && firstUsable && firstUsable[1].models?.[0]?.id
      ? { providerId: firstUsable[0], modelId: firstUsable[1].models[0].id }
      : undefined;
  return renderDshManagedSettings(providers, { preferredDefault, planProvider });
}

// Starts the engine on demand (settings sync included) and resolves the web
// URL for the workbench window.
export async function ensureDshEngineReady(): Promise<string> {
  const manager = getDshEngineManager();

  // The workbench runs against the machine's dsh home so plugins, credentials,
  // settings, and history are the same ones a standalone dsh uses. dsh allows
  // one live writer per session, so a conflicting writer downgrades this run to
  // a private home instead of risking a corrupt log.
  const sharedHome = standaloneDshHome();
  const resolution = await resolveSharedDataHome(sharedHome);
  if (resolution.decision !== DshSharedHomeDecision.Shared) {
    console.warn(`[DSH] Another dsh is using ${sharedHome} (${resolution.decision}); falling back to a private home.`);
  }

  removeLegacyPrivatePatchLayer(manager.getPrivateDshHomeDir());

  // Packaged builds carry no runtime; it is fetched on first use from the URL
  // recorded for this platform in package.json `dsh.runtimes`. That first fetch
  // is a ~40s one-off, so the manager publishes its progress on the engine
  // state and the settings card renders it.
  await manager.ensureRuntimeInstalled();
  manager.setHomeDirectorySource(() => resolution.dataHome);
  manager.setManagedSettingsSource(computeManagedSettings);
  manager.setWorkingDirectorySource(() => moduleDeps?.getDefaultCwd() ?? '');
  manager.setSharedHomeLock(
    resolution.dataHome
      ? { claim: (port) => writeWriterLock(sharedHome, port), release: () => clearWriterLock(sharedHome) }
      : null
  );
  const state = await manager.start();
  const url = manager.getWebUrl();
  if (!url) {
    throw new Error(`DeepSeek Harness engine failed to start (phase=${state.phase}, error=${state.errorCode ?? 'none'})`);
  }
  return url;
}

function closeWorkbenchWindow(): void {
  if (workbenchWindow && !workbenchWindow.isDestroyed()) {
    workbenchWindow.close();
  }
  workbenchWindow = null;
}

function openOrFocusWorkbench(url: string, title: string): void {
  if (workbenchWindow && !workbenchWindow.isDestroyed()) {
    if (workbenchWindow.webContents.getURL() !== url) {
      void workbenchWindow.loadURL(url);
    }
    if (workbenchWindow.isMinimized()) workbenchWindow.restore();
    workbenchWindow.focus();
    return;
  }
  workbenchWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    title,
    autoHideMenuBar: true,
    webPreferences: {
      // The dsh web UI is a plain same-origin page: no preload, no Node, and a
      // dedicated persistent partition so its storage stays out of the app's.
      partition: 'persist:dsh',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  workbenchWindow.on('closed', () => {
    workbenchWindow = null;
  });
  void workbenchWindow.loadURL(url);
}

export async function stopDshFeatureRuntimes(): Promise<void> {
  closeWorkbenchWindow();
  await getDshEngineManager().stop();
}

export function registerDshHandlers(deps: DshHandlerDeps): void {
  moduleDeps = deps;

  ipcMain.handle(DshIpcChannel.GetState, () => getDshEngineManager().getState());

  ipcMain.handle(DshIpcChannel.GetConfig, () => readDshFeatureConfig(deps.getStore()));

  ipcMain.handle(DshIpcChannel.SetEnabled, async (_event, enabled: unknown) => {
    const store = deps.getStore();
    const next = enabled === true;
    store.set(DSH_CONFIG_STORE_KEY, { enabled: next } satisfies DshFeatureConfig);
    if (!next) {
      await stopDshFeatureRuntimes();
    }
    // Nothing in OpenClaw's config depends on this flag, so the toggle never
    // touches openclaw.json and never restarts the gateway.
    return { enabled: next };
  });

  ipcMain.handle(DshIpcChannel.Stop, async () => {
    await stopDshFeatureRuntimes();
    return getDshEngineManager().getState();
  });

  ipcMain.handle(DshIpcChannel.OpenWorkbench, async () => {
    if (!isDshFeatureEnabled(deps.getStore())) {
      throw new Error('DeepSeek Harness is not enabled');
    }
    const url = await ensureDshEngineReady();
    openOrFocusWorkbench(url, deps.getWorkbenchTitle());
    return { url };
  });
}
