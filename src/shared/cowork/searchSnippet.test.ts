import { describe, expect, test } from 'vitest';

import { buildSearchSnippet } from './searchSnippet';

describe('buildSearchSnippet', () => {
  test('highlights a hit near the start without a leading ellipsis', () => {
    const result = buildSearchSnippet('保持其他不变，去掉左臂部分的拉链', '拉链');
    expect(result.snippet).toBe('保持其他不变，去掉左臂部分的拉链');
    expect(result.snippet.slice(result.highlightStart, result.highlightStart + result.highlightLength))
      .toBe('拉链');
  });

  test('trims long content around the hit and marks both cuts', () => {
    const content = `${'a'.repeat(200)}needle${'b'.repeat(200)}`;
    const result = buildSearchSnippet(content, 'needle', { contextBefore: 10, maxLength: 40 });
    expect(result.snippet.startsWith('…')).toBe(true);
    expect(result.snippet.endsWith('…')).toBe(true);
    expect(result.snippet.slice(result.highlightStart, result.highlightStart + 6)).toBe('needle');
  });

  test('matches case-insensitively and collapses whitespace and newlines', () => {
    const result = buildSearchSnippet('First line\n\n  Hello   World again', 'hello world');
    expect(result.snippet).toBe('First line Hello World again');
    expect(result.snippet.slice(result.highlightStart, result.highlightStart + result.highlightLength))
      .toBe('Hello World');
  });

  test('drops Markdown syntax so the excerpt reads as plain text', () => {
    const content = [
      '## 两种方式',
      '- 点名具有最高优先级，我会跳过自动匹配。',
      '**② 项目级约束**（推荐，一次配置长期生效）往 `test-usage` 写入',
      '详见 [配置文档](https://example.com/docs)',
    ].join('\n');
    const result = buildSearchSnippet(content, '项目级约束', { contextBefore: 12, maxLength: 60 });
    expect(result.snippet).not.toMatch(/\*\*|`|##|\]\(/);
    expect(result.snippet).toContain('② 项目级约束（推荐');
    expect(result.snippet.slice(result.highlightStart, result.highlightStart + result.highlightLength))
      .toBe('项目级约束');
  });

  test('keeps link text and finds a query typed with Markdown marks', () => {
    const result = buildSearchSnippet('详见 [配置文档](https://example.com/docs) 第二节', '`配置文档`');
    expect(result.snippet).toBe('详见 配置文档 第二节');
    expect(result.snippet.slice(result.highlightStart, result.highlightStart + result.highlightLength))
      .toBe('配置文档');
  });

  test('falls back to the start of the content when the hit cannot be located', () => {
    const result = buildSearchSnippet('x'.repeat(300), 'missing', { maxLength: 20 });
    expect(result.snippet).toBe(`${'x'.repeat(20)}…`);
    expect(result.highlightStart).toBe(-1);
  });

  test('never splits a surrogate pair at the cut points', () => {
    const content = `${'😀'.repeat(30)}target${'😀'.repeat(30)}`;
    const result = buildSearchSnippet(content, 'target', { contextBefore: 5, maxLength: 17 });
    expect(result.snippet).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(result.snippet).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(result.snippet.slice(result.highlightStart, result.highlightStart + 6)).toBe('target');
  });
});
