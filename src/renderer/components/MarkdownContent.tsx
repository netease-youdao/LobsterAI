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
import { ClipboardDocumentIcon, CheckIcon, DocumentIcon, FolderIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../services/i18n';

const CODE_BLOCK_LINE_LIMIT = 200;
const CODE_BLOCK_CHAR_LIMIT = 20000;
const SYNTAX_HIGHLIGHTER_STYLE = {
  margin: 0,
  borderRadius: 0,
  background: '#282c34',
};
const SAFE_URL_PROTOCOLS = new Set(['http', 'https', 'mailto', 'tel', 'file']);

// Custom URI protocols that should be handled by the system (e.g., obsidian://, vscode://)
// These are treated as external links and opened via shell.openExternal
const CUSTOM_URI_PROTOCOLS = new Set([
  'obsidian',
  'vscode',
  'vscode-insiders',
  'cursor',
  'sublime',
  'atom',
  'idea',
  'webstorm',
  'pycharm',
  'goland',
  'clion',
  'rider',
  'datagrip',
  'phpstorm',
  'rubymine',
  'appcode',
  'fleet',
  'android-studio',
  'xcode',
  'iterm2',
  'terminal',
  'warp',
  'fig',
  'slack',
  'discord',
  'telegram',
  'whatsapp',
  'zoom',
  'teams',
  'meet',
  'notion',
  'bear',
  'things',
  'omnifocus',
  'todoist',
  'linear',
  'jira',
  'asana',
  'trello',
  'monday',
  'clickup',
  'height',
  'shortcut',
  'github',
  'gitlab',
  'bitbucket',
  'source-tree',
  'tower',
  'fork',
  'sourcetree',
  'kraken',
  'postman',
  'insomnia',
  'httpie',
  'tableplus',
  'sequel-pro',
  'sequel-ace',
  'datagrip',
  'pgadmin',
  'mysqlworkbench',
  'robo-3t',
  'studio-3t',
  'mongo-compass',
  'redisinsight',
  'docker',
  'kitematic',
  'figma',
  'sketch',
  'adobe-xd',
  'invision',
  'zeplin',
  'abstract',
  'framer',
  'principle',
  'protoio',
  'marvel',
  'axure',
  'balsamiq',
  'mockplus',
  '墨刀',
  'mastergo',
  '即时设计',
  'pixso',
  'sketch-measure',
  'lanhu',
  'xiaopiu',
  'modao',
  '磨刀',
  'spotify',
  'music',
  'itunes',
  'podcasts',
  'overcast',
  'pocket-casts',
  ' Castro',
  'downcast',
  'breaker',
  'snipd',
  'airr',
  'fountain',
  'logseq',
  'remnote',
  'notion',
  'craft',
  'anytype',
  'capacities',
  'reflect',
  'mem',
  'amplenote',
  'standard-notes',
  'joplin',
  'trilium',
  'zettlr',
  'typora',
  'marktext',
  'ia-writer',
  'ulysses',
  'scrivener',
  'pages',
  'numbers',
  'keynote',
  'word',
  'excel',
  'powerpoint',
  'outlook',
  'thunderbird',
  'spark',
  'airmail',
  'newton',
  'superhuman',
  'hey',
  'gmail',
  'google-chrome',
  'firefox',
  'safari',
  'edge',
  'brave',
  'arc',
  'sigmaos',
  'orion',
  'vivaldi',
  'opera',
  'tor-browser',
  'lynx',
  'w3m',
  'chrome-devtools',
  'devtools',
  'raycast',
  'alfred',
  'launchbar',
  'quicksilver',
  'spotlight',
  'ueli',
  'wox',
  'hain',
  'zazu',
  ' cerebro',
  'devdocs',
  'dash',
  'zeal',
  'velocity',
  'kapeli',
  'cheatsheet',
  'shortcuts',
  'workflow',
  'scriptable',
  'pythonista',
  'playgrounds',
  'swift-playgrounds',
  'xcode',
  'simulator',
  'instruments',
]);

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
  // Allow standard safe protocols and custom URI protocols
  if (SAFE_URL_PROTOCOLS.has(protocol) || CUSTOM_URI_PROTOCOLS.has(protocol)) {
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
      copyTimeoutRef.current = window.setTimeout(() => setIsCopied(false), 2000);
    } catch {
      // ignore
    }
  }, [trimmedCodeText]);

  const languageDisplay = match ? match[1] : '';

  if (shouldHighlight) {
    return (
      <div className="code-block-wrapper">
        <div className="code-block-header">
          <span className="code-language">{languageDisplay}</span>
          <button
            type="button"
            onClick={handleCopy}
            className="copy-code-button"
            aria-label={isCopied ? i18nService.t('common:copied') : i18nService.t('common:copy')}
            title={isCopied ? i18nService.t('common:copied') : i18nService.t('common:copy')}
          >
            {isCopied ? (
              <CheckIcon className="w-4 h-4 text-green-500" />
            ) : (
              <ClipboardDocumentIcon className="w-4 h-4" />
            )}
          </button>
        </div>
        <SyntaxHighlighter
          style={oneDark}
          language={match[1]}
          PreTag="div"
          {...props}
        >
          {trimmedCodeText}
        </SyntaxHighlighter>
      </div>
    );
  }

  return isInline ? (
    <code className={normalizedClassName} {...props}>
      {children}
    </code>
  ) : (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        <span className="code-language">{languageDisplay}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="copy-code-button"
          aria-label={isCopied ? i18nService.t('common:copied') : i18nService.t('common:copy')}
          title={isCopied ? i18nService.t('common:copied') : i18nService.t('common:copy')}
        >
          {isCopied ? (
            <CheckIcon className="w-4 h-4 text-green-500" />
          ) : (
            <ClipboardDocumentIcon className="w-4 h-4" />
          )}
        </button>
      </div>
      <pre style={SYNTAX_HIGHLIGHTER_STYLE}>
        <code className={normalizedClassName} {...props}>
          {trimmedCodeText}
        </code>
      </pre>
    </div>
  );
};

