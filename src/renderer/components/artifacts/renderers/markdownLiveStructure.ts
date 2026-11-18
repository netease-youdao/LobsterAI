import { syntaxTree } from '@codemirror/language';
import type { EditorState, Line } from '@codemirror/state';
import type { SyntaxNode, Tree } from '@lezer/common';

export const MarkdownSyntax = {
  Document: 'Document', Paragraph: 'Paragraph', BulletList: 'BulletList', OrderedList: 'OrderedList',
  ListItem: 'ListItem', ListMark: 'ListMark', Task: 'Task', TaskMarker: 'TaskMarker',
  Blockquote: 'Blockquote', QuoteMark: 'QuoteMark', HeaderMark: 'HeaderMark',
  FencedCode: 'FencedCode', CodeBlock: 'CodeBlock', CodeMark: 'CodeMark', CodeInfo: 'CodeInfo',
  Table: 'Table', Image: 'Image',
} as const;

export const ListMarkerKind = { Bullet: 'bullet', Ordered: 'ordered', Task: 'task' } as const;
export type ListMarkerKind = typeof ListMarkerKind[keyof typeof ListMarkerKind];

export const LineContainer = { Quote: 'quote', List: 'list' } as const;
export type LineContainer = typeof LineContainer[keyof typeof LineContainer];

export interface ListMarker {
  kind: ListMarkerKind;
  /** Rendered label: a bullet, or the list number as a renderer counts it. */
  label: string;
  checked: boolean;
  /** Offset of the `[ ]` task box, or -1. */
  taskFrom: number;
}

export interface LineStructure {
  /** Where the line's own content starts after container markup and list indentation. */
  contentStart: number;
  /** Outer-to-inner containers that indent this line. */
  containers: LineContainer[];
  /** The list item that starts on this line. */
  marker: ListMarker | null;
}

const FRONTMATTER = /^\uFEFF?---\n[\s\S]*?\n(?:---|\.\.\.)(?:\n|$)/;
const FRONTMATTER_SCAN_LIMIT = 64 * 1024;
const MAX_PREFIX_MARKS = 16;

/** End offset of a leading YAML front matter block, or 0 when there is none. */
export function frontmatterEnd(state: EditorState): number {
  const head = state.doc.sliceString(0, Math.min(state.doc.length, FRONTMATTER_SCAN_LIMIT));
  return FRONTMATTER.exec(head)?.[0].length ?? 0;
}

const isBlank = (char: string | undefined) => char === ' ' || char === '\t';

function countSpaces(line: Line, from: number): number {
  let count = 0;
  while (isBlank(line.text[from - line.from + count])) count++;
  return count;
}

/** CommonMark takes one to four spaces after a list marker; more starts indented code. */
function listContentOffset(line: Line, markerEnd: number): number {
  const spaces = countSpaces(line, markerEnd);
  if (spaces === 0 || markerEnd + spaces >= line.to) return Math.min(spaces, 1);
  return spaces > 4 ? 1 : spaces;
}

function orderedLabel(state: EditorState, item: SyntaxNode): string {
  const list = item.parent;
  let start = 1;
  let index = 0;
  let first = true;
  for (let child = list?.firstChild ?? null; child; child = child.nextSibling) {
    if (child.name !== MarkdownSyntax.ListItem) continue;
    if (first) {
      const mark = child.getChild(MarkdownSyntax.ListMark);
      start = mark ? Number.parseInt(state.doc.sliceString(mark.from, mark.to), 10) || 0 : 1;
      first = false;
    }
    if (child.from === item.from) break;
    index++;
  }
  const mark = item.getChild(MarkdownSyntax.ListMark);
  const delimiter = mark && state.doc.sliceString(mark.to - 1, mark.to) === ')' ? ')' : '.';
  return `${start + index}${delimiter}`;
}

