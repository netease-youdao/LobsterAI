import { BrowserWindow, ipcMain, protocol } from 'electron';

import {
  SkinIpc,
  SkinProtocol,
  SkinRecordStatus,
} from '../../shared/skin/constants';
import type {
  SkinApplyResponse,
  SkinBindThemeResponse,
  SkinDeactivateResponse,
  SkinDeleteResponse,
  SkinGetActiveResponse,
  SkinListResponse,
} from '../../shared/skin/types';
import { presentSkin } from './skinPresentation';
import { createSkinProtocolHandler } from './skinProtocol';
import type { SkinStore } from './skinStore';

export const SKIN_PRIVILEGED_SCHEME = {
  scheme: SkinProtocol.Scheme,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
  },
} as const;

export const notifySkinChanged = (): void => {
  BrowserWindow.getAllWindows().forEach((window) => {
    if (!window.isDestroyed()) window.webContents.send(SkinIpc.Changed);
  });
};

export function registerSkinElectronIntegration(store: SkinStore): void {
  protocol.handle(SkinProtocol.Scheme, createSkinProtocolHandler({
    rootDir: store.rootDir,
    resolveAsset: (skinId, slot) => store.resolveProtocolAsset(skinId, slot),
  }));

  ipcMain.handle(SkinIpc.GetActive, async (): Promise<SkinGetActiveResponse> => {
    try {
      const activeSkin = await store.getActive();
      return {
        success: true,
        activeSkin: activeSkin ? presentSkin(activeSkin) : null,
      };
    } catch (error) {
      console.error('[Skin] failed to load active skin:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to load active skin',
      };
    }
  });

  ipcMain.handle(SkinIpc.List, async (): Promise<SkinListResponse> => {
    try {
      const skins = await store.listSkins();
      return {
        success: true,
        skins: skins
          .filter(skin => skin.status === SkinRecordStatus.Ready)
          .map(presentSkin),
      };
    } catch (error) {
      console.error('[Skin] failed to list skins:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list skins',
      };
    }
  });

  ipcMain.handle(SkinIpc.Apply, async (
    _event,
    skinId: string,
    boundThemeId?: string,
  ): Promise<SkinApplyResponse> => {
    try {
      const activeSkin = await store.apply(skinId, boundThemeId);
      notifySkinChanged();
      return {
        success: true,
        activeSkin: presentSkin(activeSkin),
      };
    } catch (error) {
      console.error('[Skin] failed to apply skin:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to apply skin',
      };
    }
  });

  ipcMain.handle(SkinIpc.BindTheme, async (
    _event,
    skinId: string,
    themeId: string,
  ): Promise<SkinBindThemeResponse> => {
    try {
      const skin = await store.bindTheme(skinId, themeId);
      notifySkinChanged();
      return {
        success: true,
        skin: presentSkin(skin),
      };
    } catch (error) {
      console.error('[Skin] failed to bind skin theme:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to bind skin theme',
      };
    }
  });

  ipcMain.handle(SkinIpc.Deactivate, async (): Promise<SkinDeactivateResponse> => {
    try {
      await store.deactivate();
      notifySkinChanged();
      return { success: true };
    } catch (error) {
      console.error('[Skin] failed to deactivate skin:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to deactivate skin',
      };
    }
  });

  ipcMain.handle(SkinIpc.Delete, async (_event, skinId: string): Promise<SkinDeleteResponse> => {
    try {
      const result = await store.deleteSkin(skinId);
      notifySkinChanged();
      return {
        success: true,
        wasActive: result.wasActive,
      };
    } catch (error) {
      console.error('[Skin] failed to delete skin:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete skin',
      };
    }
  });
}
