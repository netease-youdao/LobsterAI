import { describe, expect, test } from 'vitest';

import { stripNullChars } from './text';

const nul = String.fromCharCode(0);

describe('stripNullChars', () => {
  test('removes every NUL character', () => {
    expect(stripNullChars(`a${nul}b${nul}${nul}c`)).toBe('abc');
  });

  test('returns clean strings unchanged', () => {
    const value = 'line1\nline2\ttab 中文';
    expect(stripNullChars(value)).toBe(value);
  });

  test('keeps other control and whitespace characters', () => {
    expect(stripNullChars(`\r\n\t ${nul}`)).toBe('\r\n\t ');
  });

  test('handles the empty string', () => {
    expect(stripNullChars('')).toBe('');
  });
});
