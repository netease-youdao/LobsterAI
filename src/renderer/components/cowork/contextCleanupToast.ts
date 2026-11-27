import type { ContextCleanupUndoResult } from '../../../shared/contextCleanup/types';
import { contextCleanupService } from '../../services/contextCleanup';
import { i18nService } from '../../services/i18n';
import { formatTokenCount } from '../../utils/tokenFormat';
import {
  APP_SHOW_TOAST_EVENT,
  type ToastEventDetail,
  ToastPlacement,
} from '../Toast';

export const CONTEXT_CLEANUP_UNDO_TOAST_DURATION_MS = 8_000;

export interface ContextCleanupUndoState {
  closedCount: number;
  savedTokens: number;
  undoToken: string;
}

export interface ShowContextCleanupUndoToastOptions {
  onUndone?: () => void;
  undo?: (undoToken: string) => Promise<ContextCleanupUndoResult>;
  dispatchToast?: (detail: ToastEventDetail) => void;
}

const defaultDispatchToast = (detail: ToastEventDetail): void => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<ToastEventDetail>(APP_SHOW_TOAST_EVENT, { detail }));
};

export function showContextCleanupUndoToast(
  undoState: ContextCleanupUndoState,
  options?: ShowContextCleanupUndoToastOptions,
): void {
  const dispatchToast = options?.dispatchToast ?? defaultDispatchToast;
  const runUndo = options?.undo ?? ((token: string) => contextCleanupService.undo(token));
  let undoing = false;

  dispatchToast({
    message: i18nService.t('contextCleanupToastSuccess')
      .replace('{count}', String(undoState.closedCount))
      .replace('{tokens}', formatTokenCount(undoState.savedTokens)),
    actionLabel: i18nService.t('contextCleanupToastUndo'),
    placement: ToastPlacement.Top,
    durationMs: CONTEXT_CLEANUP_UNDO_TOAST_DURATION_MS,
    onAction: () => {
      if (undoing) return;
      undoing = true;
      void (async () => {
        try {
          const res = await runUndo(undoState.undoToken);
          if (res.success) {
            options?.onUndone?.();
            dispatchToast({
              message: i18nService.t('contextCleanupToastUndone')
                .replace('{count}', String(res.restoredCount)),
              placement: ToastPlacement.Top,
            });
          } else {
            dispatchToast({
              message: i18nService.t('contextCleanupToastUndoFailed'),
              placement: ToastPlacement.Top,
            });
          }
        } catch {
          dispatchToast({
            message: i18nService.t('contextCleanupToastUndoFailed'),
            placement: ToastPlacement.Top,
          });
        } finally {
          undoing = false;
        }
      })();
    },
  });
}
