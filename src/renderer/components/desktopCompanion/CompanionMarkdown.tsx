import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** An answer on a companion surface: GitHub-flavored Markdown whose links open in the browser. */
export interface CompanionMarkdownProps {
  text: string;
  onOpenLink?: (href: string) => void;
  urlTransform?: (url: string) => string;
}

export default function CompanionMarkdown({ text, onOpenLink, urlTransform }: CompanionMarkdownProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={urlTransform}
      components={{
        a: ({ href, children }) => (
          <a href={href} onClick={event => {
            event.preventDefault();
            if (!href) return;
            if (onOpenLink) onOpenLink(href);
            else void window.electron.shell.openExternal(href);
          }}>{children}</a>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
