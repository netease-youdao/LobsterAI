import { ipcRenderer } from 'electron';

import {
  type LanguageToolEvent, type LanguageToolInput, type LanguageToolsBridge, LanguageToolsIpc, type SpeechCommand,
} from '../../shared/desktopCompanion/languageTools';

const subscribe = <T>(channel: string, callback: (value: T) => void) => {
  const handler = (_event: Electron.IpcRendererEvent, value: T) => callback(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

export function createLanguageToolsBridge(): LanguageToolsBridge {
  return {
    openLanguageTool: input => ipcRenderer.invoke(LanguageToolsIpc.Open, input),
    getLanguageToolInput: () => ipcRenderer.invoke(LanguageToolsIpc.GetInput),
    startLanguageTool: request => ipcRenderer.invoke(LanguageToolsIpc.Start, request),
    abortLanguageTool: id => ipcRenderer.invoke(LanguageToolsIpc.Abort, id),
    getLanguageToolQuota: () => ipcRenderer.invoke(LanguageToolsIpc.Quota),
    hideLanguageTool: () => ipcRenderer.invoke(LanguageToolsIpc.Hide),
    closeLanguageTool: () => ipcRenderer.invoke(LanguageToolsIpc.Close),
    pinLanguageTool: pinned => ipcRenderer.invoke(LanguageToolsIpc.Pin, pinned),
    setSpeechStatus: status => ipcRenderer.invoke(LanguageToolsIpc.SpeechStatus, status),
    speechCommand: command => ipcRenderer.invoke(LanguageToolsIpc.SpeechCommand, command),
    onLanguageToolInput: callback => subscribe<LanguageToolInput>(LanguageToolsIpc.Input, callback),
    onLanguageToolEvent: callback => subscribe<LanguageToolEvent>(LanguageToolsIpc.Event, callback),
    onSpeechCommand: callback => subscribe<SpeechCommand>(LanguageToolsIpc.SpeechCommand, callback),
    onLanguageToolsReset: callback => subscribe(LanguageToolsIpc.Reset, callback),
  };
}
