import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
// @ts-ignore
import remarkGfm from 'remark-gfm';
// @ts-ignore
import remarkMath from 'remark-math';
// @ts-ignore
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import 'katex/contrib/mhchem';
// @ts-ignore
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
// @ts-ignore
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
// @ts-ignore
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { ClipboardDocumentIcon, CheckIcon, DocumentIcon, FolderIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../services/i18n';

const CODE_BLOCK_LINE_LIMIT = 200;
const CODE_BLOCK_CHAR_LIMIT = 20000;
const SYNTAX_HIGHLIGHTER_STYLE = {
  margin: 0,
  borderRadius: 0,
};
const SAFE_URL_PROTOCOLS = new Set(['http', 'https', 'mailto', 'tel', 'file']);

const encodeFileUrl = (url: string): string => {
  const encoded = encodeURI(url);
  return encoded.replace(/\(/g, '%28').replace(/\)/g, '%29');
};

const encodeFileUrlDestination = (dest: string): string => {
  const trimmed = dest.trim();
  if (!/^<?file:\/\//i.test(trimmed)) {
    return dest;
  }

  let core = trimmed;
  let prefix = '';
  let suffix = '';
  if (core.startsWith('<') && core.endsWith('>')) {
    prefix = '<';
    suffix = '>';
    core = core.slice(1, -1);
  }

  const encoded = encodeFileUrl(core);
  return dest.replace(trimmed, `${prefix}${encoded}${suffix}`);
};

const findMarkdownLinkEnd = (input: string, start: number): number => {
  let depth = 1;
  for (let i = start; i < input.length; i += 1) {
    const char = input[i];
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
    if (char === '\n') {
      return -1;
    }
  }
  return -1;
};

const encodeFileUrlsInMarkdown = (content: string): string => {
  if (!content.includes('file://')) {
    return content;
  }

  let result = '';
  let cursor = 0;
  while (cursor < content.length) {
    const openIndex = content.indexOf('](', cursor);
    if (openIndex === -1) {
      result += content.slice(cursor);
      break;
    }

    result += content.slice(cursor, openIndex + 2);
    const destStart = openIndex + 2;
    const destEnd = findMarkdownLinkEnd(content, destStart);
    if (destEnd === -1) {
      result += content.slice(destStart);
      break;
    }

    const dest = content.slice(destStart, destEnd);
    result += encodeFileUrlDestination(dest);
    result += ')';
    cursor = destEnd + 1;
  }
  return result;
};

/**
 * Normalize multi-line display math blocks for remark-math compatibility.
 * remark-math treats $$ like code fences: opening $$ must be on its own line,
 * and closing $$ must also be on its own line.
 * LLMs often output $$content\n...\ncontent$$ which breaks parsing and corrupts
 * all subsequent markdown. This function normalizes such blocks.
 */
const normalizeDisplayMath = (content: string): string => {
  return content.replace(/\$\$([\s\S]+?)\$\$/g, (match, inner) => {
    if (!inner.includes('\n')) {
      return match;
    }
    return `$$\n${inner.trim()}\n$$`;
  });
};

const safeUrlTransform = (url: string): string => {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;

  const match = trimmed.match(/^([a-z][a-z0-9+.-]*):/i);
  if (!match) {
    return trimmed;
  }

  const protocol = match[1].toLowerCase();
  if (SAFE_URL_PROTOCOLS.has(protocol)) {
    return trimmed;
  }

  return '';
};

const getHrefProtocol = (href: string): string | null => {
  const trimmed = href.trim();
  const match = trimmed.match(/^([a-z][a-z0-9+.-]*):/i);
  if (!match) return null;
  return match[1].toLowerCase();
};

const isExternalHref = (href: string): boolean => {
  const protocol = getHrefProtocol(href);
  if (!protocol) return false;
  return protocol !== 'file';
};

const openExternalViaDefaultBrowser = async (url: string): Promise<boolean> => {
  const openExternal = (window as any)?.electron?.shell?.openExternal;
  if (typeof openExternal !== 'function') {
    return false;
  }

  try {
    const result = await openExternal(url);
    return !!result?.success;
  } catch (error) {
    console.error('Failed to open external link with system browser:', url, error);
    return false;
  }
};

const openExternalViaAnchorFallback = (url: string): void => {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
};

function useIsDark() {
  const [isDark, setIsDark] = useState(() =>
    document.documentElement.classList.contains('dark')
  );
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'));
    });
    observer.observe(document.documentElement, { attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return isDark;
}

const dispatchAppToast = (message: string): void => {
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
};

const CodeBlock: React.FC<any> = ({ node, className, children, ...props }) => {
  const normalizedClassName = Array.isArray(className)
    ? className.join(' ')
    : className || '';
  const match = /language-([\w-]+)/.exec(normalizedClassName);
  const hasPosition = node?.position?.start?.line != null && node?.position?.end?.line != null;
  const isInline = typeof props.inline === 'boolean'
    ? props.inline
    : hasPosition
      ? node.position.start.line === node.position.end.line
      : !match;
  const codeText = Array.isArray(children) ? children.join('') : String(children);
  const trimmedCodeText = codeText.replace(/\n$/, '');
  const shouldHighlight = !isInline && match
    && trimmedCodeText.length <= CODE_BLOCK_CHAR_LIMIT
    && trimmedCodeText.split('\n').length <= CODE_BLOCK_LINE_LIMIT;
  const [isCopied, setIsCopied] = useState(false);
  const copyTimeoutRef = useRef<number | null>(null);
  const isDark = useIsDark();
  const highlighterStyle = isDark ? oneDark : {
    ...oneLight,
    'pre[class*="language-"]': { ...(oneLight as Record<string, React.CSSProperties>)['pre[class*="language-"]'], background: '#f0f2f5' },
    'code[class*="language-"]': { ...(oneLight as Record<string, React.CSSProperties>)['code[class*="language-"]'], background: '#f0f2f5' },
  };

  useEffect(() => () => {
    if (copyTimeoutRef.current != null) {
      window.clearTimeout(copyTimeoutRef.current);
    }
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(trimmedCodeText);
      setIsCopied(true);
      if (copyTimeoutRef.current != null) {
        window.clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = window.setTimeout(() => setIsCopied(false), 1500);
    } catch (error) {
      console.error('Failed to copy code block: ', error);
    }
  }, [trimmedCodeText]);

  if (!isInline) {
    // Simple code block without language - minimal styling
    if (!match) {
      return (
        <div className="my-2 relative group">
          <div className="overflow-x-auto rounded-lg dark:bg-[#282c34] bg-[#f0f2f5] text-[13px] leading-6">
            <button
              type="button"
              onClick={handleCopy}
              className="absolute top-2 right-2 z-10 p-2 rounded-md bg-gray-700 text-gray-300 hover:bg-gray-600 transition-colors opacity-0 group-hover:opacity-100 transform-gpu"
              title={i18nService.t('copyToClipboard')}
              aria-label={i18nService.t('copyToClipboard')}
            >
              {isCopied ? (
                <CheckIcon className="h-5 w-5 text-green-500" />
              ) : (
                <ClipboardDocumentIcon className="h-5 w-5" />
              )}
            </button>
            <code className="block px-4 py-3 font-mono dark:text-gray-100 text-gray-800 whitespace-pre">
              {trimmedCodeText}
            </code>
          </div>
        </div>
      );
    }

    // Code block with language - show header with language name
    return (
      <div className="my-3 rounded-xl overflow-hidden border border-border relative shadow-subtle">
        <div className="bg-surface-raised px-4 py-2 text-xs text-secondary font-medium flex items-center justify-between">
          <span>{match[1]}</span>
          <button
            type="button"
            onClick={handleCopy}
            className="p-2 rounded-md hover:bg-surface-raised transition-colors transform-gpu"
            title={i18nService.t('copyToClipboard')}
            aria-label={i18nService.t('copyToClipboard')}
          >
            {isCopied ? (
              <CheckIcon className="h-5 w-5 text-green-500" />
            ) : (
              <ClipboardDocumentIcon className="h-5 w-5" />
            )}
          </button>
        </div>
        {shouldHighlight ? (
          <SyntaxHighlighter
            style={highlighterStyle}
            language={match[1]}
            PreTag="div"
            customStyle={{ ...SYNTAX_HIGHLIGHTER_STYLE, background: isDark ? '#282c34' : '#f0f2f5' }}
          >
            {trimmedCodeText}
          </SyntaxHighlighter>
        ) : (
          <div className="m-0 overflow-x-auto dark:bg-[#282c34] bg-[#f0f2f5] text-[13px] leading-6">
            <code className="block px-4 py-3 font-mono dark:text-gray-100 text-gray-800 whitespace-pre">
              {trimmedCodeText}
            </code>
          </div>
        )}
      </div>
    );
  }

  const inlineClassName = [
    'inline bg-transparent px-0.5 text-[0.92em] font-mono font-medium text-foreground',
    normalizedClassName,
  ].filter(Boolean).join(' ');

  return (
    <code
      className={inlineClassName}
      {...props}
    >
      {children}
    </code>
  );
};

const safeDecodeURIComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const stripHashAndQuery = (value: string): string => value.split('#')[0].split('?')[0];

const stripFileProtocol = (value: string): string => {
  let cleaned = value.replace(/^file:\/\//i, '');
  if (/^\/[A-Za-z]:/.test(cleaned)) {
    cleaned = cleaned.slice(1);
  }
  return cleaned;
};

const hasFileExtension = (value: string): boolean => /\.[A-Za-z0-9]{1,6}$/.test(value);

const looksLikeDirectory = (value: string): boolean => {
  if (!value) return false;
  if (value.endsWith('/') || value.endsWith('\\')) return true;
  return !hasFileExtension(value);
};

const isLikelyLocalFilePath = (href: string): boolean => {
  if (!href) return false;
  if (/^file:\/\//i.test(href)) return true;
  if (/^[A-Za-z]:[\\/]/.test(href)) return true;
  if (href.startsWith('/') || href.startsWith('./') || href.startsWith('../')) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return false;

  const base = stripHashAndQuery(href);
  if (base.includes('/') || base.includes('\\')) return true;

  const extMatch = base.match(/\.([A-Za-z0-9]{1,6})$/);
  if (!extMatch) return false;
  const ext = extMatch[1].toLowerCase();
  const commonTlds = new Set(['com', 'net', 'org', 'io', 'cn', 'co', 'ai', 'app', 'dev', 'gov', 'edu']);
  return !commonTlds.has(ext);
};

const toFileHref = (filePath: string): string => {
  const normalized = filePath.replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(filePath)) {
    return `file:///${normalized}`;
  }
  if (normalized.startsWith('/')) {
    return `file://${normalized}`;
  }
  return `file://${normalized}`;
};

const getLocalPathFromLink = (
  href: string | null,
  text: string,
  resolveLocalFilePath?: (href: string, text: string) => string | null
): string | null => {
  if (!href) return null;
  const resolved = resolveLocalFilePath ? resolveLocalFilePath(href, text) : null;
  if (resolved) return resolved;
  if (!isLikelyLocalFilePath(href)) return null;
  const rawPath = stripFileProtocol(stripHashAndQuery(href));
  const decoded = safeDecodeURIComponent(rawPath);
  return decoded || rawPath || null;
};

const findFallbackPathFromContext = (
  anchor: HTMLAnchorElement | null,
  fileName: string,
  resolveLocalFilePath?: (href: string, text: string) => string | null
): string | null => {
  const trimmedName = fileName.trim();
  if (!trimmedName || trimmedName.includes('/') || trimmedName.includes('\\')) {
    return null;
  }

  if (!anchor || typeof anchor.closest !== 'function') return null;
  const container = anchor.closest('.markdown-content');
  if (!container) return null;

  const anchors = Array.from(container.querySelectorAll('a'));
  const index = anchors.indexOf(anchor);
  if (index <= 0) return null;

  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = anchors[i] as HTMLAnchorElement;
    const candidateHref = candidate.getAttribute('href');
    const candidateText = candidate.textContent ?? '';
    const basePath = getLocalPathFromLink(candidateHref, candidateText, resolveLocalFilePath);
    if (!basePath || !looksLikeDirectory(basePath)) {
      continue;
    }

    const normalizedBase = basePath.replace(/[\\/]+$/, '');
    return `${normalizedBase}/${trimmedName}`;
  }

  return null;
};

const createMarkdownComponents = (
  resolveLocalFilePath?: (href: string, text: string) => string | null,
  showRevealInFolderAction = false,
) => ({
  p: ({ node, className, children, ...props }: any) => (
    <p className="my-1 first:mt-0 last:mb-0 leading-6 text-foreground" {...props}>
      {children}
    </p>
  ),
  strong: ({ node, className, children, ...props }: any) => (
    <strong className="font-semibold text-foreground" {...props}>
      {children}
    </strong>
  ),
  h1: ({ node, className, children, ...props }: any) => (
    <h1 className="text-2xl font-semibold mt-6 mb-3 text-foreground" {...props}>
      {children}
    </h1>
  ),
  h2: ({ node, className, children, ...props }: any) => (
    <h2 className="text-xl font-semibold mt-5 mb-2 text-foreground" {...props}>
      {children}
    </h2>
  ),
  h3: ({ node, className, children, ...props }: any) => (
    <h3 className="text-lg font-semibold mt-4 mb-2 text-foreground" {...props}>
      {children}
    </h3>
  ),
  ul: ({ node, className, children, ...props }: any) => (
    <ul className="list-disc pl-5 my-1.5 text-foreground" {...props}>
      {children}
    </ul>
  ),
  ol: ({ node, className, children, ...props }: any) => (
    <ol className="list-decimal pl-6 my-1.5 text-foreground" {...props}>
      {children}
    </ol>
  ),
  li: ({ node, className, children, ...props }: any) => (
    <li className="my-0.5 leading-6 text-foreground" {...props}>
      {children}
    </li>
  ),
  blockquote: ({ node, className, children, ...props }: any) => (
    <blockquote className="border-l-4 border-primary pl-4 py-1 my-2 bg-surface-raised/30 rounded-r-lg text-foreground" {...props}>
      {children}
    </blockquote>
  ),
  code: CodeBlock,
  table: ({ node, className, children, ...props }: any) => (
    <div className="my-4 overflow-x-auto rounded-xl border border-border">
      <table className="border-collapse w-full" {...props}>
        {children}
      </table>
    </div>
  ),
  thead: ({ node, className, children, ...props }: any) => (
    <thead className="bg-surface-raised" {...props}>
      {children}
    </thead>
  ),
  tbody: ({ node, className, children, ...props }: any) => (
    <tbody className="divide-y divide-border" {...props}>
      {children}
    </tbody>
  ),
  tr: ({ node, className, children, ...props }: any) => (
    <tr className="divide-x divide-border" {...props}>
      {children}
    </tr>
  ),
  th: ({ node, className, children, ...props }: any) => (
    <th className="px-4 py-2 text-left font-semibold text-foreground" {...props}>
      {children}
    </th>
  ),
  td: ({ node, className, children, ...props }: any) => (
    <td className="px-4 py-2 text-foreground" {...props}>
      {children}
    </td>
  ),
  img: ({ node, className, src, alt, ...props }: any) => {
    const resolvedSrc = typeof src === 'string' && src.startsWith('file://')
      ? src.replace(/^file:\/\//, 'localfile://')
      : src;
    return <img className="max-w-full h-auto rounded-xl my-4" src={resolvedSrc} alt={alt} {...props} />;
  },
  hr: ({ node, ...props }: any) => (
    <hr className="my-5 border-border" {...props} />
  ),
  a: ({ node, href, className, children, ...props }: any) => {
    if (typeof href === 'string' && href.startsWith('#artifact-')) {
      return null;
    }

    const hrefValue = typeof href === 'string' ? href.trim() : '';
    const isExternalLink = !!hrefValue && isExternalHref(hrefValue);
    const linkText = Array.isArray(children) ? children.join('') : String(children ?? '');
    const resolvedPath = hrefValue && !isExternalLink && resolveLocalFilePath
      ? resolveLocalFilePath(hrefValue, linkText)
      : null;
    const isLocalFilePath = !!hrefValue && !isExternalLink && (resolvedPath || isLikelyLocalFilePath(hrefValue));

    if (isLocalFilePath) {
      const rawPath = resolvedPath
        ?? stripFileProtocol(stripHashAndQuery(hrefValue));
      const decodedPath = safeDecodeURIComponent(rawPath);
      const filePath = decodedPath || rawPath;
      const isDirectoryLink = looksLikeDirectory(filePath);
      const shouldShowRevealInFolderAction = showRevealInFolderAction && !isDirectoryLink;

      const handleClick = async (e: React.MouseEvent<HTMLAnchorElement>) => {
        e.preventDefault();
        const anchor = e.currentTarget;
        try {
          const result = await window.electron.shell.openPath(filePath);
          if (result?.success) {
            return;
          }

          const fallbackPath = findFallbackPathFromContext(
            anchor,
            linkText,
            resolveLocalFilePath
          );
          if (fallbackPath) {
            const fallbackResult = await window.electron.shell.openPath(fallbackPath);
            if (!fallbackResult?.success) {
              console.error('Failed to open file (fallback):', fallbackPath, fallbackResult?.error);
            }
          } else {
            console.error('Failed to open file:', filePath, result?.error);
          }
        } catch (error) {
          console.error('Failed to open file:', filePath, error);
        }
      };

      const handleRevealInFolder = async (e: React.MouseEvent<HTMLButtonElement>) => {
        e.preventDefault();
        e.stopPropagation();
        const anchor = e.currentTarget.parentElement?.querySelector('a');
        const linkedAnchor = anchor instanceof HTMLAnchorElement ? anchor : null;

        const tryReveal = async (targetPath: string): Promise<boolean> => {
          const result = await window.electron.shell.showItemInFolder(targetPath);
          if (result?.success) {
            return true;
          }
          console.error('Failed to show item in folder:', targetPath, result?.error);
          return false;
        };

        try {
          if (await tryReveal(filePath)) {
            return;
          }

          const fallbackPath = findFallbackPathFromContext(
            linkedAnchor,
            linkText,
            resolveLocalFilePath
          );
          if (fallbackPath && fallbackPath !== filePath && await tryReveal(fallbackPath)) {
            return;
          }

          dispatchAppToast(i18nService.t('showInFolderFailed'));
        } catch (error) {
          console.error('Failed to show item in folder:', filePath, error);
          dispatchAppToast(i18nService.t('showInFolderFailed'));
        }
      };

      return (
        <span className="group inline-flex max-w-full items-center gap-1 align-baseline">
          <a
            href={toFileHref(filePath)}
            onClick={handleClick}
            className="text-primary hover:text-primary-hover underline decoration-primary/50 hover:decoration-primary transition-colors cursor-pointer inline-flex items-center gap-1"
            title={filePath}
            {...props}
          >
            {children}
            {isDirectoryLink ? (
              <FolderIcon className="h-3.5 w-3.5 inline" />
            ) : (
              <DocumentIcon className="h-3.5 w-3.5 inline" />
            )}
          </a>
          {shouldShowRevealInFolderAction && (
            <button
              type="button"
              onClick={handleRevealInFolder}
              className="inline-flex items-center justify-center rounded-md p-0.5 text-secondary hover:text-primary hover:bg-surface-hover opacity-0 pointer-events-none transition-all group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto"
              title={i18nService.t('showInFolder')}
              aria-label={i18nService.t('showInFolder')}
            >
              <FolderIcon className="h-3.5 w-3.5" />
            </button>
          )}
        </span>
      );
    }

    if (isExternalLink) {
      const handleExternalClick = async (e: React.MouseEvent<HTMLAnchorElement>) => {
        const openExternal = (window as any)?.electron?.shell?.openExternal;
        if (typeof openExternal !== 'function') {
          return;
        }

        e.preventDefault();
        const opened = await openExternalViaDefaultBrowser(hrefValue);
        if (!opened) {
          openExternalViaAnchorFallback(hrefValue);
        }
      };

      return (
        <a
          href={hrefValue}
          target="_blank"
          rel="noopener noreferrer"
          onClick={handleExternalClick}
          className="text-primary hover:text-primary-hover underline decoration-primary/50 hover:decoration-primary transition-colors"
          {...props}
        >
          {children}
        </a>
      );
    }

    return (
      <a
        href={hrefValue}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary hover:text-primary-hover underline decoration-primary/50 hover:decoration-primary transition-colors"
        {...props}
      >
        {children}
      </a>
    );
  },
});

interface MarkdownContentProps {
  content: string;
  className?: string;
  resolveLocalFilePath?: (href: string, text: string) => string | null;
  showRevealInFolderAction?: boolean;
}

const MarkdownContent: React.FC<MarkdownContentProps> = ({
  content,
  className = '',
  resolveLocalFilePath,
  showRevealInFolderAction = false,
}) => {
  const components = useMemo(
    () => createMarkdownComponents(resolveLocalFilePath, showRevealInFolderAction),
    [resolveLocalFilePath, showRevealInFolderAction]
  );
  const normalizedContent = useMemo(() => normalizeDisplayMath(encodeFileUrlsInMarkdown(content)), [content]);
  return (
    <div className={`markdown-content text-[15px] leading-6 ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        urlTransform={safeUrlTransform}
        components={components}
      >
        {normalizedContent}
      </ReactMarkdown>
    </div>
  );
};

export default MarkdownContent;
