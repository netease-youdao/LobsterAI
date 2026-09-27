import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState, type StateCommand } from '@codemirror/state';
import { GFM } from '@lezer/markdown';
import { describe, expect, test } from 'vitest';

import {
  completeCodeFence,
  cursorLeftOverMarkup,
  deleteForwardOverMarkup,
  deleteHeadingMarkup,
  indentListItem,
  InlineMarkup,
  insertLineAboveHeading,
  markdownShiftTab,
  markdownTab,
  outdentListItem,
  toggleInlineMarkup,
} from './markdownEditorCommands';
import { lineMarkupEnd, lineStructure } from './markdownLiveStructure';

/** Remove a marker that must occur exactly once, and return where it was. */
function cutMarker(text: string, marker: string): { text: string; at: number } {
  const at = text.indexOf(marker);
  if (at < 0 || text.includes(marker, at + marker.length)) {
    throw new Error(`Expected exactly one ${marker} marker in ${JSON.stringify(text)}`);
  }
  return { text: text.slice(0, at) + text.slice(at + marker.length), at };
}

/** `|` marks the caret; `[[` and `]]` mark the start and end of a selection. */
function stateFor(marked: string): EditorState {
  let doc: string;
  let anchor: number;
  let head: number;
  if (marked.includes('|')) {
    const caret = cutMarker(marked, '|');
    doc = caret.text;
    anchor = head = caret.at;
  } else {
    const start = cutMarker(marked, '[[');
    const end = cutMarker(start.text, ']]');
    doc = end.text;
    anchor = start.at;
    head = end.at;
  }
  return EditorState.create({
    doc,
    selection: EditorSelection.range(anchor, head),
    extensions: [markdown({ base: markdownLanguage, extensions: GFM })],
  });
}

function run(command: StateCommand, marked: string): { handled: boolean; result: string } {
  let state = stateFor(marked);
  const handled = command({ state, dispatch: transaction => { state = transaction.state; } });
  const { anchor, head } = state.selection.main;
  const doc = state.doc.toString();
  const result = anchor === head
    ? `${doc.slice(0, head)}|${doc.slice(head)}`
    : `${doc.slice(0, Math.min(anchor, head))}[[${doc.slice(Math.min(anchor, head), Math.max(anchor, head))}]]${doc.slice(Math.max(anchor, head))}`;
  return { handled, result };
}

describe('list indentation', () => {
  test('Tab nests an item and its children under the previous sibling', () => {
    expect(run(indentListItem, '- a\n- b|\n  - c').result).toBe('- a\n  - b|\n    - c');
  });

  test('a new nested ordered list starts at 1', () => {
    expect(run(indentListItem, '1. a\n2. b|').result).toBe('1. a\n   1. b|');
  });

  test('the first item stays in place and keeps focus in the editor', () => {
    expect(run(indentListItem, '- a|\n- b')).toEqual({ handled: true, result: '- a|\n- b' });
  });

  test('indentation goes after quote markers', () => {
    expect(run(indentListItem, '> - a\n> - b|').result).toBe('> - a\n>   - b|');
  });

  test('Shift-Tab moves a nested item out to its parent level', () => {
    expect(run(outdentListItem, '- a\n  - b|\n    - c').result).toBe('- a\n- b|\n  - c');
  });

  test('Tab indents code and is consumed in prose', () => {
    expect(run(markdownTab, '```\n|x\n```').result).toBe('```\n  |x\n```');
    expect(run(markdownTab, '段落|')).toEqual({ handled: true, result: '段落|' });
    expect(run(markdownShiftTab, '段落|')).toEqual({ handled: true, result: '段落|' });
  });
});

describe('inline formatting', () => {
  const bold = toggleInlineMarkup(InlineMarkup.Strong);

  test('wraps and unwraps a selection, keeping the text selected', () => {
    expect(run(bold, '说明[[背景]]。').result).toBe('说明**[[背景]]**。');
    expect(run(bold, '说明**[[背景]]**。').result).toBe('说明[[背景]]。');
  });

  test('inserts a marker pair at a caret, and removes marks around a caret', () => {
    expect(run(bold, '文字|').result).toBe('文字**|**');
    expect(run(toggleInlineMarkup(InlineMarkup.Code), 'a `co|de` b').result).toBe('a co|de b');
  });

  test('wraps each line of a multi-line selection without touching list markers', () => {
    expect(run(bold, '- [[one\n- two]]').result).toBe('- **[[one**\n- **two]]**');
    expect(run(bold, '- [[**one**\n- **two**]]').result).toBe('- [[one\n- two]]');
  });
});

describe('heading and fence editing', () => {
  test('Backspace at the start of a heading turns it into a paragraph', () => {
    expect(run(deleteHeadingMarkup, '## |标题').result).toBe('|标题');
    expect(run(deleteHeadingMarkup, '## 标|题').handled).toBe(false);
  });

  test('Enter at the start of a heading opens a paragraph above it', () => {
    expect(run(insertLineAboveHeading, '## |标题').result).toBe('\n## |标题');
  });

  test('Enter after an opening fence adds the closing fence', () => {
    expect(run(completeCodeFence, '```ts|').result).toBe('```ts\n|\n```');
    expect(run(completeCodeFence, '```ts|\nx\n```').handled).toBe(false);
  });
});

describe('navigation over hidden markup', () => {
  test('ArrowLeft from an item start goes to the previous line end', () => {
    expect(run(cursorLeftOverMarkup(false), '段落\n- |项目').result).toBe('段落|\n- 项目');
    expect(run(cursorLeftOverMarkup(false), '段落\n- 项|目').handled).toBe(false);
  });

  test('Delete at a line end joins the next item text, not its marker', () => {
    expect(run(deleteForwardOverMarkup, '段落|\n> 引用').result).toBe('段落|引用');
  });
});

describe('line structure', () => {
  const structure = (doc: string, line: number) => {
    const state = stateFor(`${doc}|`);
    return lineStructure(state, state.doc.line(line));
  };

  test('describes list and quote containers and where the text starts', () => {
    expect(structure('> - [ ] 任务', 1)).toEqual({
      contentStart: 8,
      containers: ['quote', 'list'],
      marker: { kind: 'task', label: '', checked: false, taskFrom: 4 },
    });
    expect(structure('- a\n\n  继续', 3)).toEqual({ contentStart: 7, containers: ['list'], marker: null });
    expect(structure('段落', 1)).toBeNull();
  });

  test('keeps code indentation inside a list item', () => {
    // Two of the four spaces place the fence in the item; two belong to the code.
    expect(structure('- a\n\n  ```\n    x\n  ```', 4)?.contentStart).toBe(13);
  });

  test('finds where heading text starts for Home', () => {
    const state = stateFor('### 标题|');
    expect(lineMarkupEnd(state, state.doc.line(1))).toBe(4);
  });
});
