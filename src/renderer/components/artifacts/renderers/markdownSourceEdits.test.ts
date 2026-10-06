import { ChangeSet } from '@codemirror/state';
import { expect, test } from 'vitest';

import { applyMarkdownSourceChanges, normalizeMarkdownLineEndings } from './markdownSourceEdits';

test('edits source without rewriting metadata, comments, tables, or mixed line endings', () => {
  const original = '\uFEFF---\r\ntitle: 测试\r\n---\r\n# Title\n\n| A | B |\r\n|---|---|\r\n\n<!-- keep -->\r\n';
  const normalized = normalizeMarkdownLineEndings(original);
  const from = normalized.indexOf('Title');
  const changes = ChangeSet.of({ from, to: from + 5, insert: '正文\n新段落' }, normalized.length);
  expect(applyMarkdownSourceChanges(original, changes)).toBe(original.replace('Title', '正文\r\n新段落'));
});

test('handles multiple edits, deletion across lines, Unicode, and an empty file', () => {
  const original = '你好\r\n🌈abc\r\nend';
  const normalized = normalizeMarkdownLineEndings(original);
  const changes = ChangeSet.of([{ from: 0, to: 3, insert: '' }, { from: 8, to: 12, insert: '\n末尾' }], normalized.length);
  expect(applyMarkdownSourceChanges(original, changes)).toBe('🌈abc\r\n末尾');
  expect(applyMarkdownSourceChanges('', ChangeSet.of({ from: 0, insert: '# 新文件\n' }, 0))).toBe('# 新文件\n');
  expect(applyMarkdownSourceChanges(original, ChangeSet.of({ from: 0, to: normalized.length }, normalized.length))).toBe('');
});
