import { describe, expect, test, vi } from 'vitest';

import { readDraftSnapshot, writeDraftSnapshot } from './draftPersistence';

describe('draft persistence', () => {
  test('reads and writes confirmation-card snapshots without throwing', () => {
    const storage = {
      getItem: vi.fn(() => '{"draftId":"draft-1"}'),
      setItem: vi.fn(),
    };

    expect(readDraftSnapshot(storage, 'draft-key')).toBe('{"draftId":"draft-1"}');
    expect(writeDraftSnapshot(storage, 'draft-key', { draftId: 'draft-1' })).toBe(true);
    expect(storage.setItem).toHaveBeenCalledWith(
      'draft-key',
      '{"draftId":"draft-1"}',
    );
  });

  test('treats unavailable storage as best effort', () => {
    const storage = {
      getItem: vi.fn(() => { throw new Error('unavailable'); }),
      setItem: vi.fn(() => { throw new Error('full'); }),
    };

    expect(readDraftSnapshot(storage, 'draft-key')).toBeNull();
    expect(writeDraftSnapshot(storage, 'draft-key', {})).toBe(false);
  });
});
