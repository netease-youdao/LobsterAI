import { describe, expect, test } from 'vitest';
import { extractSnippet } from './coworkStore';

describe('extractSnippet', () => {
  test('returns empty string for empty content', () => {
    expect(extractSnippet('', ['keyword'])).toBe('');
  });

  test('returns beginning of content when no term matches', () => {
    const content = 'a'.repeat(300);
    const result = extractSnippet(content, ['xyz']);
    expect(result).toBe('a'.repeat(200));
  });

  test('returns full content when it is short and term is present', () => {
    const content = 'hello world';
    expect(extractSnippet(content, ['world'])).toBe('hello world');
  });

  test('includes keyword when it appears at the start', () => {
    const content = 'keyword ' + 'x'.repeat(200);
    const result = extractSnippet(content, ['keyword']);
    expect(result).toContain('keyword');
    expect(result.startsWith('keyword')).toBe(true);
  });

  test('includes keyword when it appears at the end', () => {
    const content = 'x'.repeat(200) + ' keyword';
    const result = extractSnippet(content, ['keyword']);
    expect(result).toContain('keyword');
  });

  test('includes keyword when it appears in the middle of long content', () => {
    const prefix = 'a'.repeat(200);
    const suffix = 'b'.repeat(200);
    const content = `${prefix} keyword ${suffix}`;
    const result = extractSnippet(content, ['keyword']);
    expect(result).toContain('keyword');
  });

  test('adds ellipsis prefix when snippet does not start at beginning', () => {
    const content = 'a'.repeat(200) + ' keyword';
    const result = extractSnippet(content, ['keyword']);
    expect(result.startsWith('…')).toBe(true);
  });

  test('adds ellipsis suffix when snippet does not reach the end', () => {
    const content = 'keyword ' + 'b'.repeat(200);
    const result = extractSnippet(content, ['keyword']);
    expect(result.endsWith('…')).toBe(true);
  });

  test('is case-insensitive', () => {
    const content = 'This contains KEYWORD in uppercase';
    const result = extractSnippet(content, ['keyword']);
    expect(result).toContain('KEYWORD');
  });

  test('picks the earliest-appearing term among multiple terms', () => {
    // 'beta' appears before 'alpha' in the text
    const content = 'intro beta stuff alpha end';
    const result = extractSnippet(content, ['alpha', 'beta']);
    // snippet should be centred around 'beta' since it appears first
    expect(result.indexOf('beta')).toBeLessThan(result.indexOf('alpha'));
  });

  test('handles multi-word term correctly', () => {
    const content = 'a'.repeat(100) + ' auth flow ' + 'b'.repeat(100);
    const result = extractSnippet(content, ['auth flow', 'auth', 'flow']);
    expect(result).toContain('auth flow');
  });

  test('normalises multiple whitespace in content', () => {
    const content = 'hello   \n\t   keyword   world';
    const result = extractSnippet(content, ['keyword']);
    expect(result).toContain('keyword');
    expect(result).not.toMatch(/\s{2,}/);
  });

  test('returns fallback slice when terms array is empty', () => {
    const content = 'some content here';
    expect(extractSnippet(content, [])).toBe('some content here');
  });

  test('ignores blank terms in the array', () => {
    const content = 'find me here';
    const result = extractSnippet(content, ['', '  ', 'find']);
    expect(result).toContain('find');
  });
});
