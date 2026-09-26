import { syntaxTree } from '@codemirror/language';
import {
  EditorSelection,
  EditorState,
  type Extension,
  Facet,
  type Line,
  type Range,
  type SelectionRange,
  StateEffect,
  StateField,
} from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import type { SyntaxNode, SyntaxNodeRef, Tree } from '@lezer/common';
import type { MarkdownConfig } from '@lezer/markdown';

import { resolveMarkdownImageSrc, safeUrlTransform } from '@/components/MarkdownContent';
import { i18nService } from '@/services/i18n';
import { isMarkdownHtmlBreak } from '@/utils/remarkMarkdownLayout';

import {
  frontmatterEnd,
  LineContainer,
  type LineStructure,
  lineStructure,
  MarkdownSyntax,
} from './markdownLiveStructure';
import {
  CodeFenceWidget,
  EntityWidget,
  InlineImageWidget,
  InlineMathWidget,
  LineBreakWidget,
  ListMarkerWidget,
  type MarkdownPreviewOptions,
  openMarkdownHref,
  PreviewBlockKind,
  PreviewBlockWidget,
} from './markdownLiveWidgets';
import {
  type MarkdownPreviewReferences,
  markdownPreviewReferences,
  withMarkdownReferenceDefinitions,
} from './markdownPreviewReferences';

export type { MarkdownPreviewOptions } from './markdownLiveWidgets';

const Syntax = {
  ...MarkdownSyntax,
  Strong: 'StrongEmphasis', Emphasis: 'Emphasis', Strike: 'Strikethrough', InlineCode: 'InlineCode',
  EmphasisMark: 'EmphasisMark', StrikeMark: 'StrikethroughMark', Link: 'Link', LinkMark: 'LinkMark',
  Url: 'URL', LinkTitle: 'LinkTitle', LinkLabel: 'LinkLabel', Autolink: 'Autolink', Math: 'InlineMath',
  Escape: 'Escape', Entity: 'Entity', HardBreak: 'HardBreak', HtmlTag: 'HTMLTag', HtmlBlock: 'HTMLBlock',
  Comment: 'Comment', CommentBlock: 'CommentBlock', Rule: 'HorizontalRule', LinkReference: 'LinkReference',
} as const;

export const markdownMathSyntax: MarkdownConfig = {
  defineNodes: [Syntax.Math],
  parseInline: [{
    name: Syntax.Math,
    before: Syntax.Escape,
    parse(context, next, position) {
      const latex = next === 92 && context.char(position + 1) === 40;
      if (!latex && next !== 36) return -1;
      let size = latex ? 2 : 1;
      if (!latex) while (context.char(position + size) === 36) size++;
      for (let end = position + size; end < context.end; end++) {
        if (latex && context.char(end) === 92 && context.char(end + 1) === 41) {
          return context.slice(position + size, end).trim()
            ? context.addElement(context.elt(Syntax.Math, position, end + 2)) : -1;
        }
        if (context.char(end) === 92) { end++; continue; }
        if (!latex && context.char(end) === 36) {
          let closingSize = 1;
          while (context.char(end + closingSize) === 36) closingSize++;
          if (closingSize === size && context.slice(position + size, end).trim()) {
            return context.addElement(context.elt(Syntax.Math, position, end + size));
          }
          end += closingSize - 1;
        }
      }
      // Consume an unmatched dollar run as a unit so its second dollar cannot
      // become an opener. An escaped dollar before a valid run stays independent.
      return latex ? -1 : position + size;
    },
  }],
};

const previewOptions = Facet.define<MarkdownPreviewOptions, MarkdownPreviewOptions>({
  combine: values => values[0] ?? {},
});

const t = (key: string) => i18nService.t(key);
const isMacPlatform = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

// ---------------------------------------------------------------------------
// Interaction state
// ---------------------------------------------------------------------------

interface LiveInteraction {
  focused: boolean;
  /** While a mouse button is down the rendering is frozen, so text never moves under the pointer. */
  pointerDown: boolean;
}

