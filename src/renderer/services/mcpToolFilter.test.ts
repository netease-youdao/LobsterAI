import { describe, expect, test } from 'vitest';

import {
  buildMcpToolFilterFromText,
  formatMcpToolNameList,
  parseMcpToolNameList,
} from './mcpToolFilter';

describe('mcpToolFilter', () => {
  test('parses newline or comma separated names, trimming and de-duplicating', () => {
    expect(parseMcpToolNameList(' search \nread_*, write\n\n,search')).toEqual([
      'search',
      'read_*',
      'write',
    ]);
    expect(parseMcpToolNameList('  \n , ')).toEqual([]);
  });

  test('formats names one per line for editing', () => {
    expect(formatMcpToolNameList(['a', 'b*'])).toBe('a\nb*');
    expect(formatMcpToolNameList(undefined)).toBe('');
  });

  test('always returns both lists so clearing the text clears the stored filter', () => {
    expect(buildMcpToolFilterFromText('a\nb', '')).toEqual({ include: ['a', 'b'], exclude: [] });
    expect(buildMcpToolFilterFromText('', '')).toEqual({ include: [], exclude: [] });
  });
});
