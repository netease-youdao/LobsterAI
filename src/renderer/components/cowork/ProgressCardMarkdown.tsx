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

const NOTE_CLASS = [
  'text-xs leading-5 text-secondary',
  '[&>:first-child]:mt-0 [&>:last-child]:mb-0 [&_p]:my-1',
  '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_code]:font-mono',
  '[&_h1]:font-medium [&_h1]:text-foreground [&_h2]:font-medium [&_h2]:text-foreground',
  '[&_h3]:font-medium [&_h3]:text-foreground [&_strong]:font-medium [&_strong]:text-foreground',
  '[&_ol]:list-decimal [&_ol]:pl-4 [&_ul]:list-disc [&_ul]:pl-4',
  '[&_table]:my-1 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-1.5',
  '[&_th]:border [&_th]:border-border [&_th]:px-1.5 [&_th]:text-left',
  // A thin track in the theme's colors instead of the platform's progress bar.
  '[&_progress]:my-2 [&_progress]:block [&_progress]:h-1 [&_progress]:w-full [&_progress]:appearance-none',
  '[&_progress]:overflow-hidden [&_progress]:rounded-full [&_progress]:border-0 [&_progress]:bg-foreground/10',
  '[&_progress::-webkit-progress-bar]:bg-transparent [&_progress::-webkit-progress-value]:rounded-full',
  '[&_progress::-webkit-progress-value]:bg-primary [&_progress::-webkit-progress-value]:transition-[width]',
].join(' ');

/**
 * A progress card's note: agent-written markdown rendered without raw HTML
 * (bar the validated progress element) and without remote images, with
 * links opened in the system browser only when they are http(s).
 */
const ProgressCardMarkdown: React.FC<{ content: string }> = ({ content }) => (
  <div className={NOTE_CLASS}>
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
