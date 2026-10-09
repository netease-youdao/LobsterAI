import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** An answer on a companion surface: GitHub-flavored Markdown whose links open in the browser. */
export default function CompanionMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => (
          <a href={href} onClick={event => { event.preventDefault(); if (href) void window.electron.shell.openExternal(href); }}>{children}</a>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