/** Whether the editor has focus; syntax is revealed only in a focused editor. */
export const setLivePreviewFocus = StateEffect.define<boolean>();
const setPointerDown = StateEffect.define<boolean>();

const interactionField = StateField.define<LiveInteraction>({
  create: () => ({ focused: false, pointerDown: false }),
  update(value, transaction) {
    let next = value;
    for (const effect of transaction.effects) {
      if (effect.is(setLivePreviewFocus) && effect.value !== next.focused) next = { ...next, focused: effect.value };
      else if (effect.is(setPointerDown) && effect.value !== next.pointerDown) next = { ...next, pointerDown: effect.value };
    }
    return next;
  },
});

function beginPointerGesture(view: EditorView): void {
  view.dispatch({ effects: setPointerDown.of(true) });
  const end = () => {
    window.removeEventListener('mouseup', end);
    window.removeEventListener('dragend', end);
    window.removeEventListener('blur', end);
    // Bubble phase: selection consumers (for example "add to chat") read the
    // final selection before the syntax around it is revealed.
    if (view.dom.isConnected) view.dispatch({ effects: setPointerDown.of(false) });
  };
  window.addEventListener('mouseup', end);
  window.addEventListener('dragend', end);
  window.addEventListener('blur', end);
}

/**
 * Focus and pointer tracking for the live preview. Kept outside the mode
 * compartment so switching between source and preview keeps the focus state.
 */
export const markdownLiveInteraction: Extension = [
  interactionField,
  EditorView.domEventHandlers({
    focus: (_event, view) => { view.dispatch({ effects: setLivePreviewFocus.of(true) }); },
    blur: (_event, view) => {
      // A window switch keeps the editor as the active element; keep its
      // revealed syntax so the text does not reflow when the app loses focus.
      if (view.root.activeElement !== view.contentDOM) view.dispatch({ effects: setLivePreviewFocus.of(false) });
    },
  }),
];

interface RevealContext {
  focused: boolean;
  heads: readonly number[];
  ranges: readonly SelectionRange[];
}

function revealContext(state: EditorState): RevealContext {
  const focused = state.field(interactionField, false)?.focused ?? false;
  return { focused, heads: state.selection.ranges.map(range => range.head), ranges: state.selection.ranges };
}

/** Inline syntax is revealed only around the caret, never across a whole line or selection. */
const headIn = (reveal: RevealContext, from: number, to: number) => reveal.focused
  && reveal.heads.some(head => head >= from && head <= to);

/** Blocks switch to source while the whole selection is inside them. */
const selectionIn = (reveal: RevealContext, from: number, to: number) => reveal.focused
  && reveal.ranges.some(range => range.from >= from && range.to <= to);

function shouldRebuild(state: EditorState, startState: EditorState, docChanged: boolean, selectionSet: boolean): boolean {
  if (docChanged || syntaxTree(state) !== syntaxTree(startState)) return true;
  const current = state.field(interactionField, false);
  if (current?.pointerDown) return false;
  return selectionSet || current !== startState.field(interactionField, false);
}

// ---------------------------------------------------------------------------
// Block previews (tables, display math, standalone images)
// ---------------------------------------------------------------------------

const DISPLAY_MATH = /^(?:\$\$[\s\S]*\$\$|\\\[[\s\S]*\\\])$/;

function previewKind(state: EditorState, node: SyntaxNodeRef): PreviewBlockKind | null {
  if (node.name === Syntax.Table) return PreviewBlockKind.Table;
  if (node.name !== Syntax.Paragraph) return null;
  // Cheap prefix checks first: this runs for every paragraph on each selection change.
  const head = state.doc.sliceString(node.from, node.from + 2);
  if (head === '$$' || head === '\\[') {
    return DISPLAY_MATH.test(state.doc.sliceString(node.from, node.to).trim()) ? PreviewBlockKind.Math : null;
  }
  if (head !== '![') return null;
  const child = node.node.firstChild;
  return child?.name === Syntax.Image && child.from === node.from && child.to === node.to && !child.nextSibling
    ? PreviewBlockKind.Image : null;
}

