import { clipboard } from 'electron';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { COMPANION_COPY_MAX_BYTES } from '../../shared/desktopCompanion/constants';
import { copyCompanionText } from './companionClipboard';

vi.mock('electron', () => ({ clipboard: { writeText: vi.fn() } }));
vi.mock('../i18n', () => ({ t: (key: string) => key }));

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('companion clipboard capacity', () => {
  test.each(['x', '字', '🦞'])('copies exactly the byte limit for %s and rejects one extra byte', char => {
    const bytes = Buffer.byteLength(char, 'utf8');
    const text = char.repeat(Math.floor(COMPANION_COPY_MAX_BYTES / bytes)) + 'x'.repeat(COMPANION_COPY_MAX_BYTES % bytes);
    expect(copyCompanionText(text)).toEqual({ success: true });
    expect(clipboard.writeText).toHaveBeenCalledWith(text);
    expect(copyCompanionText(text + 'x')).toEqual({ success: false, error: 'desktopCompanionCopyTooLarge' });
    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
  });

  test('reports a native clipboard failure without reporting success or logging the text', () => {
    const error = new Error('clipboard unavailable');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(clipboard.writeText).mockImplementationOnce(() => { throw error; });
    expect(copyCompanionText('private selection')).toEqual({ success: false, error: 'desktopCompanionCopyFailed' });
    expect(log).toHaveBeenCalledExactlyOnceWith('[DesktopCompanion] Clipboard write failed:', error);
  });
});
