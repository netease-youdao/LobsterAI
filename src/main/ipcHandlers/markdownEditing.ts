import { type BrowserWindow, ipcMain, type WebContents } from 'electron';

import { MarkdownFileIpc, type SaveMarkdownFileRequest } from '../../shared/artifactPreview/markdownEditing';
import { readMarkdownFile, saveMarkdownFile } from '../libs/markdownFileEditing';

const unsafeEditors = new Set<WebContents>();
const observedEditors = new WeakSet<WebContents>();

export const hasUnsafeMarkdownEdits = (): boolean => unsafeEditors.size > 0;

export function registerMarkdownEditingHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle(MarkdownFileIpc.Read, (_event, filePath: string) => readMarkdownFile(filePath));
  ipcMain.handle(MarkdownFileIpc.Save, (_event, request: SaveMarkdownFileRequest) => saveMarkdownFile(request));
  ipcMain.on(MarkdownFileIpc.SetUnsafeEdits, (event, unsafe: unknown) => {
    const owner = getMainWindow()?.webContents;
    if (!owner || owner.isDestroyed() || event.sender !== owner
      || event.senderFrame !== owner.mainFrame || typeof unsafe !== 'boolean') return;
    if (!observedEditors.has(owner)) {
      observedEditors.add(owner);
      const clear = () => { unsafeEditors.delete(owner); };
      owner.once('destroyed', clear);
      owner.on('render-process-gone', clear);
      // Only clear on a committed navigation; beforeunload may cancel a reload.
      owner.on('did-navigate', clear);
    }
    if (unsafe) unsafeEditors.add(owner);
    else unsafeEditors.delete(owner);
  });
}