function listDepth(node: SyntaxNode): number {
  let depth = 0;
  for (let parent = node.parent; parent; parent = parent.parent) if (parent.name === Syntax.ListItem) depth++;
  return depth;
}

function dedent(source: string, indent: number): string {
  if (!indent) return source;
  const prefix = new RegExp(`^[\\t ]{0,${indent}}`);
  return source.split('\n').map(line => line.replace(prefix, '')).join('\n');
}

interface HiddenRange { from: number; to: number }

interface BlockPreviewState {
  decorations: DecorationSet;
  /** Line-aligned source ranges currently replaced by a rendered block. */
  hidden: readonly HiddenRange[];
}

function buildBlockPreviews(state: EditorState): BlockPreviewState {
  const options = state.facet(previewOptions);
  const reveal = revealContext(state);
  const references = state.field(markdownPreviewReferences);
  const metadataEnd = frontmatterEnd(state);
  const { doc } = state;
  const decorations: Range<Decoration>[] = [];
  const hidden: HiddenRange[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.to <= metadataEnd) return false;
      if (node.name === Syntax.Document || node.name === Syntax.BulletList
        || node.name === Syntax.OrderedList || node.name === Syntax.ListItem) return true;
      const kind = previewKind(state, node);
      if (!kind) return false;
      const first = doc.lineAt(node.from);
      const last = doc.lineAt(node.to);
      // Tables inside quotes keep their source; a widget cannot carry the quote bar.
      if (/\S/.test(doc.sliceString(first.from, node.from))) return false;
      const source = dedent(doc.sliceString(first.from, last.to), node.from - first.from);
      const previewSource = kind === PreviewBlockKind.Math ? source : withMarkdownReferenceDefinitions(source, references);
      const depth = listDepth(node.node);
      if (!selectionIn(reveal, first.from, last.to)) {
        decorations.push(Decoration.replace({
          widget: new PreviewBlockWidget(previewSource, kind, depth, options, false),
          block: true,
        }).range(first.from, last.to));
        hidden.push({ from: first.from, to: last.to });
      } else if (kind !== PreviewBlockKind.Table) {
        decorations.push(Decoration.widget({
          widget: new PreviewBlockWidget(previewSource, kind, depth, options, true),
          block: true,
          side: 1,
        }).range(last.to));
      }
      return false;
    },
  });
  return { decorations: Decoration.set(decorations, true), hidden };
}

// ---------------------------------------------------------------------------
// Line and inline decorations
// ---------------------------------------------------------------------------

interface DecorationContext {
  state: EditorState;
  tree: Tree;
  reveal: RevealContext;
  references: MarkdownPreviewReferences;
  metadataEnd: number;
  hidden: readonly HiddenRange[];
  options: MarkdownPreviewOptions;
  decorations: Range<Decoration>[];
  atomic: Range<Decoration>[];
}

const hiddenDecoration = Decoration.replace({});

function addMark(context: DecorationContext, from: number, to: number, className: string, attributes?: Record<string, string>): void {
  if (from < to) context.decorations.push(Decoration.mark({ class: className, attributes }).range(from, to));
}

function addHidden(context: DecorationContext, from: number, to: number): void {
  if (from < to) context.decorations.push(hiddenDecoration.range(from, to));
}

function addLine(context: DecorationContext, line: Line, className: string, style?: string): void {
  context.decorations.push(Decoration.line({ class: className, attributes: style ? { style } : undefined }).range(line.from));
}

const isInHidden = (context: DecorationContext, from: number, to: number) => context.hidden
  .some(range => from >= range.from && to <= range.to);

const headOnLine = (context: DecorationContext, line: Line) => headIn(context.reveal, line.from, line.to);

function containerOffset(lists: number, quotes: number): string {
  return `calc(${lists} * var(--md-step) + ${quotes} * var(--md-quote-step))`;
}

