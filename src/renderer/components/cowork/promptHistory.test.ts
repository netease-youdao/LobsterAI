import { describe, expect, test } from 'vitest';

import type { CoworkMessage } from '../../types/cowork';
import {
  collectPromptHistoryEntries,
  type PromptHistoryBrowse,
  PromptHistoryDirection,
  resolvePromptHistoryStep,
} from './promptHistory';

const message = (type: CoworkMessage['type'], content: string, id = content): CoworkMessage => ({
  id,
  type,
  content,
  timestamp: 0,
});

const step = (
  direction: PromptHistoryDirection,
  value: string,
  browse: PromptHistoryBrowse | null,
  entries: string[] = ['third', 'second', 'first'],
  caret = value.length,
) => resolvePromptHistoryStep({
  direction,
  draftKey: 'session-1',
  value,
  selectionStart: caret,
  selectionEnd: caret,
  browse,
  loadEntries: () => entries,
});

describe('collectPromptHistoryEntries', () => {
  test('lists user prompts newest first and skips other messages', () => {
    const entries = collectPromptHistoryEntries([
      message('user', 'first'),
      message('assistant', 'answer'),
      message('user', 'second'),
      message('tool_use', 'tool'),
      message('user', 'third'),
    ]);
    expect(entries).toEqual(['third', 'second', 'first']);
  });

  test('drops blanks and back-to-back repeats but keeps repeats further apart', () => {
    const entries = collectPromptHistoryEntries([
      message('user', 'retry', 'a'),
      message('user', 'other', 'b'),
      message('user', 'retry', 'c'),
      message('user', 'retry', 'd'),
      message('user', '   ', 'e'),
    ]);
    expect(entries).toEqual(['retry', 'other', 'retry']);
  });

  test('recalls only the typed text, not the attachment lines the composer appended', () => {
    const [entry] = collectPromptHistoryEntries([
      message('user', 'Summarize this\n\n输入文件: /tmp/report.pdf'),
    ]);
    expect(entry).toBe('Summarize this');
  });

  test('stops at the limit', () => {
    const messages = Array.from({ length: 5 }, (_, index) => message('user', `prompt ${index}`));
    expect(collectPromptHistoryEntries(messages, 2)).toEqual(['prompt 4', 'prompt 3']);
  });
});

describe('resolvePromptHistoryStep', () => {
  test('Up in an empty composer recalls the newest prompt', () => {
    const result = step(PromptHistoryDirection.Older, '', null);
    expect(result?.value).toBe('third');
    expect(result?.browse).toMatchObject({ index: 0, draft: '' });
  });

  test('Up never replaces a typed draft', () => {
    expect(step(PromptHistoryDirection.Older, 'my draft', null)).toBeNull();
  });

  test('Up with no sent prompts keeps the normal key behavior', () => {
    expect(step(PromptHistoryDirection.Older, '', null, [])).toBeNull();
  });

  test('repeated Up walks to older prompts and stops at the oldest', () => {
    const first = step(PromptHistoryDirection.Older, '', null)!;
    const second = step(PromptHistoryDirection.Older, first.value, first.browse)!;
    const third = step(PromptHistoryDirection.Older, second.value, second.browse)!;
    expect([first.value, second.value, third.value]).toEqual(['third', 'second', 'first']);
    expect(step(PromptHistoryDirection.Older, third.value, third.browse)).toBeNull();
  });

  test('Down walks back to newer prompts and then to the draft', () => {
    const browse: PromptHistoryBrowse = {
      draftKey: 'session-1',
      entries: ['third', 'second', 'first'],
      index: 1,
      draft: '',
    };
    const newer = step(PromptHistoryDirection.Newer, 'second', browse)!;
    expect(newer.value).toBe('third');
    const draft = step(PromptHistoryDirection.Newer, newer.value, newer.browse)!;
    expect(draft).toEqual({ value: '', browse: null });
  });

  test('Down outside a browse keeps the normal key behavior', () => {
    expect(step(PromptHistoryDirection.Newer, '', null)).toBeNull();
  });

  test('editing a recalled prompt ends the browse', () => {
    const browse: PromptHistoryBrowse = { draftKey: 'session-1', entries: ['third', 'second'], index: 0, draft: '' };
    expect(step(PromptHistoryDirection.Older, 'third, but changed', browse)).toBeNull();
    expect(step(PromptHistoryDirection.Newer, 'third, but changed', browse)).toBeNull();
  });

  test('a browse from another session does not carry over', () => {
    const browse: PromptHistoryBrowse = { draftKey: 'session-2', entries: ['third'], index: 0, draft: '' };
    expect(step(PromptHistoryDirection.Newer, 'third', browse)).toBeNull();
  });

  test('multi-line prompts move the caret between lines before changing prompt', () => {
    const browse: PromptHistoryBrowse = {
      draftKey: 'session-1',
      entries: ['line 1\nline 2', 'older'],
      index: 0,
      draft: '',
    };
    const value = 'line 1\nline 2';
    // Caret on the last line: Up moves the caret, Down goes to the draft.
    expect(step(PromptHistoryDirection.Older, value, browse, browse.entries, value.length)).toBeNull();
    expect(step(PromptHistoryDirection.Newer, value, browse, browse.entries, value.length)?.browse).toBeNull();
    // Caret on the first line: Up goes to the older prompt, Down moves the caret.
    expect(step(PromptHistoryDirection.Older, value, browse, browse.entries, 3)?.value).toBe('older');
    expect(step(PromptHistoryDirection.Newer, value, browse, browse.entries, 3)).toBeNull();
  });

  test('a text selection keeps the normal key behavior', () => {
    expect(resolvePromptHistoryStep({
      direction: PromptHistoryDirection.Older,
      draftKey: 'session-1',
      value: '',
      selectionStart: 0,
      selectionEnd: 0,
      browse: null,
      loadEntries: () => [],
    })).toBeNull();
    const browse: PromptHistoryBrowse = { draftKey: 'session-1', entries: ['third', 'second'], index: 0, draft: '' };
    expect(resolvePromptHistoryStep({
      direction: PromptHistoryDirection.Older,
      draftKey: 'session-1',
      value: 'third',
      selectionStart: 0,
      selectionEnd: 5,
      browse,
      loadEntries: () => browse.entries,
    })).toBeNull();
  });
});
