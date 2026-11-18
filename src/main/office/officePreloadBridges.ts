import type { IpcRenderer, IpcRendererEvent } from 'electron';

import { OfficeEditorId } from '../../shared/office/core/officeEditor';
import type { OfficeFileBridge, OfficeFileChannels, OfficePackageInfo } from '../../shared/office/core/officeFile';
import type { OfficeBridges } from '../../shared/office/editors';
import { SheetFileIpc, type SheetPackageInfo } from '../../shared/office/sheet/sheetFile';
import { SlidesFileIpc, type SlidesPackageInfo } from '../../shared/office/slides/slidesFile';
import { WordFileIpc, type WordPackageInfo } from '../../shared/office/word/wordFile';

/** One editor's file bridge over its channels. Runs in the preload, so it only uses ipcRenderer. */
export function createOfficeFileBridge<TInfo extends OfficePackageInfo>(ipc: IpcRenderer, channels: OfficeFileChannels): OfficeFileBridge<TInfo> {
  const subscribe = <T>(channel: string, listener: (value: T) => void) => {
    const handler = (_event: IpcRendererEvent, value: T) => listener(value);
    ipc.on(channel, handler);
    return () => { ipc.removeListener(channel, handler); };
  };
  return {
    open: filePath => ipc.invoke(channels.Open, filePath),
    read: sessionId => ipc.invoke(channels.Read, sessionId),
    checkpoint: request => ipc.invoke(channels.Checkpoint, request),
    save: request => ipc.invoke(channels.Save, request),
    discardDraft: sessionId => ipc.invoke(channels.DiscardDraft, sessionId),
    release: sessionId => ipc.invoke(channels.Release, sessionId),
    setHasUnsafeEdits: unsafe => ipc.send(channels.SetUnsafeEdits, unsafe),
    onChanged: listener => subscribe(channels.Changed, listener),
    onAgentRequest: listener => subscribe(channels.AgentRequest, listener),
    respondAgent: response => ipc.send(channels.AgentRespond, response),
  };
}

/** `window.electron.artifact.office`: every editor's bridge, plus the Word editor's installed fonts. */
export function createOfficeBridges(ipc: IpcRenderer): OfficeBridges {
  return {
    [OfficeEditorId.Word]: {
      ...createOfficeFileBridge<WordPackageInfo>(ipc, WordFileIpc),
      resolveFonts: families => ipc.invoke(WordFileIpc.ResolveFonts, families),
      readFont: faceId => ipc.invoke(WordFileIpc.ReadFont, faceId),
    },
    [OfficeEditorId.Sheet]: createOfficeFileBridge<SheetPackageInfo>(ipc, SheetFileIpc),
    [OfficeEditorId.Slides]: createOfficeFileBridge<SlidesPackageInfo>(ipc, SlidesFileIpc),
  };
}
