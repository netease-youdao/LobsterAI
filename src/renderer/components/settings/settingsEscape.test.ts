import { describe, expect, test, vi } from 'vitest';

import { resolveSettingsEscapeAction, SettingsEscapeAction } from './settingsEscape';

describe('resolveSettingsEscapeAction', () => {
  test('closes the panel when nothing is stacked on top', () => {
    const result = resolveSettingsEscapeAction({
      isBlocked: false,
      layers: [{ isOpen: false, dismiss: vi.fn() }],
    });

    expect(result.action).toBe(SettingsEscapeAction.ClosePanel);
  });

  test('does nothing while an operation blocks the panel', () => {
    const dismiss = vi.fn();
    const result = resolveSettingsEscapeAction({
      isBlocked: true,
      layers: [{ isOpen: true, dismiss }],
    });

    expect(result.action).toBe(SettingsEscapeAction.Ignore);
    expect(dismiss).not.toHaveBeenCalled();
  });

  test('dismisses the topmost open layer instead of closing the panel', () => {
    const topmost = vi.fn();
    const below = vi.fn();
    const result = resolveSettingsEscapeAction({
      isBlocked: false,
      layers: [
        { isOpen: false, dismiss: vi.fn() },
        { isOpen: true, dismiss: topmost },
        { isOpen: true, dismiss: below },
      ],
    });

    expect(result.action).toBe(SettingsEscapeAction.DismissLayer);
    if (result.action !== SettingsEscapeAction.DismissLayer) return;
    result.dismiss();
    expect(topmost).toHaveBeenCalledTimes(1);
    expect(below).not.toHaveBeenCalled();
  });
});
