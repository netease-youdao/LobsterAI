import { ipcMain } from 'electron';

import { type PptAssetRequest, PptCreationIpc } from '../../shared/pptCreation/constants';
import type { PptCreationStore } from '../libs/pptCreationStore';

export function registerPptCreationHandlers(store: PptCreationStore): void {
  ipcMain.handle(PptCreationIpc.GetCatalog, () => store.getCatalog());
  ipcMain.handle(PptCreationIpc.GetAsset, (_event, request: PptAssetRequest) => store.getAsset(request));
}