/** Column where a list item's content starts, measured from the start of its first line. */
function listItemContentColumn(state: EditorState, item: SyntaxNode): number {
  const mark = item.getChild(MarkdownSyntax.ListMark);
  const line = state.doc.lineAt(item.from);
  if (!mark) return item.from - line.from;
  let end = mark.to + listContentOffset(line, mark.to);
  const task = item.getChild(MarkdownSyntax.Task)?.getChild(MarkdownSyntax.TaskMarker);
  if (task && task.from === end) end = task.to + Math.min(1, countSpaces(line, task.to));
  return end - line.from;
}

/**
 * Describe the quote and list markup that owns the start of a line. Returns
 * null for lines outside every quote and list.
 */
export function lineStructure(state: EditorState, line: Line, tree: Tree = syntaxTree(state)): LineStructure | null {
  let pos = line.from;
  let marker: ListMarker | null = null;
  let markerItem: SyntaxNode | null = null;
  for (let count = 0; count < MAX_PREFIX_MARKS; count++) {
    const next = pos + countSpaces(line, pos);
    if (next >= line.to) break;
    const mark = tree.resolve(next, 1);
    if (mark.from !== next) break;
    if (mark.name === MarkdownSyntax.QuoteMark) {
      pos = mark.to + Math.min(1, countSpaces(line, mark.to));
      continue;
    }
    if (mark.name === MarkdownSyntax.ListMark && mark.parent?.name === MarkdownSyntax.ListItem) {
      markerItem = mark.parent;
      pos = mark.to + listContentOffset(line, mark.to);
      marker = markerItem.parent?.name === MarkdownSyntax.OrderedList
        ? { kind: ListMarkerKind.Ordered, label: orderedLabel(state, markerItem), checked: false, taskFrom: -1 }
        : { kind: ListMarkerKind.Bullet, label: '•', checked: false, taskFrom: -1 };
      continue;
    }
    if (mark.name === MarkdownSyntax.TaskMarker && marker && marker.kind === ListMarkerKind.Bullet) {
      marker = {
        kind: ListMarkerKind.Task,
        label: '',
        checked: /[xX]/.test(state.doc.sliceString(mark.from, mark.to)),
        taskFrom: mark.from,
      };
      pos = mark.to + Math.min(1, countSpaces(line, mark.to));
    }
    break;
  }

  const containers: LineContainer[] = [];
  let innermostItem: SyntaxNode | null = null;
  let anchor = tree.resolve(Math.min(pos, line.to), 1);
  if (anchor.name === MarkdownSyntax.Document && pos > line.from) anchor = tree.resolve(pos, -1);
  for (let node: SyntaxNode | null = anchor; node; node = node.parent) {
    if (node.name === MarkdownSyntax.Blockquote) containers.push(LineContainer.Quote);
    else if (node.name === MarkdownSyntax.ListItem) {
      containers.push(LineContainer.List);
      innermostItem ??= node;
    }
  }
  if (!containers.length && pos === line.from) return null;
  containers.reverse();

  // A continuation line hides the indentation that places it inside its list
  // item, and keeps any further indentation (for example inside code).
  if (!marker && innermostItem && innermostItem.from < line.from) {
    const column = line.from + listItemContentColumn(state, innermostItem);
    while (pos < column && pos < line.to && isBlank(line.text[pos - line.from])) pos++;
  }
  if (marker && markerItem && innermostItem && markerItem.from !== innermostItem.from) {
    // The content belongs to another item than the marker (node wrappers are
    // not unique objects, so compare positions); render no marker.
    marker = null;
  }
  return { contentStart: pos, containers, marker };
}

/** The first offset of a line after list, quote, or ATX heading markup. */
export function lineMarkupEnd(state: EditorState, line: Line): number {
  const structure = lineStructure(state, line);
  const start = structure?.contentStart ?? line.from + countSpaces(line, line.from);
  const mark = syntaxTree(state).resolve(start, 1);
  if (mark.name === MarkdownSyntax.HeaderMark && mark.from === start && mark.parent?.name.startsWith('ATXHeading')) {
    return Math.min(line.to, mark.to + Math.min(1, countSpaces(line, mark.to)));
  }
  return start;
}
