import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import { WordPanelAction, type WordPanelGuest, WordPanelIpc, type WordPanelPresentation, type WordPanelSessionAction } from '../../../shared/office/word/constants';
import { createOfficeBridges } from '../officePreloadBridges';

let active: WordPanelPresentation | null = null;
const guest: WordPanelGuest = {
  ready: () => ipcRenderer.send(WordPanelIpc.Ready),
  presented: token => ipcRenderer.send(WordPanelIpc.Presented, token),
  action: event => ipcRenderer.send(WordPanelIpc.Action, event),
  onPresent: listener => {
    const handler = (_event: IpcRendererEvent, panel: WordPanelPresentation | null) => { active = panel; listener(panel); };
    ipcRenderer.on(WordPanelIpc.Present, handler);
    return () => { ipcRenderer.removeListener(WordPanelIpc.Present, handler); };
  },
  onSession: listener => {
    const handler = async (event: IpcRendererEvent, request: { action: WordPanelSessionAction; filePath: string }) => {
      const [port] = event.ports;
      try { port.postMessage(await listener(request.action, request.filePath)); }
      catch { port.postMessage(null); }
      finally { port.close(); }
    };
    ipcRenderer.on(WordPanelIpc.Session, handler);
    return () => { ipcRenderer.removeListener(WordPanelIpc.Session, handler); };
  },
};

contextBridge.exposeInMainWorld('wordPanelGuest', guest);
contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  artifact: { office: { word: createOfficeBridges(ipcRenderer).word } },
  dialog: { readFileAsDataUrl: (filePath: string) => ipcRenderer.invoke(WordPanelIpc.ReadPreview, filePath) },
  shell: { openPath: (filePath: string) => {
    if (!active || filePath !== active.filePath) return { success: false };
    guest.action({ token: active.token, action: WordPanelAction.OpenExternal });
    return { success: true };
  } },
});
