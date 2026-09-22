import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAllWindows: vi.fn(),
}));

vi.mock('electron', () => ({ BrowserWindow: mocks }));

import { hideAppWindowsForQuit } from './appQuitWindows';

function makeWindow() {
  let visible = true;
  return {
    isDestroyed: vi.fn(() => false),
    isVisible: () => visible,
    setEnabled: vi.fn(),
    hide: () => { visible = false; },
    destroy: vi.fn(),
  };
}

describe('hideAppWindowsForQuit', () => {
  beforeEach(() => { mocks.getAllWindows.mockReset(); });

  test('hides windows synchronously while retaining them for storage cleanup', () => {
    const windows = [makeWindow(), makeWindow()];
    mocks.getAllWindows.mockReturnValue(windows);

    hideAppWindowsForQuit();

    for (const window of windows) {
      expect(window.isVisible()).toBe(false);
      expect(window.setEnabled).not.toHaveBeenCalled();
      expect(window.destroy).not.toHaveBeenCalled();
    }
  });

  test('skips destroyed windows without preventing other windows from hiding', () => {
    const destroyed = makeWindow();
    destroyed.isDestroyed.mockReturnValue(true);
    const live = makeWindow();
    mocks.getAllWindows.mockReturnValue([destroyed, live]);

    hideAppWindowsForQuit();

    expect(destroyed.setEnabled).not.toHaveBeenCalled();
    expect(live.isVisible()).toBe(false);
  });
});
