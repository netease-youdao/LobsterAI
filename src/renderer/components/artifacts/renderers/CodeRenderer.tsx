import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { xml } from '@codemirror/lang-xml';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';
import React, { useEffect, useMemo, useState } from 'react';

import { i18nService } from '@/services/i18n';
import type { Artifact } from '@/types/artifact';

const MAX_SOURCE_DISPLAY_CHARS = 2_000_000;

const t = (key: string) => i18nService.t(key);

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

const LANGUAGE_MAP: Record<string, string> = {
  html: 'html',
  svg: 'xml',
  mermaid: 'markdown',
  markdown: 'markdown',
  react: 'jsx',
  jsx: 'jsx',
  tsx: 'tsx',
  ts: 'typescript',
  js: 'javascript',
  css: 'css',
  json: 'json',
};

function getLanguageExtension(language: string): Extension | null {
  switch (language.toLowerCase()) {
    case 'html':
      return html();
    case 'xml':
    case 'svg':
      return xml();
    case 'css':
      return css();
    case 'javascript':
    case 'js':
      return javascript();
    case 'jsx':
    case 'react':
      return javascript({ jsx: true });
    case 'typescript':
    case 'ts':
      return javascript({ typescript: true });
    case 'tsx':
      return javascript({ jsx: true, typescript: true });
    case 'json':
      return json();
    case 'markdown':
    case 'md':
    case 'mermaid':
      return markdown();
    default:
      return null;
  }
}

function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const baseTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: 'var(--lobster-code-font-size)',
  },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    lineHeight: '1.5',
    overflow: 'auto',
  },
  '.cm-content': {
    minHeight: '100%',
  },
  '.cm-gutters': {
    borderRightWidth: '1px',
  },
});

const lightTheme = EditorView.theme({
  '&': {
    backgroundColor: '#f0f2f5',
    color: '#383a42',
  },
  '.cm-editor, .cm-scroller': {
    backgroundColor: '#f0f2f5',
  },
  '.cm-gutters': {
    backgroundColor: '#f0f2f5',
    color: '#8a9099',
    borderRightColor: '#d7dce2',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
  },
}, { dark: false });

const darkTheme = EditorView.theme({
  '&': {
    backgroundColor: '#282c34',
    color: '#abb2bf',
  },
  '.cm-editor, .cm-scroller': {
    backgroundColor: '#282c34',
  },
  '.cm-gutters': {
    backgroundColor: '#282c34',
    color: '#6f7785',
    borderRightColor: '#3b4049',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
  },
}, { dark: true });

interface CodeRendererProps {
  artifact: Artifact;
}

const CodeRenderer: React.FC<CodeRendererProps> = ({ artifact }) => {
  const isDark = useIsDark();
  const [fileContent, setFileContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fileTruncated, setFileTruncated] = useState(false);
  const [fileSize, setFileSize] = useState<number | undefined>(undefined);
  const [fileReadBytes, setFileReadBytes] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (artifact.content || !artifact.filePath) {
      setFileContent('');
      setLoading(false);
      setLoadError(null);
      setFileTruncated(false);
      setFileSize(undefined);
      setFileReadBytes(undefined);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setFileTruncated(false);
    setFileSize(undefined);
    setFileReadBytes(undefined);

    window.electron.dialog.readTextFile(artifact.filePath)
      .then(result => {
        if (cancelled) return;
        if (result.success && typeof result.content === 'string') {
          setFileContent(result.content);
          setFileTruncated(Boolean(result.truncated));
          setFileSize(result.size);
          setFileReadBytes(result.readBytes);
          return;
        }
        setLoadError(result.error || t('artifactSourceLoadFailed'));
      })
      .catch(error => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : t('artifactSourceLoadFailed'));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [artifact.content, artifact.contentVersion, artifact.filePath]);

  const sourceContent = artifact.content || fileContent;
  const renderTruncated = sourceContent.length > MAX_SOURCE_DISPLAY_CHARS;
  const displayContent = renderTruncated
    ? sourceContent.slice(0, MAX_SOURCE_DISPLAY_CHARS)
    : sourceContent;
  const language = artifact.language || LANGUAGE_MAP[artifact.type] || 'text';
  const truncatedDisplaySize = fileTruncated
    ? fileReadBytes
    : Math.min(sourceContent.length, MAX_SOURCE_DISPLAY_CHARS);

  const extensions = useMemo(() => {
    const languageExtension = getLanguageExtension(language);
    return [
      baseTheme,
      isDark ? darkTheme : lightTheme,
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      EditorView.editable.of(false),
      ...(languageExtension ? [languageExtension] : []),
    ];
  }, [isDark, language]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted">
        {t('artifactSourceLoading')}
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted">
        {t('artifactSourceLoadFailed')}: {loadError}
      </div>
    );
  }

  if (!displayContent) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted">
        {t('artifactNoContent')}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {(fileTruncated || renderTruncated) && (
        <div className="shrink-0 border-b border-border bg-surface px-3 py-1.5 text-xs text-secondary">
          {t('artifactSourceTruncated').replace('{size}', formatBytes(truncatedDisplaySize) || formatBytes(fileSize))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        <CodeMirror
          className="h-full"
          value={displayContent}
          height="100%"
          theme={isDark ? 'dark' : 'light'}
          extensions={extensions}
          editable={false}
          readOnly
          basicSetup={{
            lineNumbers: true,
            foldGutter: false,
            highlightActiveLine: false,
            highlightActiveLineGutter: false,
            indentOnInput: false,
            bracketMatching: true,
            closeBrackets: false,
            autocompletion: false,
            rectangularSelection: false,
            crosshairCursor: false,
            highlightSelectionMatches: false,
            searchKeymap: true,
            defaultKeymap: true,
            history: false,
            historyKeymap: false,
            foldKeymap: false,
            completionKeymap: false,
            lintKeymap: false,
          }}
        />
      </div>
    </div>
  );
};

export default CodeRenderer;