function decorateLineStructure(context: DecorationContext, line: Line, structure: LineStructure): void {
  let lists = 0;
  let quotes = 0;
  const bars: string[] = [];
  for (const container of structure.containers) {
    if (container === LineContainer.Quote) {
      bars.push(`calc(var(--md-pad) + ${containerOffset(lists, quotes)})`);
      quotes++;
    } else {
      lists++;
    }
  }
  const style = [`--md-indent: ${containerOffset(lists, quotes)}`];
  if (bars.length) {
    style.push(
      `background-image: ${bars.map(() => 'linear-gradient(var(--md-quote-bar), var(--md-quote-bar))').join(', ')}`,
      `background-size: ${bars.map(() => '3px 100%').join(', ')}`,
      `background-position: ${bars.map(bar => `${bar} 0`).join(', ')}`,
      'background-repeat: no-repeat',
    );
  }
  const classes = ['md-block'];
  if (structure.marker) classes.push('md-list-item');
  if (quotes) classes.push('md-quote');
  addLine(context, line, classes.join(' '), style.join('; '));
  if (structure.contentStart <= line.from) return;
  const range = structure.marker
    ? Decoration.replace({ widget: new ListMarkerWidget(structure.marker) }).range(line.from, structure.contentStart)
    : hiddenDecoration.range(line.from, structure.contentStart);
  context.decorations.push(range);
  // The markup is navigated as one unit; the caret never stops inside it.
  context.atomic.push(hiddenDecoration.range(line.from, structure.contentStart));
}

function decorateLines(context: DecorationContext, from: number, to: number): void {
  const { doc } = context.state;
  for (let position = from; position <= to;) {
    const line = doc.lineAt(position);
    if (!isInHidden(context, line.from, line.to)) {
      if (line.from < context.metadataEnd) {
        const first = line.from === 0;
        const last = line.to + 1 >= context.metadataEnd;
        addLine(context, line, `md-frontmatter${first ? ' md-frontmatter-first' : ''}${last ? ' md-frontmatter-last' : ''}`);
      } else {
        const structure = lineStructure(context.state, line, context.tree);
        if (structure) decorateLineStructure(context, line, structure);
      }
    }
    position = line.to + 1;
  }
}

function forEachLine(context: DecorationContext, from: number, to: number, visibleFrom: number, visibleTo: number, callback: (line: Line, first: boolean, last: boolean) => void): void {
  const { doc } = context.state;
  const first = doc.lineAt(from).number;
  const last = doc.lineAt(to).number;
  const start = Math.max(first, doc.lineAt(visibleFrom).number);
  const end = Math.min(last, doc.lineAt(visibleTo).number);
  for (let number = start; number <= end; number++) callback(doc.line(number), number === first, number === last);
}

function decorateAtxHeading(context: DecorationContext, node: SyntaxNode, level: string): void {
  const { doc } = context.state;
  const line = doc.lineAt(node.from);
  addLine(context, line, `md-heading md-h${level}`);
  const active = headOnLine(context, line);
  const open = node.firstChild;
  if (open?.name === Syntax.HeaderMark && open.from === node.from) {
    const end = Math.min(line.to, open.to + (doc.sliceString(open.to, open.to + 1) === ' ' ? 1 : 0));
    // Revealed heading marks hang in the margin, so the heading text never moves.
    if (active) addMark(context, open.from, end, 'md-heading-mark');
    else addHidden(context, open.from, end);
  }
  const close = node.lastChild;
  // Node wrappers are not unique objects; compare positions.
  if (close && close.from !== open?.from && close.name === Syntax.HeaderMark) {
    let start = close.from;
    while (start > (open?.to ?? node.from) && /[\t ]/.test(doc.sliceString(start - 1, start))) start--;
    if (active) addMark(context, close.from, close.to, 'md-syntax');
    else addHidden(context, start, close.to);
  }
}

