import { expect, test } from 'vitest';

import { buildSessionTitleFromInput, SESSION_TITLE_MAX_CHARS, stripGoalCommandPrefixForDisplay } from './sessionTitle';

test('builds title from the first characters of text input', () => {
  expect(buildSessionTitleFromInput('请帮我修复登录失败的问题', '新对话')).toBe('请帮我修复登录失败的问题');
});

test('collapses whitespace before taking the title prefix', () => {
  expect(buildSessionTitleFromInput('\n  第一行\n第二行  ', '新对话')).toBe('第一行 第二行');
});

test('uses the localized default title for image-only input', () => {
  expect(buildSessionTitleFromInput('   ', '新对话')).toBe('新对话');
});

test('strips goal command prefixes from generated titles', () => {
  expect(buildSessionTitleFromInput('/goal start 帮我做一个烘焙工作室网页', '新对话')).toBe('帮我做一个烘焙工作室网页');
  expect(buildSessionTitleFromInput('/goal set Ship the landing page', 'New Chat')).toBe('Ship the landing page');
});

test('preserves non-start goal commands for display', () => {
  expect(stripGoalCommandPrefixForDisplay('/goal status')).toBe('/goal status');
});

test('caps generated titles to the maximum length', () => {
  const input = 'a'.repeat(SESSION_TITLE_MAX_CHARS + 10);
  expect(buildSessionTitleFromInput(input, 'New Chat')).toBe('a'.repeat(SESSION_TITLE_MAX_CHARS));
});
