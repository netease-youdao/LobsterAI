import { StateField } from '@codemirror/state';
import { type ChangedRange, type SyntaxNode, type Tree, TreeFragment } from '@lezer/common';
import { GFM, type MarkdownConfig, parser as lezerParser } from '@lezer/markdown';
import { normalizeIdentifier } from 'micromark-util-normalize-identifier';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

const Syntax = {
  Definition: 'LinkReference', Link: 'Link', Image: 'Image', LinkLabel: 'LinkLabel', LinkMark: 'LinkMark',
  LinkTitle: 'LinkTitle', Quote: 'Blockquote', QuoteMark: 'QuoteMark', Paragraph: 'Paragraph',
  Math: 'PreviewMathBlock', MathContent: 'PreviewMathContent', MathFence: 'PreviewMathFence',
} as const;
const MarkdownNode = { Definition: 'definition', Link: 'link', Image: 'image' } as const;
const LinkTargetKind = { Reference: 'reference', Explicit: 'explicit' } as const;

const parser = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkMath);
// A composite block lets the existing list/quote parsers end the math context
// correctly. Its content stays opaque, including blank lines and fake references.
const mathBlocks: MarkdownConfig = {
  defineNodes: [Syntax.MathContent, Syntax.MathFence, {
    name: Syntax.Math,
    composite(cx, line, size) {
      const closing = /^(\${2,})[\t ]*$/.exec(line.text.slice(line.pos));
      if (line.indent - line.baseIndent < 4 && closing && closing[1].length >= size) {
        line.addMarker(cx.elt(Syntax.MathFence, cx.lineStart + line.pos, cx.lineStart + line.text.length));
        line.moveBase(line.text.length);
        return false;
      }
      return true;
    },
  }],
  parseBlock: [{
    name: Syntax.Math,
    before: Syntax.Definition,
    parse(cx, line) {
      const from = cx.lineStart + line.pos;
      if (cx.parentType().name === Syntax.Math) {
        cx.addElement(cx.elt(Syntax.MathContent, from, cx.lineStart + line.text.length));
        cx.nextLine();
        return true;
      }
      const opening = /^(\${2,})[^$]*$/.exec(line.text.slice(line.pos));
      if (line.indent - line.baseIndent >= 4 || !opening) return false;
      cx.startComposite(Syntax.Math, line.pos, opening[1].length);
      line.addMarker(cx.elt(Syntax.MathFence, from, cx.lineStart + line.text.length));
      line.moveBase(line.text.length);
      return null;
    },
    endLeaf: (_cx, line) => line.indent - line.baseIndent < 4 && /^(\${2,})[^$]*$/.test(line.text.slice(line.pos)),
  }],
};
const incrementalParser = lezerParser.configure([GFM, mathBlocks]);
type Content = ReturnType<typeof parser.parse>['children'][number];
type Definition = Extract<Content, { type: 'definition' }>;
type Phrasing = Extract<Content, { type: 'paragraph' }>['children'][number];
type ExplicitLink = Extract<Phrasing, { type: 'link' | 'image' }>;
type LinkTarget = { kind: typeof LinkTargetKind.Reference; identifier: string }
  | { kind: typeof LinkTargetKind.Explicit; url: string; title?: string | null };

interface MarkdownPreviewLink {
  to: number;
  url: string;
  title?: string | null;
}

export interface MarkdownPreviewReferences {
  definitions: string;
  links: ReadonlyMap<number, MarkdownPreviewLink>;
}

interface ReferenceState extends MarkdownPreviewReferences {
  tree: Tree;
  definitionCache: ReadonlyMap<string, readonly Definition[]>;
  linkCache: ReadonlyMap<string, LinkTarget | undefined>;
}

// Remark has already decoded destinations and titles. Encode them for a new
// display-only definition without changing their values when parsed again.
const escapeDefinitionValue = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/\\/g, '\\\\')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/\n/g, '&#10;')
  .replace(/\r/g, '&#13;');

function stripQuotePrefixes(fragment: string, node: SyntaxNode): string {
  if (!fragment.includes('\n')) return fragment;
  let quoteDepth = 0;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name === Syntax.Quote) quoteDepth++;
  }
  if (!quoteDepth) return fragment;
  return fragment.split('\n').map((line, index) => {
    if (!index) return line;
    for (let depth = 0; depth < quoteDepth; depth++) line = line.replace(/^[\t ]*>[\t ]?/, '');
    return line;
  }).join('\n');
}