function decorateSetextHeading(context: DecorationContext, node: SyntaxNode, level: string, visibleFrom: number, visibleTo: number): void {
  const mark = node.lastChild;
  const underline = mark?.name === Syntax.HeaderMark ? context.state.doc.lineAt(mark.from) : null;
  const active = headIn(context.reveal, node.from, node.to);
  forEachLine(context, node.from, node.to, visibleFrom, visibleTo, line => {
    if (underline && line.number === underline.number) addLine(context, line, 'md-setext-mark');
    else addLine(context, line, `md-heading md-h${level}`);
  });
  if (!mark || !underline) return;
  if (active) addMark(context, mark.from, mark.to, 'md-syntax');
  else addHidden(context, mark.from, mark.to);
}

function decorateFencedCode(context: DecorationContext, node: SyntaxNode, visibleFrom: number, visibleTo: number): void {
  const { doc } = context.state;
  const marks = node.getChildren(Syntax.CodeMark);
  const open = marks[0]?.from === node.from ? marks[0] : null;
  const close = marks.length > 1 ? marks[marks.length - 1] : null;
  const closeLine = close ? doc.lineAt(close.from).number : -1;
  forEachLine(context, node.from, node.to, visibleFrom, visibleTo, (line, first, last) => {
    let className = 'md-code';
    if (first) className += ' md-code-first';
    if (last) className += ' md-code-last';
    if ((first && open) || line.number === closeLine) className += ' md-code-fence';
    addLine(context, line, className);
  });
  if (open && open.from >= visibleFrom && open.from <= visibleTo) {
    const line = doc.lineAt(open.from);
    if (headOnLine(context, line)) {
      addMark(context, open.from, line.to, 'md-syntax');
    } else {
      const info = node.getChild(Syntax.CodeInfo);
      const language = info ? /\S*/.exec(doc.sliceString(info.from, info.to))![0] : '';
      context.decorations.push(Decoration.replace({ widget: new CodeFenceWidget(language) }).range(open.from, line.to));
    }
  }
  if (close && close.from >= visibleFrom && close.from <= visibleTo) {
    const line = doc.lineAt(close.from);
    if (headOnLine(context, line)) addMark(context, close.from, line.to, 'md-syntax');
    else addHidden(context, close.from, line.to);
  }
}

function decorateDelimited(context: DecorationContext, node: SyntaxNode, markName: string, className: string): void {
  const marks = node.getChildren(markName);
  const open = marks[0]?.from === node.from ? marks[0] : null;
  const close = marks.length > 1 && marks[marks.length - 1].to === node.to ? marks[marks.length - 1] : null;
  addMark(context, open ? open.to : node.from, close ? close.from : node.to, className);
  const active = headIn(context.reveal, node.from, node.to);
  for (const mark of [open, close]) {
    if (!mark) continue;
    if (active) addMark(context, mark.from, mark.to, 'md-syntax');
    else addHidden(context, mark.from, mark.to);
  }
}

function linkTitle(title: string | null | undefined, href: string): string {
  const hint = t(isMacPlatform() ? 'markdownEditorOpenLinkHintMac' : 'markdownEditorOpenLinkHint');
  return [title, href, hint].filter(Boolean).join('\n');
}

function decorateLink(context: DecorationContext, node: SyntaxNode): void {
  const link = context.references.links.get(node.from);
  if (!link || link.to !== node.to) return;
  const marks = node.getChildren(Syntax.LinkMark);
  const open = marks[0];
  const textEnd = marks[1];
  if (!open || !textEnd) return;
  const href = safeUrlTransform(link.url);
  addMark(context, open.to, textEnd.from, 'md-link', { 'data-md-href': href, title: linkTitle(link.title, href) });
  if (headIn(context.reveal, node.from, node.to)) {
    addMark(context, open.from, open.to, 'md-syntax');
    addMark(context, textEnd.from, node.to, 'md-syntax');
  } else {
    addHidden(context, open.from, open.to);
    addHidden(context, textEnd.from, node.to);
  }
}