interface FileLinkProps {
  href: string;
  children: React.ReactNode;
}

const FileLink: React.FC<FileLinkProps> = ({ href, children }) => {
  const [isHovered, setIsHovered] = useState(false);

  const handleClick = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const openPath = (window as any)?.electron?.shell?.openPath;
    if (typeof openPath !== 'function') {
      return;
    }

    try {
      const filePath = href.replace(/^file:\/\//, '');
      await openPath(decodeURI(filePath));
    } catch (error) {
      console.error('Failed to open file:', href, error);
    }
  }, [href]);

  const isFolder = href.endsWith('/');

  return (
    <a
      href={href}
      onClick={handleClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className="file-link"
      title={href}
    >
      {isFolder ? (
        <FolderIcon className={`file-link-icon ${isHovered ? 'hovered' : ''}`} />
      ) : (
        <DocumentIcon className={`file-link-icon ${isHovered ? 'hovered' : ''}`} />
      )}
      <span className="file-link-text">{children}</span>
    </a>
  );
};

interface AnchorProps {
  href?: string;
  children?: React.ReactNode;
}

const Anchor: React.FC<AnchorProps> = ({ href, children }) => {
  const handleClick = useCallback(async (e: React.MouseEvent) => {
    if (!href) return;

    const protocol = getHrefProtocol(href);
    if (!protocol) return;

    if (protocol === 'file') {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    const opened = await openExternalViaDefaultBrowser(href);
    if (!opened) {
      openExternalViaAnchorFallback(href);
    }
  }, [href]);

  if (!href) {
    return <a>{children}</a>;
  }

  const protocol = getHrefProtocol(href);
  if (protocol === 'file') {
    return <FileLink href={href}>{children}</FileLink>;
  }

  const isExternal = isExternalHref(href);

  return (
    <a
      href={href}
      onClick={isExternal ? handleClick : undefined}
      target={isExternal ? '_blank' : undefined}
      rel={isExternal ? 'noopener noreferrer' : undefined}
      className={isExternal ? 'external-link' : ''}
    >
      {children}
    </a>
  );
};

interface MarkdownContentProps {
  content: string;
  className?: string;
}

const MarkdownContent: React.FC<MarkdownContentProps> = ({ content, className = '' }) => {
  const processedContent = useMemo(() => {
    const withEncodedFiles = encodeFileUrlsInMarkdown(content);
    return normalizeDisplayMath(withEncodedFiles);
  }, [content]);

  return (
    <div className={`markdown-content ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        urlTransform={safeUrlTransform}
        components={{
          code: CodeBlock,
          a: Anchor,
        }}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  );
};

export default MarkdownContent;
