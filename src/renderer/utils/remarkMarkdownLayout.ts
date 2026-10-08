import type { Content, Root } from 'mdast';

const NodeType = { Text: 'text', Html: 'html', Break: 'break' } as const;

export const isMarkdownHtmlBreak = (value: string): boolean => /^<br\s*\/?>$/i.test(value.trim());

/** Preserve authored line breaks without changing code, math, or Markdown structure. */
export function remarkMarkdownLayout() {
  return (tree: Root): void => {
    const visit = (node: Root | Content): void => {
      if (!('children' in node)) return;
      const parent = node as { children: Content[] };
      const children: Content[] = [];
      for (const child of parent.children) {
        if (child.type === NodeType.Text && /[\r\n]/.test(child.value)) {
          const lines = child.value.split(/\r\n|\r|\n/);
          for (const [lineIndex, value] of lines.entries()) {
            if (lineIndex) children.push({ type: NodeType.Break });
            if (value) children.push({ type: NodeType.Text, value });
          }
        } else if (child.type === NodeType.Html && isMarkdownHtmlBreak(child.value)) {
          // A common table-cell convention. Do not enable raw HTML or attributes.
          children.push({ type: NodeType.Break });
        } else {
          visit(child);
          children.push(child);
        }
      }
      parent.children = children;
    };
    visit(tree);
  };
}
