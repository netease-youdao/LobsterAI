import { describe, expect, test, vi } from 'vitest';

import type { ContextCleanupUndoResult } from '../../../shared/contextCleanup/types';
import { i18nService } from '../../services/i18n';
import { type ToastEventDetail, ToastPlacement } from '../Toast';
import {
  CONTEXT_CLEANUP_UNDO_TOAST_DURATION_MS,
  showContextCleanupUndoToast,
} from './contextCleanupToast';

describe('showContextCleanupUndoToast', () => {
  test('dispatches a top-placed 8s undo toast and restores items on action click', async () => {
    const dispatched: ToastEventDetail[] = [];
    const onUndone = vi.fn();
    const undo = vi.fn(async (): Promise<ContextCleanupUndoResult> => ({
      success: true,
      restoredCount: 104,
    }));

    showContextCleanupUndoToast(
      { closedCount: 104, savedTokens: 3500, undoToken: 'undo-token-1' },
      {
        onUndone,
        undo,
        dispatchToast: (detail) => dispatched.push(detail),
      },
    );

    expect(dispatched).toHaveLength(1);
    const initial = dispatched[0];
    expect(initial.placement).toBe(ToastPlacement.Top);
    expect(initial.durationMs).toBe(CONTEXT_CLEANUP_UNDO_TOAST_DURATION_MS);
    expect(initial.actionLabel).toBe(i18nService.t('contextCleanupToastUndo'));
    expect(initial.message).toContain('104');
    expect(initial.message).toContain('3.5k');
    expect(typeof initial.onAction).toBe('function');

    initial.onAction?.();
    await vi.waitFor(() => {
      expect(dispatched).toHaveLength(2);
    });

    expect(undo).toHaveBeenCalledTimes(1);
    expect(undo).toHaveBeenCalledWith('undo-token-1');
    expect(onUndone).toHaveBeenCalledTimes(1);
    expect(dispatched[1]).toEqual({
      message: i18nService.t('contextCleanupToastUndone').replace('{count}', '104'),
      placement: ToastPlacement.Top,
    });
  });

  test('ignores duplicate undo clicks while an undo request is still in flight', async () => {
    const dispatched: ToastEventDetail[] = [];
    let resolveUndo!: (value: ContextCleanupUndoResult) => void;
    const undo = vi.fn(() => new Promise<ContextCleanupUndoResult>((resolve) => {
      resolveUndo = resolve;
    }));

    showContextCleanupUndoToast(
      { closedCount: 5, savedTokens: 1600, undoToken: 'undo-token-2' },
      {
        undo,
        dispatchToast: (detail) => dispatched.push(detail),
      },
    );

    dispatched[0]?.onAction?.();
    dispatched[0]?.onAction?.();
    expect(undo).toHaveBeenCalledTimes(1);

    resolveUndo({ success: true, restoredCount: 5 });
    await vi.waitFor(() => {
      expect(dispatched).toHaveLength(2);
    });
  });

  test('shows localized top-placed failure toast when undo fails or throws', async () => {
    const dispatched: ToastEventDetail[] = [];
    const onUndone = vi.fn();

    showContextCleanupUndoToast(
      { closedCount: 3, savedTokens: 1800, undoToken: 'expired-token' },
      {
        onUndone,
        undo: async () => ({ success: false, restoredCount: 0, error: 'expired' }),
        dispatchToast: (detail) => dispatched.push(detail),
      },
    );

    dispatched[0]?.onAction?.();
    await vi.waitFor(() => {
      expect(dispatched).toHaveLength(2);
    });

    expect(onUndone).not.toHaveBeenCalled();
    expect(dispatched[1]).toEqual({
      message: i18nService.t('contextCleanupToastUndoFailed'),
      placement: ToastPlacement.Top,
    });

    dispatched.length = 0;
    showContextCleanupUndoToast(
      { closedCount: 3, savedTokens: 1800, undoToken: 'boom-token' },
      {
        onUndone,
        undo: async () => {
          throw new Error('network error');
        },
        dispatchToast: (detail) => dispatched.push(detail),
      },
    );

    dispatched[0]?.onAction?.();
    await vi.waitFor(() => {
      expect(dispatched).toHaveLength(2);
    });

    expect(onUndone).not.toHaveBeenCalled();
    expect(dispatched[1]).toEqual({
      message: i18nService.t('contextCleanupToastUndoFailed'),
      placement: ToastPlacement.Top,
    });
  });
});
