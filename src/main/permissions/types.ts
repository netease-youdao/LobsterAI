import type { BrowserWindow, Session, WebContents } from 'electron';

export interface RendererPermissionHandlerOptions {
  session: Session;
  getMainWindow: () => BrowserWindow | null;
  isAdditionalVoiceInputWebContents?: (webContents: WebContents) => boolean;
  isDev: boolean;
  startUrl?: string;
}
