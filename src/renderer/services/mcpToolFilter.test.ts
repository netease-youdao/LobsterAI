import { describe, expect, test } from 'vitest';

import {
  buildMcpPickerFilter,
  buildMcpToolFilterFromText,
  compactMcpToolFilter,
  findUnmatchedMcpToolFilterEntries,
  formatMcpToolNameList,
  isMcpToolAllowed,
  isPlainExcludeFilter,
  matchesMcpToolPattern,
  McpToolFilterSummaryKind,
  parseMcpToolNameList,
  removeMcpToolFilterEntries,
  summarizeMcpToolFilter,
} from './mcpToolFilter';

const TOOLS = ['search_issues', 'create_issue', 'delete_repo', 'get_me'];

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

  test('compacts empty lists away', () => {
    expect(compactMcpToolFilter({ include: [], exclude: [] })).toBeUndefined();
    expect(compactMcpToolFilter({ include: [], exclude: ['a'] })).toEqual({ exclude: ['a'] });
    expect(compactMcpToolFilter(undefined)).toBeUndefined();
  });
});

describe('matching, same rules as OpenClaw', () => {
  test('matches exact names and * globs anywhere in the pattern', () => {
    expect(matchesMcpToolPattern('get_me', 'get_me')).toBe(true);
    expect(matchesMcpToolPattern('get_me', 'get_me_2')).toBe(false);
    expect(matchesMcpToolPattern('search_*', 'search_issues')).toBe(true);
    expect(matchesMcpToolPattern('*_issue', 'create_issue')).toBe(true);
    expect(matchesMcpToolPattern('*issue*', 'search_issues')).toBe(true);
    expect(matchesMcpToolPattern('s*_*s', 'search_issues')).toBe(true);
    expect(matchesMcpToolPattern('ab*ba', 'aba')).toBe(false);
    expect(matchesMcpToolPattern('*', 'anything')).toBe(true);
    expect(matchesMcpToolPattern('  ', 'anything')).toBe(false);
  });

  test('applies include first, then exclude', () => {
    const filter = { include: ['search_*', 'create_issue'], exclude: ['search_issues'] };
    expect(TOOLS.filter(name => isMcpToolAllowed(filter, name))).toEqual(['create_issue']);
    expect(TOOLS.filter(name => isMcpToolAllowed(undefined, name))).toEqual(TOOLS);
    expect(TOOLS.filter(name => isMcpToolAllowed({ include: [], exclude: [] }, name))).toEqual(TOOLS);
  });

  test('a mistyped include entry hides every tool', () => {
    expect(TOOLS.some(name => isMcpToolAllowed({ include: ['search issues'] }, name))).toBe(false);
  });
});

describe('tool picker', () => {
  test('stores the unchecked tools as exact names', () => {
    const enabled = new Set(['search_issues', 'get_me']);
    expect(buildMcpPickerFilter(undefined, TOOLS, enabled)).toEqual({
      exclude: ['create_issue', 'delete_repo'],
    });
    expect(buildMcpPickerFilter({ exclude: ['delete_repo'] }, TOOLS, new Set(TOOLS))).toBeUndefined();
  });

  test('turns include lists and globs into exact names for the listed tools', () => {
    const filter = { include: ['search_*', 'get_me'], exclude: ['*_repo'] };
    const enabled = new Set(TOOLS.filter(name => isMcpToolAllowed(filter, name)));
    enabled.add('create_issue');

    expect(buildMcpPickerFilter(filter, TOOLS, enabled)).toEqual({ exclude: ['delete_repo'] });
  });

  test('keeps hidden names the server did not list this time', () => {
    expect(buildMcpPickerFilter(
      { exclude: ['admin_tool', 'old_*'] },
      TOOLS,
      new Set(TOOLS.filter(name => name !== 'get_me')),
    )).toEqual({ exclude: ['get_me', 'admin_tool'] });
  });

  test('recognises the plain hidden-names shape the picker writes', () => {
    expect(isPlainExcludeFilter(undefined)).toBe(true);
    expect(isPlainExcludeFilter({ exclude: ['a', 'b'] })).toBe(true);
    expect(isPlainExcludeFilter({ exclude: ['a*'] })).toBe(false);
    expect(isPlainExcludeFilter({ include: ['a'] })).toBe(false);
  });

  test('finds entries that match no listed tool and removes them', () => {
    const filter = { include: ['search issues', 'search_*'], exclude: ['renamed_tool', 'get_me'] };
    expect(findUnmatchedMcpToolFilterEntries(filter, TOOLS)).toEqual(['search issues', 'renamed_tool']);
    expect(removeMcpToolFilterEntries(filter, ['search issues', 'renamed_tool'])).toEqual({
      include: ['search_*'],
      exclude: ['get_me'],
    });
    expect(removeMcpToolFilterEntries({ include: ['typo'] }, ['typo'])).toBeUndefined();
  });
});

describe('summarizeMcpToolFilter', () => {
  test('describes the filter without a tool list', () => {
    expect(summarizeMcpToolFilter(undefined)).toEqual({ kind: McpToolFilterSummaryKind.All, count: 0 });
    expect(summarizeMcpToolFilter({ exclude: ['a', 'b'] })).toEqual({ kind: McpToolFilterSummaryKind.Hidden, count: 2 });
    expect(summarizeMcpToolFilter({ include: ['a'] })).toEqual({ kind: McpToolFilterSummaryKind.Only, count: 1 });
    expect(summarizeMcpToolFilter({ include: ['a'], exclude: ['b'] }).kind).toBe(McpToolFilterSummaryKind.Custom);
    expect(summarizeMcpToolFilter({ exclude: ['a*'] }).kind).toBe(McpToolFilterSummaryKind.Custom);
  });
});
