import type { Content, Paragraph, Parent, PhrasingContent, Root } from 'mdast';
import type { Processor } from 'unified';

export const DetailsTag = {
  Details: 'details',
  Summary: 'summary',
} as const;
export type DetailsTag = typeof DetailsTag[keyof typeof DetailsTag];

const DETAILS_NODE_TYPE = 'details';
const DETAILS_TAG_PATTERN = /<(\/?)(details|summary)\b([^>]*)>/gi;
const DETAILS_HTML_START = /^\s*<\/?(?:details|summary)\b/i;
const OPEN_ATTRIBUTE = /(?:^|\s)open(?:\s|=|\/|$)/i;
const HTML_TAG_ONLY = /^<\/?[A-Za-z][\w-]*(?:\s[^>]*)?\/?>$/;
const PHRASING_TYPES = new Set([
  'text', 'emphasis', 'strong', 'delete', 'inlineCode', 'break', 'link', 'linkReference',
  'image', 'imageReference', 'footnoteReference', 'inlineMath',
]);

type DetailsToken =
  | { kind: 'open'; tag: DetailsTag; open: boolean }
  | { kind: 'close'; tag: DetailsTag }
  | { kind: 'text'; value: string };

interface DetailsNode extends Parent {
  type: typeof DETAILS_NODE_TYPE;
}

interface OpenDetails {
  node: DetailsNode;
  summary: Paragraph | null;
  inSummary: boolean;
}

const isDetailsHtml = (node: Content): boolean => (
  node.type === 'html' && DETAILS_HTML_START.test(node.value)
);

const tokenizeDetailsHtml = (value: string): DetailsToken[] => {
  const tokens: DetailsToken[] = [];
  let cursor = 0;
  for (const match of value.matchAll(DETAILS_TAG_PATTERN)) {
    const text = value.slice(cursor, match.index);
    if (text.trim()) tokens.push({ kind: 'text', value: text });
    const tag = match[2].toLowerCase() as DetailsTag;
    tokens.push(match[1]
      ? { kind: 'close', tag }
      : { kind: 'open', tag, open: tag === DetailsTag.Details && OPEN_ATTRIBUTE.test(match[3]) });
    cursor = (match.index ?? 0) + match[0].length;
  }
  const rest = value.slice(cursor);
  if (rest.trim()) tokens.push({ kind: 'text', value: rest });
  return tokens;
};

/** Lines swallowed by an HTML block keep their indentation; strip it so they do not become code. */
const dedent = (text: string): string => {
  const lines = text.replace(/^\s*\n|\n\s*$/g, '').split('\n');
  const indents = lines.filter(line => line.trim()).map(line => /^[ \t]*/.exec(line)?.[0].length ?? 0);
  const indent = indents.length ? Math.min(...indents) : 0;
  return lines.map(line => line.slice(Math.min(indent, /^[ \t]*/.exec(line)?.[0].length ?? 0))).join('\n');
};

const toSummaryPhrasing = (nodes: Content[]): PhrasingContent[] => {
  const result: PhrasingContent[] = [];
  for (const node of nodes) {
    if (node.type === 'html') {
      // Formatting tags such as <b> inside <summary> are dropped; their text is kept.
      if (!HTML_TAG_ONLY.test(node.value.trim())) result.push({ type: 'text', value: node.value });
    } else if (PHRASING_TYPES.has(node.type)) {
      result.push(node as PhrasingContent);
    } else if ('children' in node) {
      if (result.length) result.push({ type: 'text', value: ' ' });
      result.push(...toSummaryPhrasing(node.children as Content[]));
    } else if ('value' in node) {
      result.push({ type: 'text', value: node.value });
    }
  }
  return result;
};

/**
 * Render `<details>`/`<summary>` as collapsible blocks while raw HTML stays
 * disabled. Only these two tags are recognized, and `open` is the only
 * attribute carried over; Markdown between the tags is parsed normally.
 */
export function remarkDetailsBlocks(this: Processor) {
  const parseMarkdown = (text: string): Content[] => (this.parse(text) as Root).children;

  const transformChildren = (children: Content[]): Content[] => {
    if (!children.some(isDetailsHtml)) return children;

    const output: Content[] = [];
    const stack: OpenDetails[] = [];

    const appendToSummary = (current: OpenDetails, nodes: Content[]): void => {
      const phrasing = toSummaryPhrasing(nodes);
      if (!current.summary) {
        current.summary = { type: 'paragraph', children: [], data: { hName: DetailsTag.Summary } };
      } else if (current.summary.children.length && phrasing.length) {
        current.summary.children.push({ type: 'text', value: ' ' });
      }
      current.summary.children.push(...phrasing);
    };

    const append = (nodes: Content[], fromSummaryTag = false): void => {
      const current = stack[stack.length - 1];
      if (!current) {
        output.push(...nodes);
        return;
      }
      if (current.inSummary) {
        // A summary written across blank lines may span paragraphs, but any
        // other block means the closing tag was omitted.
        if (fromSummaryTag || nodes.every(node => node.type === 'paragraph' || node.type === 'heading')) {
          appendToSummary(current, nodes);
          return;
        }
        current.inSummary = false;
      }
      current.node.children.push(...nodes);
    };

    const closeDetails = (): void => {
      const finished = stack.pop();
      if (!finished) return;
      finished.node.children.unshift(finished.summary
        ?? { type: 'paragraph', children: [], data: { hName: DetailsTag.Summary } });
      append([finished.node as unknown as Content]);
    };

    for (const child of children) {
      if (!isDetailsHtml(child) || child.type !== 'html') {
        append([child]);
        continue;
      }
      for (const token of tokenizeDetailsHtml(child.value)) {
        const current = stack[stack.length - 1];
        if (token.kind === 'text') {
          if (current?.inSummary) {
            append(parseMarkdown(token.value.trim()), true);
          } else {
            append(parseMarkdown(dedent(token.value)));
          }
        } else if (token.tag === DetailsTag.Details) {
          if (token.kind === 'close') {
            closeDetails();
          } else {
            if (current) current.inSummary = false;
            stack.push({
              node: {
                type: DETAILS_NODE_TYPE,
                children: [],
                data: { hName: DetailsTag.Details, hProperties: token.open ? { open: true } : {} },
              },
              summary: null,
              inSummary: false,
            });
          }
        } else if (current) {
          // Browsers use the first <summary> only; later ones fall through as body text.
          current.inSummary = token.kind === 'open' && !current.summary;
        }
      }
    }
    while (stack.length) closeDetails();
    return output;
  };

  const visit = (node: Root | Content): void => {
    if (!('children' in node)) return;
    const parent = node as { children: Content[] };
    for (const child of parent.children) visit(child);
    parent.children = transformChildren(parent.children);
  };

  return (tree: Root): void => visit(tree);
}
