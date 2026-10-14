import { indentLess, indentMore } from '@codemirror/commands';
import { indentUnit, syntaxTree } from '@codemirror/language';
import {
  type ChangeSpec,
  EditorSelection,
  type EditorState,
  type Line,
  type SelectionRange,
  type StateCommand,
} from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';

import { lineMarkupEnd, lineStructure, MarkdownSyntax } from './markdownLiveStructure';

export const InlineMarkup = {
  Strong: { node: 'StrongEmphasis', mark: 'EmphasisMark', marker: '**' },
  Emphasis: { node: 'Emphasis', mark: 'EmphasisMark', marker: '*' },
  Code: { node: 'InlineCode', mark: 'CodeMark', marker: '`' },
  Strike: { node: 'Strikethrough', mark: 'StrikethroughMark', marker: '~~' },
} as const;
export type InlineMarkup = typeof InlineMarkup[keyof typeof InlineMarkup];

const leadingBlanks = (text: string) => /^[\t ]*/.exec(text)![0].length;

function ancestor(node: SyntaxNode | null, name: string): SyntaxNode | null {
  for (let current = node; current; current = current.parent) if (current.name === name) return current;
  return null;
}

/** Where indentation can be inserted on a line: after any quote markers. */
function quoteMarkupEnd(state: EditorState, line: Line): number {
  const tree = syntaxTree(state);
  let position = line.from;
  for (;;) {
    const next = position + leadingBlanks(line.text.slice(position - line.from));
    const mark = next < line.to ? tree.resolve(next, 1) : null;
    if (!mark || mark.name !== MarkdownSyntax.QuoteMark || mark.from !== next) return position;
    position = mark.to + (line.text[mark.to - line.from] === ' ' ? 1 : 0);
  }
}

/** The innermost list item that owns a line. */
function listItemAt(state: EditorState, line: Line): SyntaxNode | null {
  const start = quoteMarkupEnd(state, line);
  const text = start + leadingBlanks(line.text.slice(start - line.from));
  return ancestor(syntaxTree(state).resolve(text, 1), MarkdownSyntax.ListItem);
}

function listContentColumn(state: EditorState, item: SyntaxNode): number {
  const line = state.doc.lineAt(item.from);
  return (lineStructure(state, line)?.contentStart ?? item.from) - line.from;
}

function previousListItem(item: SyntaxNode): SyntaxNode | null {
  for (let sibling = item.prevSibling; sibling; sibling = sibling.prevSibling) {
    if (sibling.name === MarkdownSyntax.ListItem) return sibling;
  }
  return null;
}

/** Lines covered by the selection's list items, from the first item's marker line. */
function listItemLines(state: EditorState, range: SelectionRange): { item: SyntaxNode; lines: Line[] } | null {
  const { doc } = state;
  const item = listItemAt(state, doc.lineAt(range.from));
  if (!item) return null;
  const lastItem = listItemAt(state, doc.lineAt(range.to)) ?? item;
  const first = doc.lineAt(item.from).number;
  const last = doc.lineAt(Math.max(item.to, lastItem.to)).number;
  const lines: Line[] = [];
  for (let number = first; number <= last; number++) lines.push(doc.line(number));
  return { item, lines };
}

/** Tab in a list: nest the item under its previous sibling, as a document editor does. */
export const indentListItem: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const target = listItemLines(state, state.selection.main);
  if (!target) return false;
  const previous = previousListItem(target.item);
  const markerLine = state.doc.lineAt(target.item.from);
  const delta = previous ? listContentColumn(state, previous) - (target.item.from - markerLine.from) : 0;
  // The first item cannot be nested; keep focus in the editor anyway.
  if (!previous || delta <= 0) return true;
  const padding = ' '.repeat(delta);
  const changes: ChangeSpec[] = target.lines
    .filter(line => line.text.trim())
    .map(line => ({ from: quoteMarkupEnd(state, line), insert: padding }));
  // A new nested ordered list starts at 1, as renderers count from its first number.
  const list = target.item.parent;
  const mark = target.item.getChild(MarkdownSyntax.ListMark);
  const previousLast = previous.lastChild?.name;
  if (list?.name === MarkdownSyntax.OrderedList && mark && previousLast !== MarkdownSyntax.OrderedList) {
    const digits = /^\d+/.exec(state.doc.sliceString(mark.from, mark.to))?.[0] ?? '';
    if (digits && digits !== '1') changes.push({ from: mark.from, to: mark.from + digits.length, insert: '1' });
  }
  dispatch(state.update({ changes, scrollIntoView: true, userEvent: 'input.indent' }));
  return true;
};

