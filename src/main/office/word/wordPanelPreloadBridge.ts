import type { IpcRenderer, IpcRendererEvent } from 'electron';

import { type WordPanelBridge, type WordPanelEvent, WordPanelIpc } from '../../../shared/office/word/constants';

export function createWordPanelBridge(ipc: IpcRenderer): WordPanelBridge {
  return {
    prepare: () => ipc.invoke(WordPanelIpc.Prepare),
    present: panel => ipc.invoke(WordPanelIpc.Present, panel),
    bounds: (token, bounds) => ipc.send(WordPanelIpc.Bounds, token, bounds),
    hide: token => ipc.send(WordPanelIpc.Hide, token),
    session: (action, filePath) => ipc.invoke(WordPanelIpc.Session, action, filePath),
    onAction: listener => {
      const handler = (_event: IpcRendererEvent, event: WordPanelEvent) => listener(event);
      ipc.on(WordPanelIpc.Action, handler);
      return () => { ipc.removeListener(WordPanelIpc.Action, handler); };
    },
  };
}
