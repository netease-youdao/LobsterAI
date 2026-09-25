import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownNode {
  type: string; value?: string; children?: MarkdownNode[];
  data?: { hName: string; hProperties: Record<string, string | number> };
}
/** Permit only the native card's measured progress element; never enable arbitrary HTML. */
function remarkProgress() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (node.type === 'html' && node.value) {
        const match = /^<progress\s+([^>]*)>(?:\s*<\/progress>)?\s*$/i.exec(node.value.trim());
        if (match) {
          const attrs: Record<string, string> = {};
          for (const a of match[1].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1].toLowerCase()] = a[2] ?? a[3];
          const value = Number(attrs.value), max = Number(attrs.max);
          if (attrs.value !== undefined && attrs.max !== undefined && Number.isFinite(value) && Number.isFinite(max) && max > 0 && value >= 0 && value <= max) {
            node.type = 'paragraph'; node.value = undefined; node.children = [];
            node.data = { hName: 'progress', hProperties: { value, max, 'aria-label': attrs['aria-label'] || `${value}/${max}` } };
          }
        }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
export default function ProgressCardMarkdown({ content }: { content: string }) {
  return <div className="openclaw-progress-card-markdown"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm, remarkProgress]} components={{
    img: ({ alt }) => <span>{alt}</span>,
    a: ({ href, children }) => <a href={href} onClick={event => {
      event.preventDefault();
      if (href && /^https?:\/\//i.test(href)) void window.electron.shell.openExternal(href);
    }}>{children}</a>,
  }}>{content}</ReactMarkdown></div>;
}
