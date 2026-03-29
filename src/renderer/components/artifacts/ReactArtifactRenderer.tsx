import React, { useEffect, useMemo, useState } from 'react';
import reactUmdSource from '../../../../node_modules/react/umd/react.production.min.js?raw';
import reactDomUmdSource from '../../../../node_modules/react-dom/umd/react-dom.production.min.js?raw';
import { i18nService } from '../../services/i18n';

interface ReactArtifactRendererProps {
  content: string;
  title: string;
}

const buildSrcDoc = (title: string, compiledCode: string): string => `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>${title}</title>
    <style>
      html, body, #root {
        margin: 0;
        min-height: 100%;
        background: #ffffff;
      }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #111827;
      }
      #root {
        padding: 24px;
        box-sizing: border-box;
      }
      pre {
        white-space: pre-wrap;
        word-break: break-word;
      }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script>${reactUmdSource}</script>
    <script>${reactDomUmdSource}</script>
    <script>
      try {
        ${compiledCode}
        const component = window.ArtifactModule && (window.ArtifactModule.default || window.ArtifactModule);
        if (typeof component !== 'function' && typeof component !== 'object') {
          throw new Error('React artifact default export is missing.');
        }
        const root = ReactDOM.createRoot(document.getElementById('root'));
        root.render(React.createElement(component));
      } catch (error) {
        document.body.innerHTML = '<pre>' + String(error && error.message ? error.message : error) + '</pre>';
      }
    </script>
  </body>
</html>`;

const ReactArtifactRenderer: React.FC<ReactArtifactRendererProps> = ({ content, title }) => {
  const [compiledCode, setCompiledCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCompiledCode(null);
    setError(null);

    const compile = async () => {
      const result = await window.electron.artifacts.transformReact(content);
      if (cancelled) return;
      if (!result.success || !result.code) {
        setError(result.error || 'Failed to compile React artifact.');
        return;
      }
      setCompiledCode(result.code);
    };

    void compile();
    return () => {
      cancelled = true;
    };
  }, [content]);

  const srcDoc = useMemo(() => {
    if (!compiledCode) return '';
    return buildSrcDoc(title, compiledCode);
  }, [compiledCode, title]);

  if (error) {
    return (
      <div className="p-4">
        <pre className="text-sm whitespace-pre-wrap dark:text-claude-darkText text-claude-text">
          {error}
        </pre>
      </div>
    );
  }

  if (!compiledCode) {
    return (
      <div className="p-4 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
        {i18nService.t('artifactLoading')}
      </div>
    );
  }

  return (
    <div className="relative w-full h-full">
      <iframe
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        className="absolute inset-0 w-full h-full border-0"
        title={title}
      />
    </div>
  );
};

export default ReactArtifactRenderer;
