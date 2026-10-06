import { describe, expect, test } from 'vitest';

import {
  captureLibrarySessionScrollAnchor,
  getLibrarySessionAnchorKey,
} from './libraryScrollAnchor';

const makeRoot = (headers: Array<{ sessionId: string; top: number }>, scrollTop = 500): HTMLElement => ({
  scrollTop,
  getBoundingClientRect: () => ({ top: 100, bottom: 600 }),
  querySelectorAll: () => headers.map(header => ({
    dataset: { libraryAnchorKey: getLibrarySessionAnchorKey(header.sessionId) },
    getBoundingClientRect: () => ({ top: header.top, bottom: header.top + 30 }),
  })),
} as unknown as HTMLElement);

describe('library session collapse scroll anchors', () => {
  test('preserves the offset of a visible surviving header', () => {
    const anchor = captureLibrarySessionScrollAnchor(makeRoot([{ sessionId: 'task', top: 160 }]), 7, 'task');
    expect(anchor).toEqual({
      candidates: [{ itemKey: getLibrarySessionAnchorKey('task'), offsetTop: 60 }],
      scrollTop: 500,
      userGeneration: 7,
      preferTarget: true,
    });
  });

  test('targets an unmounted header instead of a hidden file at a long-task footer', () => {
    const anchor = captureLibrarySessionScrollAnchor(makeRoot([]), 7, 'task');
    expect(anchor.candidates).toEqual([{ itemKey: getLibrarySessionAnchorKey('task'), offsetTop: 0 }]);
    expect(anchor.preferTarget).toBe(true);
  });

  test.each([50, 650])('does not preserve an offscreen overscan header offset at %i', top => {
    const anchor = captureLibrarySessionScrollAnchor(makeRoot([{ sessionId: 'task', top }]), 1, 'task');
    expect(anchor.candidates[0].offsetTop).toBe(0);
  });

  test('retains an explicit session target at the top instead of triggering ordinary top restoration', () => {
    const anchor = captureLibrarySessionScrollAnchor(makeRoot([{ sessionId: 'task', top: 160 }], 0), 1, 'task');
    expect(anchor.scrollTop).toBe(0);
    expect(anchor.preferTarget).toBe(true);
    expect(anchor.candidates[0].offsetTop).toBe(60);
  });

  test('uses raw session identity without date, title, or CSS-selector interpolation', () => {
    const sessionId = 'task:2026/09"[]';
    const anchor = captureLibrarySessionScrollAnchor(makeRoot([{ sessionId, top: 130 }]), 1, sessionId);
    expect(anchor.candidates[0]).toEqual({ itemKey: getLibrarySessionAnchorKey(sessionId), offsetTop: 30 });
  });

  test('supports a temporarily missing scroll root without guessing an item anchor', () => {
    const anchor = captureLibrarySessionScrollAnchor(null, 1, 'task');
    expect(anchor.scrollTop).toBe(0);
    expect(anchor.candidates).toEqual([{ itemKey: getLibrarySessionAnchorKey('task'), offsetTop: 0 }]);
  });
});