function decorateImage(context: DecorationContext, node: SyntaxNode): void {
  if (headIn(context.reveal, node.from, node.to)) {
    addMark(context, node.from, node.to, 'md-syntax');
    return;
  }
  const target = context.references.links.get(node.from);
  const url = target?.to === node.to ? safeUrlTransform(target.url) : '';
  const marks = node.getChildren(Syntax.LinkMark);
  const alt = marks.length > 1 ? context.state.doc.sliceString(marks[0].to, marks[1].from) : '';
  const src = url ? resolveMarkdownImageSrc(url, alt, context.options.resolveLocalFilePath) : undefined;
  if (!src) return;
  context.decorations.push(Decoration.replace({ widget: new InlineImageWidget(src, alt) }).range(node.from, node.to));
}

function urlHref(text: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return safeUrlTransform(text);
  if (/^www\./i.test(text)) return `https://${text}`;
  return /^[^\s@]+@[^\s@]+$/.test(text) ? `mailto:${text}` : safeUrlTransform(text);
}

function decorateAutolink(context: DecorationContext, node: SyntaxNode): void {
  const url = node.getChild(Syntax.Url);
  if (!url) return;
  const href = urlHref(context.state.doc.sliceString(url.from, url.to));
  addMark(context, url.from, url.to, 'md-link', { 'data-md-href': href, title: linkTitle(null, href) });
  const active = headIn(context.reveal, node.from, node.to);
  for (const mark of node.getChildren(Syntax.LinkMark)) {
    if (active) addMark(context, mark.from, mark.to, 'md-syntax');
    else addHidden(context, mark.from, mark.to);
  }
}

