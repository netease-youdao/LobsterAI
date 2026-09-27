import { syntaxTree } from '@codemirror/language';
import { EditorSelection, type EditorState } from '@codemirror/state';
import { type EditorView, WidgetType } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import katex from 'katex';
import { renderToStaticMarkup } from 'react-dom/server';

import MarkdownContent, { normalizeMarkdownLocalFilePath } from '@/components/MarkdownContent';
import { copyTextToClipboard } from '@/services/clipboard';
import { i18nService } from '@/services/i18n';

import { lineStructure, type ListMarker, ListMarkerKind, MarkdownSyntax } from './markdownLiveStructure';

export interface MarkdownPreviewOptions {
  resolveLocalFilePath?: (href: string, text: string) => string | null;
}

export const PreviewBlockKind = { Table: 'table', Math: 'math', Image: 'image' } as const;
export type PreviewBlockKind = typeof PreviewBlockKind[keyof typeof PreviewBlockKind];

const t = (key: string) => i18nService.t(key);

export function openMarkdownHref(href: string, options: MarkdownPreviewOptions): void {
  if (!href) return;
  if (/^(?:https?|mailto|tel):/i.test(href)) {
    void window.electron?.shell?.openExternal(href);
    return;
  }
  const path = options.resolveLocalFilePath?.(href, '')
    ?? (/^(?:file|localfile):/i.test(href) ? normalizeMarkdownLocalFilePath(href) : null);
  if (path) void window.electron?.shell?.openPath(path);
}

function renderPreviewMarkup(source: string, options: MarkdownPreviewOptions): string {
  // Static markup renders synchronously, so the widget has its final height
  // before CodeMirror measures it and the document never jumps.
  return renderToStaticMarkup(
    <MarkdownContent content={source} resolveLocalFilePath={options.resolveLocalFilePath} enableLargePreview={false} />,
  );
}

function caretTextOffset(container: Element, event: MouseEvent): number | null {
  const caret = document.caretRangeFromPoint?.(event.clientX, event.clientY);
  if (!caret || !container.contains(caret.startContainer)) return null;
  const range = document.createRange();
  range.setStart(container, 0);
  range.setEnd(caret.startContainer, caret.startOffset);
  return range.toString().length;
}

interface TableCellSlot { from: number; to: number }

function tableRowCells(row: SyntaxNode): TableCellSlot[] {
  const cells: TableCellSlot[] = [];
  let cell: SyntaxNode | null = null;
  let previousDelimiterEnd = row.from;
  let lastWasDelimiter = false;
  for (let child = row.firstChild; child; child = child.nextSibling) {
    if (child.name === 'TableDelimiter') {
      if (child.from > row.from) {
        cells.push(cell ? { from: cell.from, to: cell.to } : { from: previousDelimiterEnd, to: previousDelimiterEnd });
      }
      cell = null;
      previousDelimiterEnd = child.to;
      lastWasDelimiter = true;
    } else if (child.name === 'TableCell') {
      cell = child;
      lastWasDelimiter = false;
    }
  }
  if (!lastWasDelimiter && cell) cells.push({ from: cell.from, to: cell.to });
  return cells;
}

function tableAt(state: EditorState, blockFrom: number): SyntaxNode | null {
  const line = state.doc.lineAt(blockFrom);
  let node: SyntaxNode | null = syntaxTree(state).resolve(line.from + /^[\t ]*/.exec(line.text)![0].length, 1);
  while (node && node.name !== MarkdownSyntax.Table) node = node.parent;
  return node;
}

/** The source position for a click on a rendered table cell. */
export function tableCellPosition(
  state: EditorState,
  blockFrom: number,
  rowIndex: number,
  cellIndex: number,
  renderedText: string | null,
  textOffset: number | null,
): number | null {
  const table = tableAt(state, blockFrom);
  if (!table) return null;
  const rows = table.getChildren('TableHeader').concat(table.getChildren('TableRow'));
  const row = rows[rowIndex];
  if (!row) return table.to;
  const cells = tableRowCells(row);
  const cell = cells[Math.min(cellIndex, cells.length - 1)];
  if (!cell) return row.to;
  if (cell.from === cell.to) {
    return Math.min(row.to, cell.from + (state.doc.sliceString(cell.from, cell.from + 1) === ' ' ? 1 : 0));
  }
  const source = state.doc.sliceString(cell.from, cell.to);
  if (renderedText !== null && textOffset !== null && renderedText.trim() === source) {
    const leading = renderedText.length - renderedText.trimStart().length;
    return cell.from + Math.max(0, Math.min(source.length, textOffset - leading));
  }
  return cell.to;
}

