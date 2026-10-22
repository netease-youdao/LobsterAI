import { type BrowserWindow, ipcMain } from 'electron';

import { type ImageEditingBridge, ImageEditingIpc, type ImageEditingResult } from '../../shared/imageEditing/types';
import { t } from '../i18n';
import type { ImageEditingService } from '../libs/imageEditing';

export function registerImageEditingHandlers(getWindow: () => BrowserWindow | null, service: ImageEditingService): void {
  const handle = <K extends Exclude<keyof ImageEditingBridge, 'onChanged'>>(channel: string, method: K) => {
    ipcMain.handle(channel, async (event, input: Parameters<ImageEditingBridge[K]>[0]): Promise<ImageEditingResult<unknown>> => {
      const owner = getWindow()?.webContents;
      if (!owner || event.sender !== owner || event.senderFrame !== owner.mainFrame) return { success: false, error: t('imageEditFailed') };
      try {
        const call = service[method].bind(service) as (value: typeof input) => Promise<unknown> | unknown;
        return { success: true, data: await call(input) };
      } catch (error) {
        console.error('[ImageEditing] Operation failed', error);
        return { success: false, error: error instanceof Error ? error.message : t('imageEditFailed') };
      }
    });
  };
  handle(ImageEditingIpc.Open, 'open'); handle(ImageEditingIpc.Read, 'read');
  handle(ImageEditingIpc.List, 'list'); handle(ImageEditingIpc.Save, 'save'); handle(ImageEditingIpc.Stage, 'stage');
  handle(ImageEditingIpc.History, 'history'); handle(ImageEditingIpc.ReadSnapshot, 'readSnapshot');
}
