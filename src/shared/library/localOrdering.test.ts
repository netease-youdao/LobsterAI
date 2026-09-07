import { describe, expect, test } from 'vitest';

import { LibraryLimits } from './constants';
import {
  compareLibraryBinaryStrings,
  compareLibraryLocalOrderKeys,
  isLibraryIdentifier,
  isLibraryLocalOrderKey,
  isLibraryTimestamp,
  type LibraryLocalOrderKey,
} from './localOrdering';

const key: LibraryLocalOrderKey = {
  sessionUpdatedAt: 1_788_470_400_000.5,
  sessionCreatedAt: 1_788_460_000_000.25,
  sessionId: 'session',
  artifactSortTime: 100.75,
  itemId: 'item',
};

describe('local library order contract', () => {
  test('preserves fractional, zero, negative and Date boundary timestamps', () => {
    for (const value of [key.sessionUpdatedAt, 0, -0.5, -8_640_000_000_000_000, 8_640_000_000_000_000]) {
      expect(isLibraryTimestamp(value)).toBe(true);
    }
    for (const value of [NaN, Infinity, -Infinity, 8_640_000_000_000_001, '100', null, undefined]) {
      expect(isLibraryTimestamp(value)).toBe(false);
    }
  });

  test('accepts bounded non-ASCII identifiers without changing their bytes', () => {
    expect(isLibraryIdentifier(' 会话 ')).toBe(true);
    expect(isLibraryIdentifier('文'.repeat(LibraryLimits.MaxIdentifierLength))).toBe(true);
    for (const value of ['', '  ', 'a'.repeat(LibraryLimits.MaxIdentifierLength + 1), 1]) {
      expect(isLibraryIdentifier(value)).toBe(false);
    }
  });

  test('uses UTF-8 BINARY order instead of UTF-16 or locale collation', () => {
    // JS UTF-16 places supplementary characters before private-use BMP characters.
    expect('𐀀' < '\uE000').toBe(true);
    expect(compareLibraryBinaryStrings('𐀀', '\uE000')).toBeGreaterThan(0);
    const values = ['a', 'aa', 'B', '中', '𐀀', '\uE000', 'é'];
    expect([...values].sort(compareLibraryBinaryStrings)).toEqual(
      [...values].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
    );
  });

  test('uses every descending tie-break without allowing file time to split a task', () => {
    expect(compareLibraryLocalOrderKeys(key, key)).toBe(0);
    for (const changed of [
      { sessionUpdatedAt: key.sessionUpdatedAt + 0.25 },
      { sessionCreatedAt: key.sessionCreatedAt + 0.25 },
      { sessionId: 'z', artifactSortTime: -100 },
      { artifactSortTime: 101 },
      { itemId: 'z' },
    ]) {
      const newer = { ...key, ...changed };
      expect(compareLibraryLocalOrderKeys(newer, key)).toBeLessThan(0);
      expect(compareLibraryLocalOrderKeys(key, newer)).toBeGreaterThan(0);
    }
    expect(isLibraryLocalOrderKey({ ...key, sessionUpdatedAt: '100' })).toBe(false);
    expect(isLibraryLocalOrderKey(key)).toBe(true);
  });
});
