import React, { useState, useEffect, useRef } from 'react';
import mermaid from 'mermaid';
import { i18nService } from '../../services/i18n';

interface MermaidBlockProps {
  content: string;
  isStreaming?: boolean;
}

// Initialize mermaid once at module level with safe defaults.
// Theme is re-applied per render via mermaid.initialize() which is idempotent.
mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'default',
});

const containsMermaidErrorSvg = (svg: string): boolean => {
  const normalized = svg.toLowerCase();
  return normalized.includes('syntax error in text')
    && normalized.includes('mermaid version');
};

const MermaidBlockInner: React.FC<MermaidBlockProps> = ({ content, isStreaming }) => {
  const [svgHtml, setSvgHtml] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  // Unique ID per component instance to avoid mermaid render ID collisions
  const renderIdRef = useRef(`mermaid-${crypto.randomUUID()}`);

  useEffect(() => {
    if (isStreaming || !content.trim()) {
      setSvgHtml(null);
      setRenderError(null);
      return;
    }

    // Re-initialize mermaid theme based on current mode
    const isDark = document.documentElement.classList.contains('dark');
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: isDark ? 'dark' : 'default',
    });

    let cancelled = false;
    const renderDiagram = async () => {
      try {
        await mermaid.parse(content);
        const { svg } = await mermaid.render(renderIdRef.current, content);
        if (containsMermaidErrorSvg(svg)) {
          throw new Error(i18nService.t('artifactRenderError'));
        }
        if (!cancelled) {
          // Mermaid already runs with securityLevel='strict'. A second SVG-only
          // sanitization pass strips label nodes (notably Chinese flowchart text),
          // so keep the renderer output intact here.
          setSvgHtml(svg);
          setRenderError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setRenderError(err instanceof Error ? err.message : String(err));
          setSvgHtml(null);
        }
      }
    };
    renderDiagram();
    return () => {
      cancelled = true;
    };
  }, [content, isStreaming]);

  // Skeleton placeholder during streaming
  if (isStreaming) {
    return (
      <div className="my-2 rounded-lg border dark:border-claude-darkBorder border-claude-border p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
            Mermaid
          </span>
          <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary animate-pulse">
            {i18nService.t('artifactLoading')}
          </span>
        </div>
        <div className="h-32 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
      </div>
    );
  }

  // Render error with source code fallback
  if (renderError) {
    return (
      <div className="my-2 rounded-lg border border-red-300 dark:border-red-700 p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-red-500">
            {i18nService.t('artifactRenderError')}
          </span>
          <button
            type="button"
            onClick={() => setShowSource(!showSource)}
            className="text-xs text-blue-500 hover:text-blue-400"
          >
            {showSource ? i18nService.t('artifactMermaidPreview') : i18nService.t('artifactMermaidSource')}
          </button>
        </div>
        {showSource ? (
          <pre className="text-xs dark:text-claude-darkText text-claude-text overflow-x-auto whitespace-pre-wrap">
            {content}
          </pre>
        ) : (
          <pre className="text-xs text-red-500/90 whitespace-pre-wrap">
            {renderError}
          </pre>
        )}
      </div>
    );
  }

  return (
    <div className="my-2 rounded-lg border dark:border-claude-darkBorder border-claude-border overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted">
        <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
          Mermaid
        </span>
        <button
          type="button"
          onClick={() => setShowSource(!showSource)}
          className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text"
        >
          {showSource ? i18nService.t('artifactMermaidPreview') : i18nService.t('artifactMermaidSource')}
        </button>
      </div>
      <div className="p-4 dark:bg-claude-darkBg bg-white overflow-x-auto">
        {showSource ? (
          <pre className="text-xs dark:text-claude-darkText text-claude-text whitespace-pre-wrap">
            {content}
          </pre>
        ) : svgHtml ? (
          <div dangerouslySetInnerHTML={{ __html: svgHtml }} />
        ) : (
          <div className="h-32 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
        )}
      </div>
    </div>
  );
};

const MermaidBlock = React.memo(MermaidBlockInner, (prev, next) => {
  return prev.content === next.content && prev.isStreaming === next.isStreaming;
});

export default MermaidBlock;
