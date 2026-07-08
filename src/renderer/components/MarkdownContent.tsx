import 'katex/dist/katex.min.css';
import 'katex/contrib/mhchem';

import { DocumentIcon, FolderIcon } from '@heroicons/react/24/outline';
import React, { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
// @ts-ignore
import rehypeKatex from 'rehype-katex';
// @ts-ignore
import remarkGfm from 'remark-gfm';
// @ts-ignore
import remarkMath from 'remark-math';

import { i18nService } from '../services/i18n';
import { type ShellActionResult, showShellFailureToast, showToast } from '../utils/localFileActions';
import CodeBlock from './CodeBlock';

const SAFE_URL_PROTOCOLS = new Set(['http', 'https', 'mailto', 'tel', 'file', 'localfile', 'kit']);
const INTERNAL_URL_PROTOCOLS = new Set(['kit']);
const LINK_CLASS_NAME = 'text-primary hover:text-primary-hover underline decoration-primary/50 hover:decoration-primary transition-colors break-words [overflow-wrap:anywhere]';
const LARGE_MARKDOWN_RENDER_THRESHOLD = 8 * 1024;
const LARGE_MARKDOWN_PREVIEW_HEAD_LENGTH = 4 * 1024;
const LARGE_MARKDOWN_PREVIEW_TAIL_LENGTH = 8 * 1024;
type MarkdownSpacing = 'normal' | 'compact';

export const shouldUseLargeMarkdownPreview = (content: string): boolean =>
  content.length > LARGE_MARKDOWN_RENDER_THRESHOLD;

export const getLargeMarkdownPreview = (content: string): string => (
  content.length <= LARGE_MARKDOWN_PREVIEW_HEAD_LENGTH + LARGE_MARKDOWN_PREVIEW_TAIL_LENGTH
    ? content
    : [
        content.slice(0, LARGE_MARKDOWN_PREVIEW_HEAD_LENGTH).trimEnd(),
        '',
        '...',
        '',
        content.slice(-LARGE_MARKDOWN_PREVIEW_TAIL_LENGTH).trimStart(),
      ].join('\n')
);

const formatContentSize = (bytes: number): string => {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${Math.ceil(bytes / 1024)} KB`;
};

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

export const safeUrlTransform = (url: string): string => {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;

  if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
    return trimmed;
  }

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
  if (INTERNAL_URL_PROTOCOLS.has(protocol)) return false;
  return protocol !== 'file' && protocol !== 'localfile';
};

export const isInternalHref = (href: string): boolean => {
  const protocol = getHrefProtocol(href);
  return !!protocol && INTERNAL_URL_PROTOCOLS.has(protocol);
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

const safeDecodeURIComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const stripHashAndQuery = (value: string): string => value.split('#')[0].split('?')[0];

const stripFileProtocol = (value: string): string => {
  let cleaned = value.replace(/^(?:file|localfile):\/\//i, '');
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
  if (/^localfile:\/\//i.test(href)) return true;
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

const encodeLocalPathForUrl = (filePath: string): string => {
  return filePath
    .replace(/\\/g, '/')
    .split('/')
    .map((segment, index) => {
      if (index === 0 && segment === '') return '';
      if (/^[A-Za-z]:$/.test(segment)) return segment;
      return encodeURIComponent(segment);
    })
    .join('/');
};

const toLocalFileSrc = (filePath: string): string => {
  const normalized = stripFileProtocol(stripHashAndQuery(filePath.trim()));
  const encoded = encodeLocalPathForUrl(normalized);
  if (/^[A-Za-z]:/.test(normalized)) {
    return `localfile:///${encoded}`;
  }
  if (encoded.startsWith('/')) {
    return `localfile://${encoded}`;
  }
  return `localfile:///${encoded}`;
};

const isRemoteOrInlineImageSrc = (src: string): boolean => {
  return /^(?:https?|data|blob):/i.test(src);
};

