import { afterEach, describe, expect, test, vi } from 'vitest';

import { copyTextToClipboard } from './clipboard';

describe('copyTextToClipboard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('prefers the Electron clipboard bridge over the renderer clipboard API', async () => {
    const electronWriteText = vi.fn().mockResolvedValue({ success: true });
    const navigatorWriteText = vi.fn();

    vi.stubGlobal('window', {
      electron: {
        clipboard: {
          writeText: electronWriteText,
        },
      },
    });
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: navigatorWriteText,
      },
    });

    await expect(copyTextToClipboard('# copied artifact')).resolves.toBe(true);
    expect(electronWriteText).toHaveBeenCalledWith('# copied artifact');
    expect(navigatorWriteText).not.toHaveBeenCalled();
  });
});
