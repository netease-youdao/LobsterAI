import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

interface SpeechNode {
  type: string;
  value?: string;
  url?: string;
  children?: SpeechNode[];
}

const NodeType = {
  Code: 'code', Html: 'html', Image: 'image', ImageReference: 'imageReference', Definition: 'definition',
  FootnoteDefinition: 'footnoteDefinition', FootnoteReference: 'footnoteReference', Text: 'text',
  InlineCode: 'inlineCode', Math: 'math', InlineMath: 'inlineMath', Break: 'break', Link: 'link',
  Root: 'root', Blockquote: 'blockquote', List: 'list', ListItem: 'listItem', Table: 'table', TableRow: 'tableRow',
} as const;

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

const textOf = (node: SpeechNode): string => {
  switch (node.type) {
    case NodeType.Code:
    case NodeType.Html:
    case NodeType.Image:
    case NodeType.ImageReference:
    case NodeType.Definition:
    case NodeType.FootnoteDefinition:
    case NodeType.FootnoteReference:
      return '';
    case NodeType.Text:
    case NodeType.InlineCode:
    case NodeType.Math:
    case NodeType.InlineMath:
      return node.value ?? '';
    case NodeType.Break:
      return '\n';
    case NodeType.Link: {
      const label = node.children?.map(textOf).join('') ?? '';
      return label === node.url && /^(?:https?:|file:|mailto:)/i.test(label) ? '' : label;
    }
    case NodeType.Root:
    case NodeType.Blockquote:
    case NodeType.List:
    case NodeType.ListItem:
    case NodeType.Table:
      return node.children?.map(textOf).filter(Boolean).join('\n') ?? '';
    case NodeType.TableRow:
      return node.children?.map(textOf).filter(Boolean).join(', ') ?? '';
    default:
      return node.children?.map(textOf).join('') ?? '';
  }
};

/** Read answer prose, preserving link labels and inline identifiers without reading code or media. */
export function getMessageSpeechText(markdown: string): string {
  return textOf(parser.parse(markdown) as SpeechNode)
    .replace(/[\t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