/** Shift-Tab in a list: move the item out to its parent's level. */
export const outdentListItem: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const target = listItemLines(state, state.selection.main);
  if (!target) return false;
  const parent = ancestor(target.item.parent, MarkdownSyntax.ListItem);
  if (!parent) return true;
  const markerLine = state.doc.lineAt(target.item.from);
  const delta = (target.item.from - markerLine.from) - (parent.from - state.doc.lineAt(parent.from).from);
  if (delta <= 0) return true;
  const changes: ChangeSpec[] = [];
  for (const line of target.lines) {
    const from = quoteMarkupEnd(state, line);
    const blanks = Math.min(delta, leadingBlanks(line.text.slice(from - line.from)));
    if (blanks) changes.push({ from, to: from + blanks });
  }
  dispatch(state.update({ changes, scrollIntoView: true, userEvent: 'delete.dedent' }));
  return true;
};

function insideCode(state: EditorState, position: number): boolean {
  const node = syntaxTree(state).resolve(position, -1);
  const code = ancestor(node, MarkdownSyntax.FencedCode) ?? ancestor(node, MarkdownSyntax.CodeBlock);
  if (!code) return false;
  // The opening fence line is Markdown syntax, not code.
  return code.name === MarkdownSyntax.CodeBlock || state.doc.lineAt(position).from > code.from;
}

const insertCodeIndent: StateCommand = target => {
  const { state, dispatch } = target;
  if (state.readOnly || !insideCode(state, state.selection.main.head)) return false;
  if (state.selection.ranges.some(range => !range.empty)) return indentMore(target);
  const unit = state.facet(indentUnit);
  dispatch(state.update(state.changeByRange(range => ({
    changes: { from: range.from, insert: unit },
    range: EditorSelection.cursor(range.from + unit.length),
  })), { scrollIntoView: true, userEvent: 'input' }));
  return true;
};

/** Tab indents a list item or code; elsewhere it is consumed so focus stays in the document. */
export const markdownTab: StateCommand = target => indentListItem(target) || insertCodeIndent(target) || true;

export const markdownShiftTab: StateCommand = target => {
  if (outdentListItem(target)) return true;
  if (insideCode(target.state, target.state.selection.main.head)) return indentLess(target);
  return true;
};

function enclosingMarkup(state: EditorState, range: SelectionRange, markup: InlineMarkup): SyntaxNode | null {
  const tree = syntaxTree(state);
  for (const side of [1, -1] as const) {
    const node = ancestor(tree.resolveInner(range.from, side), markup.node);
    if (node && node.from <= range.from && range.to <= node.to) return node;
  }
  return null;
}

/** Wrap each line's text separately; emphasis cannot span paragraphs. */
function wrapSegments(state: EditorState, range: SelectionRange): { from: number; to: number }[] {
  const { doc } = state;
  const segments: { from: number; to: number }[] = [];
  for (let number = doc.lineAt(range.from).number; number <= doc.lineAt(range.to).number; number++) {
    const line = doc.line(number);
    let from = Math.max(range.from, lineMarkupEnd(state, line));
    let to = Math.min(range.to, line.to);
    while (from < to && /\s/.test(doc.sliceString(from, from + 1))) from++;
    while (to > from && /\s/.test(doc.sliceString(to - 1, to))) to--;
    if (from < to) segments.push({ from, to });
  }
  return segments;
}

/** Toggle bold, italic, inline code, or strikethrough around each selection range. */
export function toggleInlineMarkup(markup: InlineMarkup): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false;
    const { marker } = markup;
    dispatch(state.update(state.changeByRange(range => {
      const existing = enclosingMarkup(state, range, markup);
      if (existing) {
        const marks = existing.getChildren(markup.mark);
        const open = marks[0];
        const close = marks.length > 1 ? marks[marks.length - 1] : null;
        const changes = state.changes([
          ...(open ? [{ from: open.from, to: open.to }] : []),
          ...(close ? [{ from: close.from, to: close.to }] : []),
        ]);
        return { changes, range: EditorSelection.range(changes.mapPos(range.anchor, -1), changes.mapPos(range.head, -1)) };
      }
      const segments = range.empty ? [] : wrapSegments(state, range);
      if (!segments.length) {
        return {
          changes: { from: range.head, insert: marker + marker },
          range: EditorSelection.cursor(range.head + marker.length),
        };
      }
      // A multi-line selection whose every line is already wrapped toggles off.
      const wrapped = segments.every(segment => (
        state.sliceDoc(segment.from, segment.from + marker.length) === marker
        && state.sliceDoc(segment.to - marker.length, segment.to) === marker
        && segment.to - segment.from > marker.length * 2
      ));
      const changes = state.changes(segments.flatMap((segment): ChangeSpec[] => (wrapped
        ? [{ from: segment.from, to: segment.from + marker.length }, { from: segment.to - marker.length, to: segment.to }]
        : [{ from: segment.from, insert: marker }, { from: segment.to, insert: marker }])));
      const from = changes.mapPos(segments[0].from, wrapped ? -1 : 1);
      const to = changes.mapPos(segments[segments.length - 1].to, -1);
      return { changes, range: range.anchor <= range.head ? EditorSelection.range(from, to) : EditorSelection.range(to, from) };
    }), { scrollIntoView: true, userEvent: 'input.format' }));
    return true;
  };
}

