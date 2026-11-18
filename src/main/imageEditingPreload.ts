import type { IpcRenderer } from 'electron';

import { type ImageEditingBridge, ImageEditingIpc, type ImageVersion } from '../shared/imageEditing/types';

export function createImageEditingBridge(ipc: IpcRenderer): ImageEditingBridge {
  return {
    open: input => ipc.invoke(ImageEditingIpc.Open, input), read: input => ipc.invoke(ImageEditingIpc.Read, input),
    list: input => ipc.invoke(ImageEditingIpc.List, input), save: input => ipc.invoke(ImageEditingIpc.Save, input),
    stage: input => ipc.invoke(ImageEditingIpc.Stage, input),
    history: input => ipc.invoke(ImageEditingIpc.History, input),
    readSnapshot: input => ipc.invoke(ImageEditingIpc.ReadSnapshot, input),
    onChanged: callback => {
      const handler = (_event: Electron.IpcRendererEvent, version: ImageVersion) => callback(version);
      ipc.on(ImageEditingIpc.Changed, handler);
      return () => ipc.removeListener(ImageEditingIpc.Changed, handler);
    },
  };
}
