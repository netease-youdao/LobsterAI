import { ipcMain, nativeImage } from 'electron';

import { type PptAssetRequest, PptCreationIpc } from '../../shared/pptCreation/constants';
import { PptCover, type PptCoverExportRequest,PptCoverIpc, type PptCoverRequest } from '../../shared/pptCreation/cover';
import { composeCover, readCoverTemplate } from '../libs/pptCoverPackage';
import type { PptCreationStore } from '../libs/pptCreationStore';

export function registerPptCreationHandlers(store: PptCreationStore): void {
  ipcMain.handle(PptCreationIpc.GetCatalog, () => store.getCatalog());
  ipcMain.handle(PptCreationIpc.GetAsset, (_event, request: PptAssetRequest) => store.getAsset(request));
  const template = async (request: PptCoverRequest) => {
    const catalog = await store.getCatalog();
    const recipe = catalog.examples.find(item => item.id === request?.exampleId)?.cover;
    if (!recipe || request.version !== catalog.version) throw new Error('Cover template unavailable');
    const file = await store.getAsset({ ...request, assetId: recipe.file.id });
    return Buffer.from(file.base64Data, 'base64');
  };
  ipcMain.handle(PptCoverIpc.Template, async (_event, request: PptCoverRequest) => {
    const { background } = await readCoverTemplate(await template(request));
    return { imageBase64: background.toString('base64') };
  });
  ipcMain.handle(PptCoverIpc.Export, async (_event, request: PptCoverExportRequest) => {
    let image: Buffer | undefined;
    if (request.imageBase64 !== undefined) {
      if (typeof request.imageBase64 !== 'string' || request.imageBase64.length > PptCover.MaxImageBytes * 1.4) throw new Error('Invalid cover image');
      const bitmap = nativeImage.createFromBuffer(Buffer.from(request.imageBase64, 'base64'));
      const { width, height } = bitmap.getSize();
      if (!width || !height || width * height > PptCover.MaxPixels || Math.abs(width / height - 16 / 9) > 0.04) throw new Error('Cover image must be 16:9');
      image = bitmap.toPNG();
      if (image.length > PptCover.MaxImageBytes) throw new Error('Cover image is too large');
    }
    const bytes = await composeCover(await template(request), request.fields, image);
    return { name: 'cover.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', base64Data: bytes.toString('base64') };
  });
}
