import { describe, expect, test } from 'vitest';

import { getPublishingRecoveryFooterActions } from './publishingRecoveryFooterModel';

describe('getPublishingRecoveryFooterActions', () => {
  test.each([
    [true, false],
    [false, true],
  ])(
    'keeps only copy and recovery actions when recovery is visible (canCopy=%s)',
    (canCopy, isCopyDisabled) => {
      expect(getPublishingRecoveryFooterActions({
        showRecovery: true,
        canCopy,
        showCopyInStandardFooter: false,
      })).toEqual({
        showStandardActions: false,
        showCopy: true,
        isCopyDisabled,
        showRecovery: true,
      });
    },
  );

  test('preserves a visible standard copy action', () => {
    expect(getPublishingRecoveryFooterActions({
      showRecovery: false,
      canCopy: true,
      showCopyInStandardFooter: true,
    })).toEqual({
      showStandardActions: true,
      showCopy: true,
      isCopyDisabled: false,
      showRecovery: false,
    });
  });

  test('preserves a disabled standard copy action when its caller normally shows it', () => {
    expect(getPublishingRecoveryFooterActions({
      showRecovery: false,
      canCopy: false,
      showCopyInStandardFooter: true,
    })).toEqual({
      showStandardActions: true,
      showCopy: true,
      isCopyDisabled: true,
      showRecovery: false,
    });
  });

  test('does not add copy to a standard footer when its existing rule hides it', () => {
    expect(getPublishingRecoveryFooterActions({
      showRecovery: false,
      canCopy: false,
      showCopyInStandardFooter: false,
    })).toEqual({
      showStandardActions: true,
      showCopy: false,
      isCopyDisabled: true,
      showRecovery: false,
    });
  });
});
