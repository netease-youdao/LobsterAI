import { describe, expect, test, vi } from 'vitest';
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

// ---------------------------------------------------------------------------
// countQueryInText — turn-level match counter used for highlight ring
// ---------------------------------------------------------------------------
import { countQueryInText } from './CoworkSessionDetail';

describe('countQueryInText', () => {
  test('returns 0 for empty query', () => {
    expect(countQueryInText('hello world', '')).toBe(0);
  });

  test('returns 0 when query not found', () => {
    expect(countQueryInText('hello world', 'xyz')).toBe(0);
  });

  test('counts single occurrence', () => {
    expect(countQueryInText('hello world', 'world')).toBe(1);
  });

  test('counts multiple non-overlapping occurrences', () => {
    expect(countQueryInText('cat and cat and cat', 'cat')).toBe(3);
  });

  test('is case-insensitive', () => {
    expect(countQueryInText('YARN yarn Yarn', 'yarn')).toBe(3);
  });

  test('handles Chinese characters', () => {
    expect(countQueryInText('阿里云 腾讯云 阿里云', '阿里云')).toBe(2);
  });

  test('does not double-count overlapping matches', () => {
    // 'aa' in 'aaa' should match twice: pos 0 and pos 1
    // but our impl advances by q.length so only pos 0 counts → 1 match
    expect(countQueryInText('aaa', 'aa')).toBe(1);
  });

  test('returns 0 for empty text', () => {
    expect(countQueryInText('', 'keyword')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// scrollToMatchNode — boundary guards (DOM-free subset)
// ---------------------------------------------------------------------------
import { scrollToMatchNode } from './CoworkSessionDetail';

describe('scrollToMatchNode boundary guards', () => {
  /** Build a minimal Text node stub for testing boundary logic. */
  function makeTextNode(content: string): Text {
    return { textContent: content } as unknown as Text;
  }

  test('does nothing when container is null', () => {
    // Should not throw
    expect(() =>
      scrollToMatchNode({ node: makeTextNode('hello'), start: 0 }, 5, null)
    ).not.toThrow();
  });

  test('does nothing when queryLen is 0', () => {
    const scrollTo = vi.fn();
    const container = { scrollTo, scrollTop: 0, getBoundingClientRect: () => ({ top: 0 }) } as unknown as HTMLDivElement;
    scrollToMatchNode({ node: makeTextNode('hello'), start: 0 }, 0, container);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  test('does nothing when start + queryLen exceeds node length (stale node guard)', () => {
    // node has 5 chars, but we claim offset 3 with len 5 → 3+5=8 > 5, should skip
    const scrollTo = vi.fn();
    const container = { scrollTo, scrollTop: 0, getBoundingClientRect: () => ({ top: 0 }) } as unknown as HTMLDivElement;
    scrollToMatchNode({ node: makeTextNode('hello'), start: 3 }, 5, container);
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
