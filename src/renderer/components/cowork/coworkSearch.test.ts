import { describe, expect, test } from 'vitest';
import { getSnippet } from './CoworkSearchModal';

// ---------------------------------------------------------------------------
// getSnippet
// ---------------------------------------------------------------------------
describe('getSnippet', () => {
  test('returns beginning slice when no term matches', () => {
    const text = 'a'.repeat(200);
    expect(getSnippet(text, ['xyz'])).toBe('a'.repeat(120));
  });

  test('returns full text when short and term present', () => {
    expect(getSnippet('hello world', ['world'])).toBe('hello world');
  });

  test('snippet always contains the matched term', () => {
    const text = 'a'.repeat(150) + ' knowledge base ' + 'b'.repeat(150);
    const result = getSnippet(text, ['knowledge base']);
    expect(result).toContain('knowledge base');
  });

  test('adds leading ellipsis when keyword is not near start', () => {
    const text = 'x'.repeat(100) + ' keyword ' + 'y'.repeat(100);
    const result = getSnippet(text, ['keyword']);
    expect(result.startsWith('…')).toBe(true);
  });

  test('adds trailing ellipsis when there is more text after window', () => {
    const text = 'keyword ' + 'y'.repeat(200);
    const result = getSnippet(text, ['keyword']);
    expect(result.endsWith('…')).toBe(true);
  });

  test('is case-insensitive', () => {
    const result = getSnippet('Contains YARN logs here', ['yarn']);
    expect(result).toContain('YARN');
  });

  test('picks earliest term when multiple terms given', () => {
    const text = 'first beta then alpha later';
    const result = getSnippet(text, ['alpha', 'beta']);
    expect(result.indexOf('beta')).toBeLessThan(result.indexOf('alpha'));
  });

  test('ignores blank terms', () => {
    const result = getSnippet('find this here', ['', '  ', 'find']);
    expect(result).toContain('find');
  });

  test('returns empty string for empty text', () => {
    expect(getSnippet('', ['keyword'])).toBe('');
  });

  test('respects custom maxLen fallback when no term matches', () => {
    const result = getSnippet('abcdefghij', ['xyz'], 5);
    expect(result).toBe('abcde');
  });
});

// ---------------------------------------------------------------------------
// HighlightText — test the split/match logic without DOM rendering
// ---------------------------------------------------------------------------

/**
 * Pure helper that replicates HighlightText's splitting logic so we can test
 * it without a DOM environment (vitest is configured with environment: 'node').
 */
function splitByKeywords(text: string, keywords: string[]): string[] {
  const activeTerms = keywords.filter((t) => t.trim());
  if (!text || activeTerms.length === 0) return [text];
  const sorted = [...activeTerms].sort((a, b) => b.length - a.length);
  const pattern = sorted.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return text.split(new RegExp(`(${pattern})`, 'gi'));
}

describe('HighlightText split logic', () => {
  test('returns original text as single part when no keyword given', () => {
    expect(splitByKeywords('hello world', [])).toEqual(['hello world']);
  });

  test('splits text into parts around the matched keyword', () => {
    const parts = splitByKeywords('hello world', ['world']);
    expect(parts).toContain('world');
    expect(parts).toContain('hello ');
  });

  test('splits all occurrences of the keyword', () => {
    const parts = splitByKeywords('cat and cat', ['cat']);
    expect(parts.filter((p) => p.toLowerCase() === 'cat').length).toBe(2);
  });

  test('is case-insensitive — matched part preserves original case', () => {
    const parts = splitByKeywords('Contains YARN logs', ['yarn']);
    expect(parts).toContain('YARN');
  });

  test('longest term wins over sub-term (longest-first regex)', () => {
    const parts = splitByKeywords('knowledge base system', ['knowledge base', 'knowledge']);
    // 'knowledge base' should be matched as a single token, not split into 'knowledge' + ' base'
    expect(parts).toContain('knowledge base');
    expect(parts).not.toContain('knowledge');
  });

  test('handles multi-word terms: auth flow matched before auth alone', () => {
    const parts = splitByKeywords('auth flow is key', ['auth flow', 'auth', 'flow']);
    expect(parts).toContain('auth flow');
    // 'auth' and 'flow' should not appear as separate matched tokens
    expect(parts.filter((p) => p.toLowerCase() === 'auth').length).toBe(0);
  });

  test('returns original text when keyword is empty string', () => {
    expect(splitByKeywords('hello', [''])).toEqual(['hello']);
  });
});
