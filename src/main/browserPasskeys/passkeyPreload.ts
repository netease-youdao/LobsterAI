import { contextBridge, ipcRenderer } from 'electron';

import {
  BrowserCredentialMediation,
  BrowserCredentialMethod,
  BrowserPasskeyChannel,
  BrowserPasskeyStatus,
  parseBrowserPasskeyEvent,
} from '../../shared/browserWebAccess/passkeys';
import { installPasskeyObserver } from './passkeyObserver';

contextBridge.executeInMainWorld({
  func: installPasskeyObserver,
  args: [
    { status: BrowserPasskeyStatus, method: BrowserCredentialMethod, mediation: BrowserCredentialMediation },
    (value: unknown) => {
      const event = parseBrowserPasskeyEvent(value);
      if (event) ipcRenderer.send(BrowserPasskeyChannel.Event, event);
    },
    (cancel: (requestId: string) => void) => {
      ipcRenderer.on(BrowserPasskeyChannel.Cancel, (_event, requestId: unknown) => {
        if (typeof requestId === 'string') cancel(requestId);
      });
    },
  ],
});
