import type { IpcMainInvokeEvent } from 'electron';

import {
  SubscriptionTrialApi,
  SubscriptionTrialIpc,
  type SubscriptionTrialState,
} from '../../shared/subscriptionTrial/constants';
import type { ActivityIpcHandlerDeps } from './activity/handlers';

export function registerSubscriptionTrialIpcHandlers(deps: ActivityIpcHandlerDeps): void {
  const lastFailure = new Map<string, string>();
  const warnOnce = (path: string, detail: string): void => {
    if (lastFailure.get(path) === detail) return;
    lastFailure.set(path, detail);
    console.warn(`[SubscriptionTrial] ${path} unavailable: ${detail}`);
  };
  const requireMainRenderer = (event: IpcMainInvokeEvent): void => {
    const window = deps.getMainWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted trial sender');
  };
  async function request(path: string): Promise<SubscriptionTrialState | null> {
    const authenticated = deps.hasAuthTokens();
    const fetcher = authenticated ? deps.fetchWithAuth : deps.fetchPublic;
    const server = deps.getServerBaseUrl();
    try {
      const response = await fetcher(`${server}${path}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      });
      const result = await response.json() as { code: number; data?: SubscriptionTrialState };
      if (!response.ok || result.code !== 0 || !result.data) {
        warnOnce(path, `server=${server}, authenticated=${authenticated}, http=${response.status}, code=${result.code}`);
        return null;
      }
      lastFailure.delete(path);
      return result.data;
    } catch (error) {
      warnOnce(path, `server=${server}, authenticated=${authenticated}, failure=${error instanceof Error ? error.name : 'unknown'}`);
      return null;
    }
  }
  deps.ipcMain.handle(SubscriptionTrialIpc.Status, (event) => {
    requireMainRenderer(event);
    return request(SubscriptionTrialApi.Status);
  });
}
