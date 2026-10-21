import type { BrowserWindow, IpcMain } from 'electron';

import { FeedbackError, type FeedbackInput, FeedbackIpc, type FeedbackResult, isValidFeedback } from '../../shared/feedback/constants';
import type { LogArchiveEntry } from '../libs/logExport';
import { collectFeedbackLogs, FeedbackLogsTooLargeError } from './feedbackLogs';

interface FeedbackDependencies {
  ipcMain: IpcMain;
  getMainWindow: () => BrowserWindow | null;
  hasAuthTokens: () => boolean;
  getServerBaseUrl: () => string;
  getClientVersion: () => string;
  getLogEntries: () => LogArchiveEntry[];
  fetchWithAuth: (url: string, options?: RequestInit) => Promise<Response>;
}

export function registerFeedbackIpc(deps: FeedbackDependencies): void {
  let submitting = false;
  deps.ipcMain.handle(FeedbackIpc.Submit, async (event, input: FeedbackInput): Promise<FeedbackResult> => {
    const window = deps.getMainWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame || !isValidFeedback(input)) {
      return { success: false, error: FeedbackError.Invalid };
    }
    if (!deps.hasAuthTokens()) return { success: false, error: FeedbackError.Unauthorized };
    if (submitting) return { success: false, error: FeedbackError.RateLimited };
    submitting = true;
    try {
      const body = new FormData();
      body.set('requestId', input.requestId);
      body.set('category', input.category);
      body.set('content', input.content.trim());
      body.set('clientVersion', deps.getClientVersion());
      body.set('platform', process.platform);
      body.set('includeLogs', String(input.includeLogs));
      for (const image of input.images) {
        body.append('images', new Blob([Uint8Array.from(image.bytes)], { type: image.type }), image.name);
      }
      if (input.includeLogs) {
        const logs = await collectFeedbackLogs(deps.getLogEntries());
        body.set('logs', new Blob([Uint8Array.from(logs)], { type: 'application/zip' }), 'diagnostics.zip');
      }
      const response = await deps.fetchWithAuth(`${deps.getServerBaseUrl()}/api/feedback`, {
        method: 'POST', body, signal: AbortSignal.timeout(120_000),
      });
      const result = await response.json() as { code?: number; data?: { id?: number } };
      if (response.ok && result.code === 0 && typeof result.data?.id === 'number') {
        return { success: true, id: result.data.id };
      }
      if (response.status === 401 || result.code === 401 || result.code === 40100 || result.code === 40101) {
        return { success: false, error: FeedbackError.Unauthorized };
      }
      if (response.status === 429 || result.code === 50301) return { success: false, error: FeedbackError.RateLimited };
      console.warn(`[Feedback] Submission rejected: status=${response.status}, code=${result.code}`);
      return { success: false, error: FeedbackError.Failed };
    } catch (error) {
      if (error instanceof FeedbackLogsTooLargeError) return { success: false, error: FeedbackError.LogsTooLarge };
      console.error('[Feedback] Submission failed', error);
      return { success: false, error: FeedbackError.Failed };
    } finally {
      submitting = false;
    }
  });
}
