import { ipcMain } from 'electron';

import { ImageCreationIpc } from '../../shared/imageCreation/constants';
import type { ImageCreationStore } from '../libs/imageCreationStore';

export function registerImageCreationHandlers(store: ImageCreationStore): void {
  ipcMain.handle(ImageCreationIpc.GetCatalog, () => store.getCatalog());
  ipcMain.handle(ImageCreationIpc.GetReference, (_event, exampleId: unknown) => {
    if (typeof exampleId !== 'string' || exampleId.length > 100) throw new Error('Invalid image example identifier');
    return store.getReference(exampleId);
  });
}
