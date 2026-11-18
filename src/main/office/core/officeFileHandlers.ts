import { watch } from 'node:fs';
import path from 'node:path';

import { type BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';

import { type OfficeFileChannels, OfficeFileError, type OfficePackageInfo, type OfficeWriteRequest } from '../../../shared/office/core/officeFile';
import type { OfficeAgentBridge } from './officeAgentBridge';
import type { OfficeFileStore } from './officeFileStore';

export interface OfficeFileHandlerOptions<TInfo extends OfficePackageInfo> {
  channels: OfficeFileChannels;
  store: OfficeFileStore<TInfo>;
  agent: OfficeAgentBridge;
  getMainWindow: () => BrowserWindow | null;
  /** Shown to the agent when the window reloads mid-call, e.g. `Excel`. */
  editorName: string;
  logTag: string;
}

/**
 * Office and WPS mark a document they hold open with an owner file next to it (`~$name`, which Word
 * shortens by up to two leading characters), LibreOffice with `.~lock.name#`. It goes away when the
 * document is closed there, which is when a save refused meanwhile can succeed.
 */
export function isLockFileOf(name: string, base: string): boolean {
  if (name === `.~lock.${base}#`) return true;
  if (!name.startsWith('~$')) return false;
  const rest = name.slice(2);
  return rest.length >= base.length - 2 && base.endsWith(rest);
}

/** Whether an IPC call comes from the main window's top frame, the only caller the editors accept. */
export type OfficeCallerCheck = (event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>) => boolean;

export interface OfficeFileHandlers {
  hasUnsafeEdits: () => boolean;
  /** Guards a format's own channels the same way. */
  allowed: OfficeCallerCheck;
}

/**
 * Registers one Office format's file channels: only the main window's top frame may call them,
 * handles die with the window, and a directory watch reports external replacements of an open
 * file.
 */
export function registerOfficeFileHandlers<TInfo extends OfficePackageInfo>(options: OfficeFileHandlerOptions<TInfo>): OfficeFileHandlers {
  const { channels, store, agent, getMainWindow } = options;
  const unsafeEditors = new Set<WebContents>();
  const observed = new WeakSet<WebContents>();
  const ownerEpoch = new WeakMap<WebContents, number>();
  const watches = new Map<string, { owner: number; close: () => void }>();
  const releaseWatches = (owner: number) => {
    for (const [id, watcher] of watches) if (watcher.owner === owner) {
      watcher.close();
      watches.delete(id);
    }
  };
  const watchDocument = (owner: WebContents, sessionId: string, filePath: string) => {
    if (watches.has(sessionId)) return;
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const base = path.basename(filePath).toLowerCase();
      // Watch the directory: Office and our own saves replace the file's inode.
      const watcher = watch(path.dirname(filePath), { persistent: false }, (_event, name) => {
        const changed = name?.toString().toLowerCase();
        if (changed && changed !== base && !isLockFileOf(changed, base)) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (!owner.isDestroyed()) owner.send(channels.Changed, sessionId);
        }, 250);
      });
      watcher.on('error', error => { console.warn(`${options.logTag} Document watcher failed:`, error); });
      watches.set(sessionId, { owner: owner.id, close: () => { clearTimeout(timer); watcher.close(); } });
    } catch (error) {
      // Save still checks versions even if this filesystem cannot be watched.
      console.warn(`${options.logTag} Could not watch document:`, error);
    }
  };
  const allowed: OfficeCallerCheck = event => {
    const owner = getMainWindow()?.webContents;
    if (!owner || owner.isDestroyed() || event.sender !== owner || event.senderFrame !== owner.mainFrame) return false;
    if (!observed.has(owner)) {
      observed.add(owner);
      const clear = () => {
        ownerEpoch.set(owner, (ownerEpoch.get(owner) ?? 0) + 1);
        store.releaseOwner(owner.id);
        releaseWatches(owner.id);
        unsafeEditors.delete(owner);
        agent.cancelAll(`The LobsterAI window reloaded before the ${options.editorName} edit finished; read the file again.`);
      };
      owner.once('destroyed', clear);
      owner.on('render-process-gone', clear);
      owner.on('did-navigate', clear);
    }
    return true;
  };
  const forbidden = { success: false, code: OfficeFileError.Forbidden } as const;
  ipcMain.handle(channels.Open, async (event, filePath: string) => {
    if (!allowed(event)) return forbidden;
    const epoch = ownerEpoch.get(event.sender) ?? 0;
    const result = await store.open(event.sender.id, filePath);
    if (!allowed(event) || (ownerEpoch.get(event.sender) ?? 0) !== epoch) {
      if (result.success) store.release(event.sender.id, result.value.sessionId);
      return forbidden;
    }
    if (result.success) watchDocument(event.sender, result.value.sessionId, result.value.filePath);
    return result;
  });
  ipcMain.handle(channels.Read, (event, sessionId: string) =>
    allowed(event) ? store.read(event.sender.id, sessionId) : forbidden);
  ipcMain.handle(channels.Checkpoint, (event, request: OfficeWriteRequest) =>
    allowed(event) ? store.checkpoint(event.sender.id, request) : forbidden);
  ipcMain.handle(channels.Save, (event, request: OfficeWriteRequest) =>
    allowed(event) ? store.save(event.sender.id, request) : forbidden);
  ipcMain.handle(channels.DiscardDraft, (event, sessionId: string) =>
    allowed(event) ? store.discardDraft(event.sender.id, sessionId) : forbidden);
  ipcMain.handle(channels.Release, (event, sessionId: string) => {
    if (!allowed(event)) return;
    store.release(event.sender.id, sessionId);
    const watcher = watches.get(sessionId);
    if (watcher?.owner === event.sender.id) {
      watcher.close();
      watches.delete(sessionId);
    }
  });
  ipcMain.on(channels.SetUnsafeEdits, (event, unsafe: unknown) => {
    if (!allowed(event) || typeof unsafe !== 'boolean') return;
    if (unsafe) unsafeEditors.add(event.sender);
    else unsafeEditors.delete(event.sender);
  });
  ipcMain.on(channels.AgentRespond, agent.handleResponse);
  return { hasUnsafeEdits: () => unsafeEditors.size > 0, allowed };
}
