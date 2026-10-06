import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** The part of an mdast node the progress plugin reads and rewrites. */
interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: { hName?: string; hProperties?: Record<string, string | number> };
}

const PROGRESS_ELEMENT_RE = /^<progress\s+([^>]*)>(?:\s*<\/progress>)?\s*$/i;
const HTML_ATTRIBUTE_RE = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * The progress_card tool documents one piece of raw HTML, `<progress value
 * max>`, for long operations. Turn exactly that into a real progress element
 * with validated numbers; every other raw HTML node is still skipped.
 */
const remarkProgress = () => (tree: MarkdownNode) => {
  const visit = (node: MarkdownNode) => {
    const match = node.type === 'html' && node.value ? PROGRESS_ELEMENT_RE.exec(node.value.trim()) : null;
    if (match) {
      const attributes: Record<string, string> = {};
      for (const attribute of match[1].matchAll(HTML_ATTRIBUTE_RE)) {
        attributes[attribute[1].toLowerCase()] = attribute[2] ?? attribute[3];
      }
      const value = Number(attributes.value);
      const max = Number(attributes.max);
      if (attributes.value !== undefined && attributes.max !== undefined
        && Number.isFinite(value) && Number.isFinite(max) && max > 0 && value >= 0 && value <= max) {
        node.type = 'paragraph';
        node.value = undefined;
        node.children = [];
        node.data = {
          hName: 'progress',
          hProperties: { value, max, 'aria-label': attributes['aria-label'] || `${value}/${max}` },
        };
      }
    }
    node.children?.forEach(visit);
  };
  visit(tree);
};

/**
 * OpenClaw renders card markdown with single newlines as line breaks
 * (markdown-it `breaks: true`), and agents write their notes for that:
 * "已完成：…\n进行中：…". Split text on newlines into break nodes to match.
 */
const remarkSoftBreaks = () => (tree: MarkdownNode) => {
  const visit = (node: MarkdownNode) => {
    if (!node.children) return;
    node.children = node.children.flatMap((child): MarkdownNode[] => {
      if (child.type !== 'text' || !child.value?.includes('\n')) {
        visit(child);
        return [child];
      }
      return child.value.split(/\r?\n/).flatMap((part, index): MarkdownNode[] => (
        index === 0 ? [{ type: 'text', value: part }] : [{ type: 'break' }, { type: 'text', value: part }]
      ));
    });
  };
  visit(tree);
};

const isWebLink = (href: string | undefined): href is string => Boolean(href && /^https?:\/\//i.test(href));

/**
 * A progress card's note: agent-written markdown rendered without raw HTML
 * (bar the validated progress element) and without remote images, with
 * links opened in the system browser only when they are http(s).
 */
const ProgressCardMarkdown: React.FC<{ content: string }> = ({ content }) => (
  <div className="text-xs leading-5 text-secondary [&_a]:text-primary [&_a]:underline [&_code]:font-mono [&_h1]:font-semibold [&_h1]:text-foreground [&_h2]:font-semibold [&_h2]:text-foreground [&_h3]:font-semibold [&_h3]:text-foreground [&_ol]:list-decimal [&_ol]:pl-4 [&_p]:my-1 [&_progress]:my-1 [&_progress]:h-1.5 [&_progress]:w-full [&_progress]:accent-primary [&_strong]:font-semibold [&_strong]:text-foreground [&_table]:my-1 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-1.5 [&_th]:border [&_th]:border-border [&_th]:px-1.5 [&_th]:text-left [&_ul]:list-disc [&_ul]:pl-4">
    <ReactMarkdown
      skipHtml
      remarkPlugins={[remarkGfm, remarkProgress, remarkSoftBreaks]}
      components={{
        img: ({ alt }) => <span>{alt}</span>,
        a: ({ href, children }) => (
          <a
            href={isWebLink(href) ? href : undefined}
            onClick={(event) => {
              event.preventDefault();
              if (isWebLink(href)) void window.electron.shell.openExternal(href);
            }}
          >
            {children}
          </a>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  </div>
);

export default ProgressCardMarkdown;
