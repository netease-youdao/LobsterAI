import type { BrowserWindow, Session } from 'electron';

export interface RendererPermissionHandlerOptions {
  session: Session;
  getMainWindow: () => BrowserWindow | null;
  isDev: boolean;
  startUrl?: string;
}