export class PreviewBlockWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly kind: PreviewBlockKind,
    readonly depth: number,
    readonly options: MarkdownPreviewOptions,
    /** A preview shown below its source while that source is being edited. */
    readonly live: boolean,
  ) {
    super();
  }

  eq(other: PreviewBlockWidget): boolean {
    return this.source === other.source && this.kind === other.kind
      && this.depth === other.depth && this.live === other.live;
  }

  toDOM(view: EditorView): HTMLElement {
    const element = document.createElement('div');
    element.className = `md-preview-block md-preview-${this.kind}${this.live ? ' md-preview-live' : ''}`;
    if (this.depth) element.style.setProperty('--md-indent', `calc(${this.depth} * var(--md-step))`);
    if (!this.live) element.setAttribute('aria-label', t('markdownEditorEditBlock'));
    element.innerHTML = renderPreviewMarkup(this.source, this.options);
    element.addEventListener('mousedown', event => this.handleMouseDown(view, element, event));
    element.addEventListener('click', event => {
      // Never let the renderer window follow a link in static markup.
      if ((event.target as Element).closest('a')) event.preventDefault();
    });
    for (const image of element.querySelectorAll('img')) {
      image.addEventListener('load', () => view.requestMeasure(), { once: true });
    }
    return element;
  }

  private handleMouseDown(view: EditorView, element: HTMLElement, event: MouseEvent): void {
    const target = event.target as Element;
    const anchor = target.closest('a[href]');
    if (anchor && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      openMarkdownHref(anchor.getAttribute('href') ?? '', this.options);
      return;
    }
    if (event.button !== 0) return;
    event.preventDefault();
    if (this.live) {
      view.focus();
      return;
    }
    const position = this.editPosition(view, element, target, event);
    if (position === null) return;
    view.dispatch({ selection: EditorSelection.cursor(position), userEvent: 'select.pointer' });
    view.focus();
  }

  private editPosition(view: EditorView, element: HTMLElement, target: Element, event: MouseEvent): number | null {
    const from = view.posAtDOM(element);
    const { doc } = view.state;
    if (this.kind === PreviewBlockKind.Table) {
      const cell = target.closest('td, th') as HTMLTableCellElement | null;
      const row = cell?.parentElement as HTMLTableRowElement | null;
      if (cell && row) {
        const rowIndex = row.closest('thead') ? 0 : 1 + row.sectionRowIndex;
        const position = tableCellPosition(
          view.state, from, rowIndex, cell.cellIndex, cell.textContent, caretTextOffset(cell, event),
        );
        if (position !== null) return position;
      }
      return doc.lineAt(from).to;
    }
    const first = doc.lineAt(from);
    if (this.kind === PreviewBlockKind.Math && /^[\t ]*(?:\$\$|\\\[)[\t ]*$/.test(first.text) && first.number < doc.lines) {
      return doc.line(first.number + 1).to;
    }
    let last = first;
    while (last.number < doc.lines && doc.line(last.number + 1).text.trim()) last = doc.line(last.number + 1);
    return last.to;
  }

  ignoreEvent(): boolean { return true; }
}

export class ListMarkerWidget extends WidgetType {
  constructor(readonly marker: ListMarker) { super(); }

  eq(other: ListMarkerWidget): boolean {
    return this.marker.kind === other.marker.kind && this.marker.label === other.marker.label
      && this.marker.checked === other.marker.checked;
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('span');
    box.className = `md-list-marker md-list-marker-${this.marker.kind}`;
    if (this.marker.kind === ListMarkerKind.Task) {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'md-task-checkbox';
      input.checked = this.marker.checked;
      input.setAttribute('aria-label', t('markdownEditorToggleTask'));
      input.addEventListener('mousedown', event => event.preventDefault());
      input.addEventListener('click', event => {
        event.preventDefault();
        toggleTaskAt(view, view.posAtDOM(box));
      });
      box.append(input);
    } else {
      box.textContent = this.marker.label;
      box.addEventListener('mousedown', event => {
        event.preventDefault();
        const structure = lineStructure(view.state, view.state.doc.lineAt(view.posAtDOM(box)));
        if (!structure) return;
        view.dispatch({ selection: EditorSelection.cursor(structure.contentStart), userEvent: 'select.pointer' });
        view.focus();
      });
    }
    return box;
  }

  ignoreEvent(): boolean { return true; }
}

function toggleTaskAt(view: EditorView, position: number): void {
  if (view.state.readOnly) return;
  const structure = lineStructure(view.state, view.state.doc.lineAt(position));
  const taskFrom = structure?.marker?.taskFrom ?? -1;
  if (taskFrom < 0) return;
  const checked = /[xX]/.test(view.state.doc.sliceString(taskFrom + 1, taskFrom + 2));
  view.dispatch({ changes: { from: taskFrom + 1, to: taskFrom + 2, insert: checked ? ' ' : 'x' }, userEvent: 'input' });
}

const COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

/** The code between a fence pair, without the list indentation that places the block. */
export function fencedCodeText(state: EditorState, position: number): string | null {
  let node: SyntaxNode | null = syntaxTree(state).resolve(position, 1);
  while (node && node.name !== MarkdownSyntax.FencedCode) node = node.parent;
  if (!node) return null;
  const { doc } = state;
  const first = doc.lineAt(node.from);
  const indent = node.from - first.from;
  const marks = node.getChildren(MarkdownSyntax.CodeMark);
  const lastLine = doc.lineAt(node.to);
  const endLine = marks.length > 1 ? lastLine.number - 1 : lastLine.number;
  const lines: string[] = [];
  for (let number = first.number + 1; number <= endLine; number++) {
    const text = doc.line(number).text;
    const structure = lineStructure(state, doc.line(number));
    const skip = structure ? structure.contentStart - doc.line(number).from : Math.min(indent, /^[\t ]*/.exec(text)![0].length);
    lines.push(text.slice(skip));
  }
  return lines.join('\n');
}

export class CodeFenceWidget extends WidgetType {
  constructor(readonly language: string) { super(); }

  eq(other: CodeFenceWidget): boolean { return this.language === other.language; }

  toDOM(view: EditorView): HTMLElement {
    const header = document.createElement('span');
    header.className = 'md-code-header';
    const label = document.createElement('span');
    label.className = 'md-code-language';
    label.textContent = this.language;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'md-code-copy';
    button.title = t('copy');
    button.setAttribute('aria-label', t('copy'));
    button.innerHTML = COPY_ICON;
    let reset: number | undefined;
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', async event => {
      event.preventDefault();
      const code = fencedCodeText(view.state, view.posAtDOM(header));
      if (code === null || !await copyTextToClipboard(code)) return;
      button.innerHTML = CHECK_ICON;
      button.title = t('copied');
      window.clearTimeout(reset);
      reset = window.setTimeout(() => {
        button.innerHTML = COPY_ICON;
        button.title = t('copy');
      }, 1500);
    });
    header.append(label, button);
    return header;
  }

  ignoreEvent(event: Event): boolean {
    return Boolean((event.target as Element | null)?.closest?.('button'));
  }
}

export class InlineMathWidget extends WidgetType {
  constructor(readonly source: string) { super(); }

  eq(other: InlineMathWidget): boolean { return this.source === other.source; }

  toDOM(view: EditorView): HTMLElement {
    const span = document.createElement('span');
    span.className = 'md-inline-math';
    const size = this.source.startsWith('\\(') ? 2 : /^\$+/.exec(this.source)![0].length;
    try {
      katex.render(this.source.slice(size, -size), span, { throwOnError: false, trust: false });
    } catch {
      span.textContent = this.source;
    }
    span.addEventListener('mousedown', event => {
      event.preventDefault();
      view.dispatch({ selection: EditorSelection.cursor(view.posAtDOM(span) + size), userEvent: 'select.pointer' });
      view.focus();
    });
    return span;
  }

  ignoreEvent(): boolean { return true; }
}

export class InlineImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string) { super(); }

  eq(other: InlineImageWidget): boolean { return this.src === other.src && this.alt === other.alt; }

  toDOM(view: EditorView): HTMLElement {
    const image = document.createElement('img');
    image.className = 'md-inline-image';
    image.src = this.src;
    image.alt = this.alt;
    image.addEventListener('load', () => view.requestMeasure(), { once: true });
    image.addEventListener('mousedown', event => {
      event.preventDefault();
      view.dispatch({ selection: EditorSelection.cursor(view.posAtDOM(image) + 2), userEvent: 'select.pointer' });
      view.focus();
    });
    return image;
  }

  ignoreEvent(): boolean { return true; }
}

export class EntityWidget extends WidgetType {
  constructor(readonly source: string) { super(); }
  eq(other: EntityWidget): boolean { return this.source === other.source; }
  toDOM(): HTMLElement {
    // Lezer only supplies a recognized character reference, never HTML markup.
    const decoder = document.createElement('textarea');
    decoder.innerHTML = this.source;
    const span = document.createElement('span');
    span.textContent = decoder.value;
    return span;
  }
  ignoreEvent(): boolean { return false; }
}

export class LineBreakWidget extends WidgetType {
  eq(): boolean { return true; }
  toDOM(): HTMLElement { return document.createElement('br'); }
  ignoreEvent(): boolean { return false; }
}
