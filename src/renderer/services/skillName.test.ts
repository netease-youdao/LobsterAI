import { describe, expect, test } from 'vitest';

import { prettifySkillName } from './skill';

describe('prettifySkillName', () => {
  test('turns kebab-case ids into title case', () => {
    expect(prettifySkillName('canvas-design')).toBe('Canvas Design');
    expect(prettifySkillName('web_search')).toBe('Web Search');
    expect(prettifySkillName('a.b.c')).toBe('A B C');
  });

  test('capitalizes a single word', () => {
    expect(prettifySkillName('weather')).toBe('Weather');
  });

  test('keeps known acronyms uppercase', () => {
    expect(prettifySkillName('hr-recruitment')).toBe('HR Recruitment');
    expect(prettifySkillName('ai-seo')).toBe('AI SEO');
    expect(prettifySkillName('pdf')).toBe('PDF');
  });

  test('leaves names that already read as titles untouched', () => {
    expect(prettifySkillName('Stock Analyzer')).toBe('Stock Analyzer');
  });

  test('leaves non-ASCII names untouched', () => {
    expect(prettifySkillName('股票分析')).toBe('股票分析');
    expect(prettifySkillName('画布-设计')).toBe('画布-设计');
  });

  test('collapses repeated separators instead of emitting blanks', () => {
    expect(prettifySkillName('a--b')).toBe('A B');
  });

  test('handles empty and whitespace-only input', () => {
    expect(prettifySkillName('')).toBe('');
    expect(prettifySkillName('   ')).toBe('');
  });
});