function decorateNodes(context: DecorationContext, from: number, to: number): void {
  const { doc } = context.state;
  context.tree.iterate({
    from,
    to,
    enter: ref => {
      if (ref.to <= context.metadataEnd || isInHidden(context, ref.from, ref.to)) return false;
      const node = ref.node;
      const atx = /^ATXHeading([1-6])$/.exec(ref.name);
      if (atx) {
        decorateAtxHeading(context, node, atx[1]);
        return true;
      }
      const setext = /^SetextHeading([12])$/.exec(ref.name);
      if (setext) {
        decorateSetextHeading(context, node, setext[1], from, to);
        return true;
      }
      const active = () => headIn(context.reveal, ref.from, ref.to);
      switch (ref.name) {
        case Syntax.FencedCode:
          decorateFencedCode(context, node, from, to);
          return false;
        case Syntax.CodeBlock:
          forEachLine(context, ref.from, ref.to, from, to, (line, first, last) => {
            addLine(context, line, `md-code${first ? ' md-code-first' : ''}${last ? ' md-code-last' : ''}`);
          });
          return false;
        case Syntax.Table:
          forEachLine(context, ref.from, ref.to, from, to, line => addLine(context, line, 'md-table-source'));
          return false;
        case Syntax.Paragraph:
          if (previewKind(context.state, ref) === PreviewBlockKind.Math) {
            forEachLine(context, ref.from, ref.to, from, to, line => addLine(context, line, 'md-math-source'));
            return false;
          }
          return true;
        case Syntax.HtmlBlock:
        case Syntax.CommentBlock:
          forEachLine(context, ref.from, ref.to, from, to, line => addLine(context, line, 'md-html'));
          return false;
        case Syntax.Rule: {
          const line = doc.lineAt(ref.from);
          const revealed = headOnLine(context, line);
          addLine(context, line, revealed ? 'md-hr md-hr-revealed' : 'md-hr');
          if (revealed) addMark(context, ref.from, ref.to, 'md-syntax');
          else addHidden(context, ref.from, ref.to);
          return false;
        }
        case Syntax.Comment:
          addMark(context, ref.from, ref.to, 'md-html');
          return false;
        case Syntax.LinkReference:
          // Definitions do not appear in rendered Markdown; show them as muted source.
          addMark(context, ref.from, ref.to, 'md-syntax');
          return false;
        case Syntax.Strong:
          decorateDelimited(context, node, Syntax.EmphasisMark, 'md-strong');
          return true;
        case Syntax.Emphasis:
          decorateDelimited(context, node, Syntax.EmphasisMark, 'md-emphasis');
          return true;
        case Syntax.Strike:
          decorateDelimited(context, node, Syntax.StrikeMark, 'md-strike');
          return true;
        case Syntax.InlineCode:
          decorateDelimited(context, node, Syntax.CodeMark, 'md-inline-code');
          return false;
        case Syntax.Link:
          decorateLink(context, node);
          return true;
        case Syntax.LinkMark:
        case Syntax.LinkTitle:
        case Syntax.LinkLabel:
          return false;
        case Syntax.Image:
          decorateImage(context, node);
          return false;
        case Syntax.Autolink:
          decorateAutolink(context, node);
          return false;
        case Syntax.Url: {
          // A bare GFM URL. Link and image destinations are handled by their parent.
          const parent = node.parent?.name;
          if (parent === Syntax.Link || parent === Syntax.Image || parent === Syntax.Autolink) return false;
          const href = urlHref(doc.sliceString(ref.from, ref.to));
          addMark(context, ref.from, ref.to, 'md-link', { 'data-md-href': href, title: linkTitle(null, href) });
          return false;
        }
        case Syntax.Math:
          if (active()) addMark(context, ref.from, ref.to, 'md-math-source');
          else context.decorations.push(Decoration.replace({ widget: new InlineMathWidget(doc.sliceString(ref.from, ref.to)) }).range(ref.from, ref.to));
          return false;
        case Syntax.Escape:
          if (!active()) addHidden(context, ref.from, ref.from + 1);
          return false;
        case Syntax.Entity:
          if (!active()) context.decorations.push(Decoration.replace({ widget: new EntityWidget(doc.sliceString(ref.from, ref.to)) }).range(ref.from, ref.to));
          return false;
        case Syntax.HardBreak:
          if (!active()) addHidden(context, ref.from, doc.sliceString(ref.to - 1, ref.to) === '\n' ? ref.to - 1 : ref.to);
          return false;
        case Syntax.HtmlTag:
          if (isMarkdownHtmlBreak(doc.sliceString(ref.from, ref.to))) {
            if (!active()) context.decorations.push(Decoration.replace({ widget: new LineBreakWidget() }).range(ref.from, ref.to));
          } else {
            addMark(context, ref.from, ref.to, 'md-html');
          }
          return false;
        default:
          return undefined;
      }
    },
  });
}

export interface LivePreviewDecorations {
  decorations: DecorationSet;
  /** Hidden container markup, navigated as a unit. */
  atomic: DecorationSet;
}

/** Line and inline rendering for the given document ranges (the viewport in the editor). */
export function buildLivePreviewDecorations(
  state: EditorState,
  ranges: readonly { from: number; to: number }[] = [{ from: 0, to: state.doc.length }],
): LivePreviewDecorations {
  const context: DecorationContext = {
    state,
    tree: syntaxTree(state),
    reveal: revealContext(state),
    references: state.field(markdownPreviewReferences),
    metadataEnd: frontmatterEnd(state),
    hidden: state.field(blockPreviewField, false)?.hidden ?? [],
    options: state.facet(previewOptions),
    decorations: [],
    atomic: [],
  };
  for (const { from, to } of ranges) {
    decorateLines(context, from, to);
    decorateNodes(context, from, to);
  }
  return { decorations: Decoration.set(context.decorations, true), atomic: Decoration.set(context.atomic, true) };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const blockPreviewField: StateField<BlockPreviewState> = StateField.define<BlockPreviewState>({
  create: buildBlockPreviews,
  update: (value, transaction) => (
    shouldRebuild(transaction.state, transaction.startState, transaction.docChanged, Boolean(transaction.selection))
      ? buildBlockPreviews(transaction.state) : value
  ),
  // Block widgets change the vertical layout, so they must come from state, not a view plugin.
  provide: field => EditorView.decorations.from(field, value => value.decorations),
});

const livePreviewPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  atomic: DecorationSet;

  constructor(view: EditorView) {
    ({ decorations: this.decorations, atomic: this.atomic } = buildLivePreviewDecorations(view.state, view.visibleRanges));
  }

  update(update: ViewUpdate) {
    if (update.viewportChanged || shouldRebuild(update.state, update.startState, update.docChanged, update.selectionSet)) {
      ({ decorations: this.decorations, atomic: this.atomic } = buildLivePreviewDecorations(update.state, update.view.visibleRanges));
    }
  }
}, {
  decorations: value => value.decorations,
  provide: plugin => EditorView.atomicRanges.of(view => view.plugin(plugin)?.atomic ?? Decoration.none),
});

