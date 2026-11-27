import { ipcMain } from 'electron';

import { ContextCleanupIpcChannel } from '../../../shared/contextCleanup/constants';
import type { ContextCleanupTargetItem } from '../../../shared/contextCleanup/types';
import type { ContextCleanupService } from '../../contextCleanup/contextCleanupService';

export interface ContextCleanupHandlerDeps {
  getService: () => ContextCleanupService;
  onChanged?: () => void;
}

export function registerContextCleanupHandlers(deps: ContextCleanupHandlerDeps): void {
  ipcMain.handle(
    ContextCleanupIpcChannel.Scan,
    async (_event, options?: { idleDays?: number }) => {
      try {
        const result = deps.getService().scan(options);
        return { success: true, result };
      } catch (error) {
        console.error('[ContextCleanup] scan failed:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to scan idle capabilities',
        };
      }
    },
  );

  ipcMain.handle(
    ContextCleanupIpcChannel.Apply,
    async (_event, items: ContextCleanupTargetItem[]) => {
      try {
        const result = await deps.getService().apply(Array.isArray(items) ? items : []);
        if (result.closedCount > 0) {
          deps.onChanged?.();
        }
        return result;
      } catch (error) {
        console.error('[ContextCleanup] apply failed:', error);
        return {
          success: false,
          closedCount: 0,
          savedTokens: 0,
          undoToken: null,
          failedItems: [],
          error: error instanceof Error ? error.message : 'Failed to apply cleanup',
        };
      }
    },
  );

  ipcMain.handle(
    ContextCleanupIpcChannel.Undo,
    async (_event, undoToken: string) => {
      try {
        const result = await deps.getService().undo(undoToken);
        if (result.restoredCount > 0) {
          deps.onChanged?.();
        }
        return result;
      } catch (error) {
        console.error('[ContextCleanup] undo failed:', error);
        return {
          success: false,
          restoredCount: 0,
          error: error instanceof Error ? error.message : 'Failed to undo cleanup',
        };
      }
    },
  );

  ipcMain.handle(ContextCleanupIpcChannel.Dismiss, async () => {
    try {
      return deps.getService().dismiss();
    } catch (error) {
      console.error('[ContextCleanup] dismiss failed:', error);
      return { success: false, dismissedAt: Date.now() };
    }
  });
}
