// IPC for the openclaw.user.json overrides card. Keeps the wiring out of
// main.ts except one register call.

import { ipcMain, shell } from 'electron';

import {
  type OpenClawUserConfigActionResult,
  OpenClawUserConfigIpc,
} from '../../../shared/openclawUserConfig/constants';
import type { OpenClawUserConfigOverlay } from '../../libs/openclawUserConfigOverlay';

export interface OpenClawUserConfigHandlerDeps {
  getOverlay: () => OpenClawUserConfigOverlay;
  syncOpenClawConfig: (options: { reason: string }) => Promise<{ success: boolean; error?: string }>;
  /** Starts the gateway again when a previous config stopped it. */
  restartGatewayIfStopped: (reason: string) => Promise<void>;
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function registerOpenClawUserConfigHandlers(deps: OpenClawUserConfigHandlerDeps): void {
  const applyOverrides = async (reason: string): Promise<OpenClawUserConfigActionResult> => {
    const sync = await deps.syncOpenClawConfig({ reason });
    await deps.restartGatewayIfStopped(reason);
    return {
      success: sync.success,
      status: deps.getOverlay().getStatus(),
      ...(sync.error ? { error: sync.error } : {}),
    };
  };

  ipcMain.handle(OpenClawUserConfigIpc.GetStatus, () => deps.getOverlay().getStatus());

  ipcMain.handle(OpenClawUserConfigIpc.SetEnabled, async (_event, enabled: unknown): Promise<OpenClawUserConfigActionResult> => {
    const overlay = deps.getOverlay();
    if (typeof enabled !== 'boolean') {
      return { success: false, status: overlay.getStatus(), error: 'enabled must be a boolean' };
    }
    try {
      overlay.setEnabled(enabled);
      return await applyOverrides('user-config-overlay-toggle');
    } catch (error) {
      console.error('[OpenClawUserOverlay] Failed to switch overrides:', error);
      return { success: false, status: overlay.getStatus(), error: errorMessage(error) };
    }
  });

  ipcMain.handle(OpenClawUserConfigIpc.OpenFile, async (): Promise<OpenClawUserConfigActionResult> => {
    const overlay = deps.getOverlay();
    try {
      const openError = await shell.openPath(overlay.ensureFile());
      return { success: !openError, status: overlay.getStatus(), ...(openError ? { error: openError } : {}) };
    } catch (error) {
      console.error('[OpenClawUserOverlay] Failed to open openclaw.user.json:', error);
      return { success: false, status: overlay.getStatus(), error: errorMessage(error) };
    }
  });

  ipcMain.handle(OpenClawUserConfigIpc.RevealFile, (): OpenClawUserConfigActionResult => {
    const overlay = deps.getOverlay();
    try {
      shell.showItemInFolder(overlay.ensureFile());
      return { success: true, status: overlay.getStatus() };
    } catch (error) {
      console.error('[OpenClawUserOverlay] Failed to reveal openclaw.user.json:', error);
      return { success: false, status: overlay.getStatus(), error: errorMessage(error) };
    }
  });

  ipcMain.handle(OpenClawUserConfigIpc.Apply, async (): Promise<OpenClawUserConfigActionResult> => {
    const overlay = deps.getOverlay();
    try {
      // Applying is an explicit retry, so a suspension is lifted first.
      overlay.resume();
      return await applyOverrides('user-config-overlay-apply');
    } catch (error) {
      console.error('[OpenClawUserOverlay] Failed to apply overrides:', error);
      return { success: false, status: overlay.getStatus(), error: errorMessage(error) };
    }
  });
}