function frontmatterLines(view: EditorView): DecorationSet {
  const end = frontmatterEnd(view.state);
  if (!end) return Decoration.none;
  const decorations: Range<Decoration>[] = [];
  for (let position = 0; position < end && position <= view.state.doc.length;) {
    const line = view.state.doc.lineAt(position);
    decorations.push(Decoration.line({ class: 'md-frontmatter-source' }).range(line.from));
    position = line.to + 1;
  }
  return Decoration.set(decorations);
}

/**
 * The Markdown parser reads YAML front matter as a rule and a heading. Keep
 * it plain in the source view instead of highlighting it as Markdown.
 */
export const markdownSourceFrontmatter = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = frontmatterLines(view); }
  update(update: ViewUpdate) {
    if (update.docChanged) this.decorations = frontmatterLines(update.view);
  }
}, { decorations: value => value.decorations });

/** Keep an empty caret out of hidden list and quote markup (Home, vertical motion, clicks in the margin). */
const keepCaretOutOfMarkup = EditorState.transactionFilter.of(transaction => {
  if (!transaction.selection) return transaction;
  const { state } = transaction;
  let moved = false;
  const ranges = state.selection.ranges.map(range => {
    if (!range.empty) return range;
    const line = state.doc.lineAt(range.head);
    if (range.head === line.to) return range;
    const structure = lineStructure(state, line);
    if (!structure || range.head >= structure.contentStart) return range;
    moved = true;
    return EditorSelection.cursor(structure.contentStart, 1);
  });
  return moved
    ? [transaction, { selection: EditorSelection.create(ranges, state.selection.mainIndex), sequential: true }]
    : transaction;
});

/** Rendering is a view over the original Markdown. Decorations never rewrite the document. */
export function markdownLivePreview(options: MarkdownPreviewOptions): Extension {
  return [
    previewOptions.of(options),
    markdownPreviewReferences,
    markdownLiveInteraction,
    blockPreviewField,
    livePreviewPlugin,
    keepCaretOutOfMarkup,
    EditorView.domEventHandlers({
      mousedown: (event, view) => {
        const href = (event.target as Element).closest?.('[data-md-href]')?.getAttribute('data-md-href');
        if (href !== undefined && href !== null && (event.metaKey || event.ctrlKey)) {
          // Handled on click; keep the modified click from adding a cursor.
          event.preventDefault();
          return true;
        }
        if (event.button === 0) beginPointerGesture(view);
        return false;
      },
      click: (event, view) => {
        const href = (event.target as Element).closest?.('[data-md-href]')?.getAttribute('data-md-href');
        if (!href || (!event.metaKey && !event.ctrlKey)) return false;
        event.preventDefault();
        openMarkdownHref(href, options);
        view.focus();
        return true;
      },
      keydown: (event, view) => {
        if (event.key === 'Meta' || event.key === 'Control') view.dom.classList.add('md-modifier-pressed');
        return false;
      },
      keyup: (event, view) => {
        if (event.key === 'Meta' || event.key === 'Control') view.dom.classList.remove('md-modifier-pressed');
        return false;
      },
      blur: (_event, view) => {
        view.dom.classList.remove('md-modifier-pressed');
        return false;
      },
    }),
  ];
}
