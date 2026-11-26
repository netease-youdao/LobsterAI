import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';

/** Privileged account and device settings are only exposed to the main desktop frame. */
export function isMainWindowRequest(sender: WebContents | undefined, event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>): boolean {
  return !!sender && !sender.isDestroyed() && event.sender === sender && !!event.senderFrame && event.senderFrame === sender.mainFrame;
}

export function mainWindowHandler(sender: () => WebContents | undefined) {
  return (channel: string, action: Parameters<typeof ipcMain.handle>[1]): void => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!isMainWindowRequest(sender(), event)) throw new Error('Desktop window unavailable');
      return action(event, ...args);
    });
  };
}