const resolveMarkdownImageSrc = (
  src: unknown,
  alt: unknown,
  resolveLocalFilePath?: (href: string, text: string) => string | null
): string | undefined => {
  if (typeof src !== 'string') return undefined;

  const srcValue = src.trim();
  if (!srcValue || isRemoteOrInlineImageSrc(srcValue)) {
    return srcValue || undefined;
  }

  const altText = typeof alt === 'string' ? alt : '';
  const resolvedPath = resolveLocalFilePath ? resolveLocalFilePath(srcValue, altText) : null;
  if (resolvedPath) {
    return toLocalFileSrc(resolvedPath);
  }

  if (/^(?:file|localfile):\/\//i.test(srcValue)) {
    return toLocalFileSrc(srcValue);
  }

  if (srcValue.startsWith('/') && !srcValue.startsWith('//')) {
    return toLocalFileSrc(srcValue);
  }

  if (/^[A-Za-z]:[\\/]/.test(srcValue)) {
    return toLocalFileSrc(srcValue);
  }

  return srcValue;
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
  onImageClick?: (image: { src: string; alt?: string | null }) => void,
  spacing: MarkdownSpacing = 'normal',
) => ({
  p: ({ node: _node, className: _className, children, ...props }: any) => (
    <p className={`${spacing === 'compact' ? 'my-1' : 'my-3'} first:mt-0 last:mb-0 text-foreground/90`} {...props}>
      {children}
    </p>
  ),
  strong: ({ node: _node, className: _className, children, ...props }: any) => (
    <strong className="font-semibold text-foreground" {...props}>
      {children}
    </strong>
  ),
  h1: ({ node: _node, className: _className, children, ...props }: any) => (
    <h1 className={`${spacing === 'compact' ? 'mt-3 mb-1.5' : 'mt-6 mb-3'} text-xl font-semibold leading-snug first:mt-0 text-foreground`} {...props}>
      {children}
    </h1>
  ),
  h2: ({ node: _node, className: _className, children, ...props }: any) => (
    <h2 className={`${spacing === 'compact' ? 'mt-2.5 mb-1' : 'mt-5 mb-2.5'} text-[length:var(--lobster-text-markdownH2)] font-semibold leading-snug first:mt-0 text-foreground`} {...props}>
      {children}
    </h2>
  ),
  h3: ({ node: _node, className: _className, children, ...props }: any) => (
    <h3 className={`${spacing === 'compact' ? 'mt-2 mb-1' : 'mt-4 mb-2'} text-base font-semibold leading-snug first:mt-0 text-foreground`} {...props}>
      {children}
    </h3>
  ),
  h4: ({ node: _node, className: _className, children, ...props }: any) => (
    <h4 className={`${spacing === 'compact' ? 'mt-2 mb-1' : 'mt-4 mb-1.5'} text-[length:var(--lobster-text-markdownH4)] font-semibold leading-snug first:mt-0 text-foreground`} {...props}>
      {children}
    </h4>
  ),
  ul: ({ node: _node, className: _className, children, ...props }: any) => (
    <ul className={`${spacing === 'compact' ? 'my-1 [li>&]:my-0.5' : 'my-3 [li>&]:my-1.5'} list-disc pl-5 first:mt-0 last:mb-0 marker:text-foreground/40 text-foreground/90`} {...props}>
      {children}
    </ul>
  ),
  ol: ({ node: _node, className: _className, children, ...props }: any) => (
    <ol className={`${spacing === 'compact' ? 'my-1 [li>&]:my-0.5' : 'my-3 [li>&]:my-1.5'} list-decimal pl-6 first:mt-0 last:mb-0 marker:text-foreground/55 text-foreground/90`} {...props}>
      {children}
    </ol>
  ),
  li: ({ node: _node, className: _className, children, ...props }: any) => (
    <li className={`${spacing === 'compact' ? 'my-0.5' : 'my-1.5'} pl-1 text-foreground/90`} {...props}>
      {children}
    </li>
  ),
  blockquote: ({ node: _node, className: _className, children, ...props }: any) => (
    <blockquote className={`${spacing === 'compact' ? 'my-1.5' : 'my-3'} border-l-4 border-primary pl-4 py-1 bg-surface-raised/30 rounded-r-lg text-foreground/90 overflow-x-auto`} {...props}>
      {children}
    </blockquote>
  ),
  pre: ({ node: _node, className: _className, children }: any) => (
    <>{children}</>
  ),
  code: CodeBlock,
  table: ({ node: _node, className: _className, children, ...props }: any) => (
    <div className={`${spacing === 'compact' ? 'my-2' : 'my-4'} overflow-x-auto rounded-xl border border-border`}>
      <table className="border-collapse w-full" {...props}>
        {children}
      </table>
    </div>
  ),
  thead: ({ node: _node, className: _className, children, ...props }: any) => (
    <thead className="bg-surface-raised" {...props}>
      {children}
    </thead>
  ),
  tbody: ({ node: _node, className: _className, children, ...props }: any) => (
    <tbody className="divide-y divide-border" {...props}>
      {children}
    </tbody>
  ),
  tr: ({ node: _node, className: _className, children, ...props }: any) => (
    <tr className="divide-x divide-border" {...props}>
      {children}
    </tr>
  ),
  th: ({ node: _node, className: _className, children, ...props }: any) => (
    <th className="px-4 py-2 text-left font-semibold text-foreground" {...props}>
      {children}
    </th>
  ),
  td: ({ node: _node, className: _className, children, ...props }: any) => (
    <td className="px-4 py-2 text-foreground/90" {...props}>
      {children}
    </td>
  ),
  img: ({ node: _node, className: _className, src, alt, ...props }: any) => {
    const resolvedSrc = resolveMarkdownImageSrc(src, alt, resolveLocalFilePath);
    const altText = typeof alt === 'string' ? alt : null;
    return (
      <img
        className={`max-w-full max-h-96 object-contain rounded-xl ${spacing === 'compact' ? 'my-2' : 'my-4'}${onImageClick ? ' cursor-pointer hover:opacity-90 transition-opacity' : ''}`}
        src={resolvedSrc}
        alt={altText ?? undefined}
        onClick={onImageClick && resolvedSrc ? () => onImageClick({ src: resolvedSrc, alt: altText }) : undefined}
        {...props}
      />
    );
  },
  hr: ({ node: _node, ...props }: any) => (
    <hr className={`${spacing === 'compact' ? 'my-2' : 'my-5'} border-border`} {...props} />
  ),
  a: ({ node: _node, href, className: _className, children, ...props }: any) => {
    if (typeof href === 'string' && href.startsWith('#artifact-')) {
      return null;
    }

    const hrefValue = typeof href === 'string' ? href.trim() : '';
    const isInternalLink = !!hrefValue && isInternalHref(hrefValue);
    const isExternalLink = !!hrefValue && isExternalHref(hrefValue);
    const linkText = Array.isArray(children) ? children.join('') : String(children ?? '');
    const resolvedPath = hrefValue && !isInternalLink && !isExternalLink && resolveLocalFilePath
      ? resolveLocalFilePath(hrefValue, linkText)
      : null;
    const isLocalFilePath = !!hrefValue && !isInternalLink && !isExternalLink && (resolvedPath || isLikelyLocalFilePath(hrefValue));

    if (isInternalLink) {
      return (
        <span
          className="inline-flex max-w-full items-center rounded-md bg-surface-raised px-1.5 py-0.5 text-[0.9em] font-medium leading-normal text-foreground ring-1 ring-border/60 align-baseline"
          title={hrefValue}
        >
          <span className="min-w-0 truncate">{children}</span>
        </span>
      );
    }

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
              showShellFailureToast(fallbackResult, 'openFileFailed');
            }
          } else {
            console.error('Failed to open file:', filePath, result?.error);
            showShellFailureToast(result, 'openFileFailed');
          }
        } catch (error) {
          console.error('Failed to open file:', filePath, error);
          showToast(i18nService.t('openFileFailed'));
        }
      };

      const handleRevealInFolder = async (e: React.MouseEvent<HTMLButtonElement>) => {
        e.preventDefault();
        e.stopPropagation();
        const anchor = e.currentTarget.parentElement?.querySelector('a');
        const linkedAnchor = anchor instanceof HTMLAnchorElement ? anchor : null;
        let lastResult: ShellActionResult | null = null;

        const tryReveal = async (targetPath: string): Promise<boolean> => {
          const result = await window.electron.shell.showItemInFolder(targetPath);
          lastResult = result ?? null;
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

          showShellFailureToast(lastResult, 'showInFolderFailed');
        } catch (error) {
          console.error('Failed to show item in folder:', filePath, error);
          showToast(i18nService.t('showInFolderFailed'));
        }
      };

      return (
        <span className="group inline-flex max-w-full items-center gap-1 align-baseline">
          <a
            href={toFileHref(filePath)}
            onClick={handleClick}
            className={`${LINK_CLASS_NAME} cursor-pointer inline-flex max-w-full flex-wrap items-center gap-1`}
            title={filePath}
            {...props}
          >
            <span className="min-w-0 break-words [overflow-wrap:anywhere]">{children}</span>
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
          className={LINK_CLASS_NAME}
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
        className={LINK_CLASS_NAME}
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
  spacing?: MarkdownSpacing;
  resolveLocalFilePath?: (href: string, text: string) => string | null;
  showRevealInFolderAction?: boolean;
  enableLargePreview?: boolean;
  onImageClick?: (image: { src: string; alt?: string | null }) => void;
}

