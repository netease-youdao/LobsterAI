import type { EditedParagraph, EditedRun } from './slidesText';

/**
 * Text edited in place in a drawn text body (contenteditable): reading it back as paragraphs that
 * point at the XML they came from, and caret positions as paragraph offsets that survive a
 * redraw. Offsets count characters the way the XML does: a line break is one.
 */

export interface TextPosition {
  paragraph: number;
  offset: number;
}

const isBlock = (node: Node): node is HTMLElement => node instanceof HTMLElement && (node.tagName === 'P' || node.tagName === 'DIV');

/** Paragraph blocks of an edited container; stray inline content forms its own paragraph. */
function blocksOf(container: HTMLElement): Node[][] {
  const blocks: Node[][] = [];
  let loose: Node[] = [];
  for (const child of Array.from(container.childNodes)) {
    if (isBlock(child)) {
      if (loose.length) blocks.push(loose);
      loose = [];
      blocks.push([child]);
    } else {
      loose.push(child);
    }
  }
  if (loose.length) blocks.push(loose);
  return blocks;
}

function runsOf(nodes: Node[]): EditedRun[] {
  const runs: EditedRun[] = [];
  const walk = (node: Node, run: number | undefined) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? '';
      if (text) runs.push({ text, ...(run !== undefined ? { run } : {}) });
      return;
    }
    if (node instanceof HTMLBRElement) {
      runs.push({ text: '', lineBreak: true });
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const own = node.dataset.run !== undefined ? Number(node.dataset.run) : run;
    for (const child of Array.from(node.childNodes)) walk(child, isBlock(child) ? undefined : own);
  };
  for (const node of nodes) {
    if (isBlock(node)) for (const child of Array.from(node.childNodes)) walk(child, undefined);
    else walk(node, undefined);
  }
  // A final line break only holds an empty last line open in HTML.
  if (runs.length && runs[runs.length - 1].lineBreak) runs.pop();
  return runs;
}

/** The container's paragraphs, each pointing at the paragraph (and runs) it was drawn from. */
export function readEditedParagraphs(container: HTMLElement): EditedParagraph[] {
  return blocksOf(container).map(nodes => {
    const block = nodes.length === 1 && isBlock(nodes[0]) ? nodes[0] : undefined;
    const source = block?.dataset.paragraph !== undefined ? Number(block.dataset.paragraph) : undefined;
    return { ...(source !== undefined && Number.isInteger(source) ? { source } : {}), runs: runsOf(nodes) };
  });
}

/** Characters from the start of `nodes` up to a DOM point inside them. */
function offsetWithin(nodes: Node[], node: Node, offset: number): number {
  const range = document.createRange();
  range.setStartBefore(nodes[0]);
  range.setEnd(node, offset);
  const fragment = range.cloneContents();
  let count = (fragment.textContent ?? '').length;
  count += fragment.querySelectorAll('br').length;
  return count;
}

const lengthOf = (nodes: Node[]): number => runsOf(nodes).reduce((sum, run) => sum + (run.lineBreak ? 1 : run.text.length), 0);

/** A DOM point in the container as a paragraph offset. */
export function positionOf(container: HTMLElement, node: Node, offset: number): TextPosition | undefined {
  if (!container.contains(node)) return undefined;
  const blocks = blocksOf(container);
  if (!blocks.length) return { paragraph: 0, offset: 0 };
  // A point between the container's children belongs to the block after it, or ends the last one.
  const anchor = node === container ? container.childNodes[offset] : node;
  let index = anchor ? blocks.findIndex(nodes => nodes.some(item => item === anchor || item.contains(anchor))) : -1;
  if (index < 0) index = blocks.length - 1;
  return { paragraph: index, offset: Math.min(lengthOf(blocks[index]), offsetWithin(blocks[index], node, offset)) };
}

/** The current selection inside the container, as paragraph offsets. */
export function selectionIn(container: HTMLElement): { start: TextPosition; end: TextPosition } | undefined {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return undefined;
  const range = selection.getRangeAt(0);
  const start = positionOf(container, range.startContainer, range.startOffset);
  const end = positionOf(container, range.endContainer, range.endOffset);
  return start && end ? { start, end } : undefined;
}

/** The DOM point at a paragraph offset. */
function pointAt(container: HTMLElement, position: TextPosition): { node: Node; offset: number } | undefined {
  const blocks = blocksOf(container);
  const nodes = blocks[Math.min(position.paragraph, blocks.length - 1)];
  if (!nodes) return undefined;
  let remaining = position.offset;
  let last: { node: Node; offset: number } | undefined;
  const visit = (node: Node): { node: Node; offset: number } | undefined => {
    if (node.nodeType === Node.TEXT_NODE) {
      const length = node.textContent?.length ?? 0;
      if (remaining <= length) return { node, offset: remaining };
      remaining -= length;
      last = { node, offset: length };
      return undefined;
    }
    if (node instanceof HTMLBRElement) {
      const parent = node.parentNode!;
      const index = Array.from(parent.childNodes).indexOf(node);
      if (remaining === 0) return { node: parent, offset: index };
      remaining -= 1;
      last = { node: parent, offset: index + 1 };
      return undefined;
    }
    for (const child of Array.from(node.childNodes)) {
      const found = visit(child);
      if (found) return found;
    }
    return undefined;
  };
  for (const node of nodes) {
    const found = visit(node);
    if (found) return found;
  }
  if (last) return last;
  const first = nodes[0];
  return isBlock(first) ? { node: first, offset: 0 } : { node: container, offset: Array.from(container.childNodes).indexOf(first as ChildNode) };
}

export function setSelectionIn(container: HTMLElement, start: TextPosition, end: TextPosition = start): void {
  const from = pointAt(container, start);
  const to = pointAt(container, end);
  const selection = window.getSelection();
  if (!from || !to || !selection) return;
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Put the caret where the pointer is, or at the end of the text. */
export function placeCaret(container: HTMLElement, point?: { x: number; y: number }): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = point ? document.caretRangeFromPoint(point.x, point.y) : null;
  if (range && container.contains(range.startContainer)) {
    selection.removeAllRanges();
    selection.addRange(range);
    return;
  }
  const end = document.createRange();
  end.selectNodeContents(container);
  end.collapse(false);
  selection.removeAllRanges();
  selection.addRange(end);
}

export function selectAllIn(container: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(container);
  selection.removeAllRanges();
  selection.addRange(range);
}

interface WordSegmenter {
  segment: (text: string) => Iterable<{ segment: string; index: number; isWordLike?: boolean }>;
}

/** The word around an offset of a paragraph's text, for formatting at a collapsed caret as PowerPoint does. */
export function wordAt(text: string, offset: number): { start: number; end: number } | undefined {
  const Segmenter = (Intl as unknown as { Segmenter?: new (locale: string | undefined, options: { granularity: string }) => WordSegmenter }).Segmenter;
  if (Segmenter) {
    for (const part of new Segmenter(undefined, { granularity: 'word' }).segment(text)) {
      const end = part.index + part.segment.length;
      if (part.isWordLike && part.index <= offset && offset <= end && (offset < end || part.index < offset)) return { start: part.index, end };
    }
    return undefined;
  }
  const word = /[\p{L}\p{N}_]+/gu;
  for (let match = word.exec(text); match; match = word.exec(text)) {
    if (match.index <= offset && offset <= match.index + match[0].length) return { start: match.index, end: match.index + match[0].length };
  }
  return undefined;
}