function getDefinitionSource(source: string, node: SyntaxNode): string {
  let end = node.to;
  // Lezer finishes a definition before a title that starts on the following
  // line and spans multiple lines. Let Remark parse that adjacent paragraph too.
  let next = node.nextSibling;
  while (next?.name === Syntax.QuoteMark) next = next.nextSibling;
  if (!node.getChild(Syntax.LinkTitle) && next?.name === Syntax.Paragraph
    && !/\n[\t >]*\n/.test(source.slice(end, next.from))
    && /^["'(]/.test(source.slice(next.from, next.from + 1))) end = next.to;
  return stripQuotePrefixes(source.slice(node.from, end), node);
}

function getDefinitionEnd(source: string, node: SyntaxNode, definition: Definition): number {
  const position = definition.position?.end;
  if (!position) return node.to;
  let lineStart = node.from;
  for (let line = 1; line < position.line; line++) lineStart = source.indexOf('\n', lineStart) + 1;
  const nextLine = source.indexOf('\n', lineStart);
  const rawLine = source.slice(lineStart, nextLine < 0 ? source.length : nextLine);
  const prefixLength = position.line === 1 ? 0
    : rawLine.length - stripQuotePrefixes(`\n${rawLine}`, node).slice(1).length;
  return lineStart + prefixLength + position.column - 1;
}

function getLinkTarget(source: string, node: SyntaxNode): LinkTarget | undefined {
  const marks = node.getChildren(Syntax.LinkMark);
  if (marks.length > 2) {
    // Parse each distinct explicit link once for empty destinations and escapes.
    const paragraph = parser.parse(stripQuotePrefixes(source.slice(node.from, node.to), node)).children[0];
    const link = paragraph && 'children' in paragraph
      ? paragraph.children.find(child => child.type === MarkdownNode.Link || child.type === MarkdownNode.Image) as ExplicitLink | undefined
      : undefined;
    return link ? { kind: LinkTargetKind.Explicit, url: link.url, title: link.title } : undefined;
  }
  if (marks.length !== 2) return undefined;
  const label = node.getChild(Syntax.LinkLabel);
  const identifier = label && label.to - label.from > 2
    ? source.slice(label.from + 1, label.to - 1) : source.slice(marks[0].to, marks[1].from);
  return { kind: LinkTargetKind.Reference, identifier: normalizeIdentifier(stripQuotePrefixes(identifier, node)).toLowerCase() };
}

function parseReferences(source: string, tree: Tree, previous?: ReferenceState): ReferenceState {
  const definitions = new Map<string, Definition>();
  const definitionCache = new Map<string, readonly Definition[]>();
  const linkCache = new Map<string, LinkTarget | undefined>();
  const linkNodes: SyntaxNode[] = [];
  let definitionEnd = 0;
  const metadataEnd = source.match(/^\uFEFF?---\n[\s\S]*?\n(?:---|\.\.\.)(?:\n|$)/)?.[0].length ?? 0;
  tree.iterate({
    enter(ref) {
      if (ref.to <= metadataEnd) return false;
      // Lezer is deliberately permissive about links but misses a few valid
      // definitions (for example an escaped > in an angled destination).
      const possibleDefinition = ref.name === Syntax.Paragraph && source[ref.from] === '['
        && /^\[[\s\S]{0,999}\]:/.test(source.slice(ref.from, Math.min(ref.to, ref.from + 1002)));
      if (ref.name === Syntax.Definition || possibleDefinition) {
        const fragment = getDefinitionSource(source, ref.node);
        const parsed = definitionCache.get(fragment) ?? previous?.definitionCache.get(fragment)
          ?? parser.parse(fragment).children.filter(child => child.type === MarkdownNode.Definition) as Definition[];
        definitionCache.set(fragment, parsed);
        for (const definition of parsed) {
          if (!definitions.has(definition.identifier)) definitions.set(definition.identifier, definition);
        }
        if (parsed.length) {
          if (ref.name === Syntax.Definition) return false;
          // A permissive Lezer paragraph can contain both a definition it did
          // not recognize and following prose. Exclude only the definitions.
          definitionEnd = getDefinitionEnd(source, ref.node, parsed[parsed.length - 1]);
        }
      }
      if ((ref.name === Syntax.Link || ref.name === Syntax.Image) && ref.from >= definitionEnd) linkNodes.push(ref.node);
    },
  });

  const links = new Map<number, MarkdownPreviewLink>();
  for (const node of linkNodes) {
    const fragment = stripQuotePrefixes(source.slice(node.from, node.to), node);
    let target: LinkTarget | undefined;
    if (linkCache.has(fragment)) target = linkCache.get(fragment);
    else {
      target = previous?.linkCache.has(fragment) ? previous.linkCache.get(fragment) : getLinkTarget(source, node);
      linkCache.set(fragment, target);
    }
    const destination = target?.kind === LinkTargetKind.Reference ? definitions.get(target.identifier) : target;
    if (destination) links.set(node.from, { to: node.to, url: destination.url, title: destination.title });
  }

  return {
    tree,
    definitionCache,
    linkCache,
    // Identifiers retain Markdown escapes and are already normalized by Remark.
    definitions: [...definitions.values()].map(definition => (
      `[${definition.identifier}]: <${escapeDefinitionValue(definition.url)}>`
      + (definition.title == null ? '' : ` "${escapeDefinitionValue(definition.title)}"`)
    )).join('\n'),
    links,
  };
}

/** Keep a complete incremental tree so definitions beyond the viewport are ready immediately. */
export const markdownPreviewReferences = StateField.define<ReferenceState>({
  create(state) {
    const source = state.doc.toString();
    return parseReferences(source, incrementalParser.parse(source));
  },
  update(value, transaction) {
    if (!transaction.docChanged) return value;
    const changes: ChangedRange[] = [];
    transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => { changes.push({ fromA, toA, fromB, toB }); });
    const fragments = TreeFragment.applyChanges(TreeFragment.addTree(value.tree), changes);
    const source = transaction.newDoc.toString();
    return parseReferences(source, incrementalParser.parse(source, fragments), value);
  },
});

export const withMarkdownReferenceDefinitions = (source: string, references: MarkdownPreviewReferences): string => (
  references.definitions ? `${source}\n\n${references.definitions}` : source
);