const MarkdownContent: React.FC<MarkdownContentProps> = ({
  content,
  className = '',
  spacing = 'normal',
  resolveLocalFilePath,
  showRevealInFolderAction = false,
  enableLargePreview = true,
  onImageClick,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const canUseLargePreview = enableLargePreview && shouldUseLargeMarkdownPreview(content);
  const useLargePreview = canUseLargePreview && !isExpanded;
  const components = useMemo(
    () => createMarkdownComponents(resolveLocalFilePath, showRevealInFolderAction, onImageClick, spacing),
    [resolveLocalFilePath, showRevealInFolderAction, onImageClick, spacing]
  );
  const markdownTextClassName = spacing === 'compact' ? 'text-markdown-body-compact' : 'text-markdown-body';
  const normalizedContent = useMemo(() => {
    if (useLargePreview) {
      return '';
    }
    return normalizeDisplayMath(encodeFileUrlsInMarkdown(content));
  }, [content, useLargePreview]);

  if (useLargePreview) {
    return (
      <div className={`markdown-content min-w-0 max-w-full ${markdownTextClassName} ${className}`}>
        <div className="rounded-lg border border-border bg-surface-raised/60">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs text-muted">
            <span>
              {i18nService.t('markdownLargePreviewNotice')} ({formatContentSize(content.length)})
            </span>
            <button
              type="button"
              className="text-primary hover:text-primary-hover"
              onClick={() => setIsExpanded(true)}
            >
              {i18nService.t('expand')}
            </button>
          </div>
          <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words p-3 text-code text-foreground">
            {getLargeMarkdownPreview(content)}
          </pre>
        </div>
      </div>
    );
  }

  return (
    <div className={`markdown-content min-w-0 max-w-full ${markdownTextClassName} ${className}`}>
      {canUseLargePreview && (
        <div className="mb-2 flex justify-end">
          <button
            type="button"
            className="text-xs text-primary hover:text-primary-hover"
            onClick={() => setIsExpanded(false)}
          >
            {i18nService.t('collapse')}
          </button>
        </div>
      )}
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
