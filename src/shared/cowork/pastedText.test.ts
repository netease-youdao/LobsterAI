import { describe, expect, test } from 'vitest';

import {
  countPastedTextLines,
  COWORK_PASTED_TEXT_MIN_CHARS,
  COWORK_PASTED_TEXT_MIN_LINES,
  COWORK_PASTED_TEXT_PATH_PREFIX,
  createPastedTextAttachment,
  expandPastedTextBlocks,
  extractPastedTextBlocks,
  formatPastedTextAttachmentBlocks,
  formatPastedTextBlock,
  getPastedTextPreview,
  getPastedTextSnippet,
  isPastedTextAttachment,
  shouldPasteAsTextCard,
} from './pastedText';

const lines = (count: number): string => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n');

describe('shouldPasteAsTextCard', () => {
  test('keeps short pastes inline', () => {
    expect(shouldPasteAsTextCard('hello world')).toBe(false);
    expect(shouldPasteAsTextCard(lines(COWORK_PASTED_TEXT_MIN_LINES - 1))).toBe(false);
    expect(shouldPasteAsTextCard('   \n\n  ')).toBe(false);
  });

  test('turns long or many-line pastes into cards', () => {
    expect(shouldPasteAsTextCard(lines(COWORK_PASTED_TEXT_MIN_LINES))).toBe(true);
    expect(shouldPasteAsTextCard('x'.repeat(COWORK_PASTED_TEXT_MIN_CHARS))).toBe(true);
  });

  test('counts Windows line endings once', () => {
    expect(countPastedTextLines('a\r\nb\r\nc\r\n')).toBe(3);
    expect(shouldPasteAsTextCard(lines(COWORK_PASTED_TEXT_MIN_LINES).replace(/\n/g, '\r\n'))).toBe(true);
  });
});

describe('pasted text attachments', () => {
  test('creates an attachment named after the first non-empty line', () => {
    const attachment = createPastedTextAttachment('\r\n  Error: boom  \r\nat main()', 'abc123');
    expect(attachment).toEqual({
      path: `${COWORK_PASTED_TEXT_PATH_PREFIX}abc123`,
      name: 'Error: boom',
      pastedText: '\n  Error: boom  \nat main()',
    });
    expect(isPastedTextAttachment(attachment)).toBe(true);
    expect(isPastedTextAttachment({ path: '/tmp/a.txt', name: 'a.txt' })).toBe(false);
  });

  test('shortens long previews', () => {
    expect(getPastedTextPreview('a'.repeat(100))).toBe(`${'a'.repeat(80)}…`);
  });

  test('collapses whitespace in card snippets', () => {
    expect(getPastedTextSnippet('  FisherAI\n\n  Archive\tSearch\r\n')).toBe('FisherAI Archive Search');
    expect(getPastedTextSnippet('字'.repeat(500), 10)).toBe('字'.repeat(10));
  });

  test('formats only pasted attachments, in order', () => {
    expect(formatPastedTextAttachmentBlocks([
      { path: '/tmp/a.txt', name: 'a.txt' },
      createPastedTextAttachment('first', 'one'),
      createPastedTextAttachment('second', 'two'),
    ])).toEqual([
      '<pasted_text id="one">\nfirst\n</pasted_text id="one">',
      '<pasted_text id="two">\nsecond\n</pasted_text id="two">',
    ]);
  });
});

describe('extractPastedTextBlocks', () => {
  test('leaves messages without blocks untouched', () => {
    expect(extractPastedTextBlocks('plain\n\n\n\ntext')).toEqual({ text: 'plain\n\n\n\ntext', blocks: [] });
  });

  test('splits blocks out of the typed prompt and attachment lines', () => {
    const content = [
      'Why does this fail?',
      formatPastedTextBlock({ id: 'p1', text: 'stack\n\n\n\ntrace\n' }),
      'Input Files: /tmp/a.log',
    ].join('\n\n');
    expect(extractPastedTextBlocks(content)).toEqual({
      text: 'Why does this fail?\n\nInput Files: /tmp/a.log',
      blocks: [{ id: 'p1', text: 'stack\n\n\n\ntrace\n' }],
    });
  });

  test('keeps a nested block inside the outer pasted text', () => {
    const inner = formatPastedTextBlock({ id: 'inner', text: 'old paste' });
    const content = formatPastedTextBlock({ id: 'outer', text: `copied message\n${inner}` });
    expect(extractPastedTextBlocks(content).blocks).toEqual([
      { id: 'outer', text: `copied message\n${inner}` },
    ]);
  });

  test('ignores a block whose closing id does not match', () => {
    const content = '<pasted_text id="a">\ntext\n</pasted_text id="b">';
    expect(extractPastedTextBlocks(content)).toEqual({ text: content, blocks: [] });
  });

  test('accepts blocks stored with Windows line endings', () => {
    const content = 'look\r\n\r\n<pasted_text id="w">\r\nbody\r\n</pasted_text id="w">';
    expect(extractPastedTextBlocks(content)).toEqual({ text: 'look', blocks: [{ id: 'w', text: 'body' }] });
  });
});

test('expandPastedTextBlocks inlines the pasted text', () => {
  const content = `Check this:\n\n${formatPastedTextBlock({ id: 'p', text: 'line 1\nline 2' })}`;
  expect(expandPastedTextBlocks(content)).toBe('Check this:\n\nline 1\nline 2');
});