function atxHeadingMarkup(state: EditorState, line: Line): { from: number; to: number } | null {
  const mark = syntaxTree(state).resolve(line.from + leadingBlanks(line.text), 1);
  if (mark.name !== MarkdownSyntax.HeaderMark || !mark.parent?.name.startsWith('ATXHeading') || mark.parent.from !== mark.from) {
    return null;
  }
  return { from: mark.from, to: Math.min(line.to, mark.to + (line.text[mark.to - line.from] === ' ' ? 1 : 0)) };
}

/** Backspace at the start of a heading's text turns it back into a paragraph. */
export const deleteHeadingMarkup: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main;
  if (state.readOnly || !range.empty || state.selection.ranges.length > 1) return false;
  const markup = atxHeadingMarkup(state, state.doc.lineAt(range.head));
  if (!markup || range.head !== markup.to) return false;
  dispatch(state.update({
    changes: { from: markup.from, to: markup.to },
    selection: EditorSelection.cursor(markup.from),
    scrollIntoView: true,
    userEvent: 'delete.backward',
  }));
  return true;
};

/** Enter at the start of a heading's text opens a paragraph above instead of splitting the marks. */
export const insertLineAboveHeading: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main;
  if (state.readOnly || !range.empty || state.selection.ranges.length > 1) return false;
  const line = state.doc.lineAt(range.head);
  const markup = atxHeadingMarkup(state, line);
  if (!markup || range.head !== markup.to || markup.to === line.to || markup.from !== line.from) return false;
  dispatch(state.update({
    changes: { from: line.from, insert: state.lineBreak },
    selection: EditorSelection.cursor(range.head + state.lineBreak.length),
    scrollIntoView: true,
    userEvent: 'input',
  }));
  return true;
};

/** Enter after an opening code fence adds the closing fence, so the rest of the document stays prose. */
export const completeCodeFence: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main;
  if (state.readOnly || !range.empty || state.selection.ranges.length > 1) return false;
  const line = state.doc.lineAt(range.head);
  const match = /^([\t ]*)(`{3,}|~{3,})([^`]*)$/.exec(line.text);
  if (!match || range.head !== line.to) return false;
  const code = ancestor(syntaxTree(state).resolve(line.from + match[1].length, 1), MarkdownSyntax.FencedCode);
  if (!code || code.from !== line.from + match[1].length || code.getChildren(MarkdownSyntax.CodeMark).length > 1) return false;
  const indent = match[1];
  dispatch(state.update({
    changes: { from: range.head, insert: `${state.lineBreak}${indent}${state.lineBreak}${indent}${match[2]}` },
    selection: EditorSelection.cursor(range.head + state.lineBreak.length + indent.length),
    scrollIntoView: true,
    userEvent: 'input',
  }));
  return true;
};

function hiddenMarkupStart(state: EditorState, line: Line): number | null {
  const structure = lineStructure(state, line);
  return structure && structure.contentStart > line.from ? structure.contentStart : null;
}

/** Arrow left from the start of a list or quote item moves to the previous line, over the hidden markup. */
export function cursorLeftOverMarkup(extend: boolean): StateCommand {
  return ({ state, dispatch }) => {
    const range = state.selection.main;
    if (state.selection.ranges.length > 1 || (!extend && !range.empty)) return false;
    const line = state.doc.lineAt(range.head);
    if (line.from === 0 || hiddenMarkupStart(state, line) !== range.head) return false;
    const target = line.from - 1;
    dispatch(state.update({
      selection: extend ? EditorSelection.range(range.anchor, target) : EditorSelection.cursor(target),
      scrollIntoView: true,
      userEvent: 'select',
    }));
    return true;
  };
}

/** Delete at the end of a line joins the next list or quote item's text, not its markup. */
export const deleteForwardOverMarkup: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main;
  if (state.readOnly || state.selection.ranges.length > 1 || !range.empty) return false;
  const line = state.doc.lineAt(range.head);
  if (range.head !== line.to || line.number === state.doc.lines) return false;
  const contentStart = hiddenMarkupStart(state, state.doc.line(line.number + 1));
  if (contentStart === null) return false;
  dispatch(state.update({
    changes: { from: range.head, to: contentStart },
    selection: EditorSelection.cursor(range.head),
    scrollIntoView: true,
    userEvent: 'delete.forward',
  }));
  return true;
};

/**
 * Home goes to the start of a line's text, after list, quote and heading
 * markup; pressed again it goes to the true line start.
 */
export function cursorLineStartSmart(view: EditorView, extend: boolean): boolean {
  const { state } = view;
  const selection = EditorSelection.create(state.selection.ranges.map(range => {
    const line = state.doc.lineAt(range.head);
    let target = view.moveToLineBoundary(range, false).head;
    const markupEnd = lineMarkupEnd(state, line);
    if (target <= markupEnd) target = range.head === markupEnd ? line.from : markupEnd;
    return extend ? EditorSelection.range(range.anchor, target) : EditorSelection.cursor(target);
  }), state.selection.mainIndex);
  view.dispatch({ selection, scrollIntoView: true, userEvent: 'select' });
  return true;
}
