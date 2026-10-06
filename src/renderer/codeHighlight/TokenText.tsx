import './theme.css';

import { memo } from 'react';

import { TOKEN_CLASS_PATTERN } from './style';
import type { CodeToken } from './tokenizer';

/** React text children only: HTML, event handlers and class names never come from source. */
export const TokenText = memo(function TokenText({ text, tokens }: { text: string; tokens?: CodeToken[] }) {
  if (!tokens?.length) return <>{text}</>;
  let offset = 0;
  const children: React.ReactNode[] = [];
  for (const token of tokens) {
    if (token.from < offset || token.to > text.length || token.to <= token.from || !TOKEN_CLASS_PATTERN.test(token.className)) continue;
    if (token.from > offset) children.push(text.slice(offset, token.from));
    children.push(<span key={`${token.from}:${token.to}`} className={token.className}>{text.slice(token.from, token.to)}</span>);
    offset = token.to;
  }
  if (offset < text.length) children.push(text.slice(offset));
  return <>{children}</>;
});
