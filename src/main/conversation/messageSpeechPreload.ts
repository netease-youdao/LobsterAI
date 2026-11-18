import { ipcRenderer } from 'electron';

import { type MessageSpeechBridge, MessageSpeechIpc } from '../../shared/cowork/messageSpeech';
import type { LanguageToolEvent } from '../../shared/desktopCompanion/languageTools';

export function createMessageSpeechBridge(): MessageSpeechBridge {
  return {
    start: request => ipcRenderer.invoke(MessageSpeechIpc.Start, request),
    stop: requestId => ipcRenderer.invoke(MessageSpeechIpc.Stop, requestId),
    onEvent: callback => {
      const handler = (_event: Electron.IpcRendererEvent, event: LanguageToolEvent) => callback(event);
      ipcRenderer.on(MessageSpeechIpc.Event, handler);
      return () => ipcRenderer.removeListener(MessageSpeechIpc.Event, handler);
    },
    onReset: callback => {
      const handler = (_event: Electron.IpcRendererEvent, requestId: string) => callback(requestId);
      ipcRenderer.on(MessageSpeechIpc.Reset, handler);
      return () => ipcRenderer.removeListener(MessageSpeechIpc.Reset, handler);
    },
  };
}
