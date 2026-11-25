import { HighlightStyle, type LanguageSupport, syntaxHighlighting } from '@codemirror/language';
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import { CheckIcon, DocumentDuplicateIcon } from '@heroicons/react/24/outline';
import { tags as highlightTags } from '@lezer/highlight';
import CodeMirror from '@uiw/react-codemirror';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { loadCodeLanguage, resolveCodeLanguage } from '@/codeHighlight/language';
import { copyTextToClipboard } from '@/services/clipboard';
import { i18nService } from '@/services/i18n';
import type { Artifact } from '@/types/artifact';

import {
  type ArtifactCodeControlsConfig,
  useArtifactCodeControlsHost,
  useRegisterArtifactCodeControls,
} from '../ArtifactCodeControlsContext';

const MAX_SOURCE_DISPLAY_CHARS = 2_000_000;
const COPY_FEEDBACK_MS = 1800;

const t = (key: string) => i18nService.t(key);

function useIsDark() {
  const [isDark, setIsDark] = useState(() =>
    document.documentElement.classList.contains('dark'),
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

const TYPE_LANGUAGE_FALLBACK: Record<string, string> = {
  html: 'html',
  svg: 'xml',
  mermaid: 'markdown',
  markdown: 'markdown',
};

function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const oneLightHighlightStyle = HighlightStyle.define([
  { tag: highlightTags.keyword, color: '#a626a4' },
  { tag: [highlightTags.name, highlightTags.deleted, highlightTags.character, highlightTags.propertyName, highlightTags.macroName], color: '#c43e33' },
  { tag: [highlightTags.function(highlightTags.variableName), highlightTags.labelName], color: '#4078f2' },
  { tag: [highlightTags.color, highlightTags.constant(highlightTags.name), highlightTags.standard(highlightTags.name)], color: '#986801' },
  { tag: [highlightTags.definition(highlightTags.name), highlightTags.separator], color: '#383a42' },
  { tag: [highlightTags.typeName, highlightTags.className, highlightTags.number, highlightTags.changed, highlightTags.annotation, highlightTags.modifier, highlightTags.self, highlightTags.namespace], color: '#0b6bcb' },
  { tag: [highlightTags.operator, highlightTags.operatorKeyword, highlightTags.url, highlightTags.escape, highlightTags.regexp, highlightTags.link, highlightTags.special(highlightTags.string)], color: '#0184bc' },
  { tag: [highlightTags.meta, highlightTags.comment], color: '#8a9099' },
  { tag: highlightTags.strong, fontWeight: 'bold' },
  { tag: highlightTags.emphasis, fontStyle: 'italic' },
  { tag: highlightTags.strikethrough, textDecoration: 'line-through' },
  { tag: highlightTags.link, color: '#8a9099', textDecoration: 'underline' },
  { tag: highlightTags.heading, fontWeight: 'bold', color: '#e45649' },
  { tag: [highlightTags.atom, highlightTags.bool, highlightTags.special(highlightTags.variableName)], color: '#986801' },
  { tag: [highlightTags.processingInstruction, highlightTags.string, highlightTags.inserted], color: '#2b8a3e' },
  { tag: highlightTags.invalid, color: '#ca1243' },
]);

const baseTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: 'var(--lobster-code-font-size)',
  },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    lineHeight: '1.65',
    overflow: 'auto',
    paddingTop: '12px',
    paddingBottom: '20px',
  },
  '.cm-content': {
    minHeight: '100%',
    paddingRight: '16px',
  },
  '.cm-gutters': {
    borderRight: 'none',
    paddingLeft: '8px',
    paddingRight: '12px',
    userSelect: 'none',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    minWidth: '28px',
    padding: '0 4px 0 0',
  },
});

const lightTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    color: '#24292f',
  },
  '.cm-editor, .cm-scroller': {
    backgroundColor: 'transparent',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: '#9ca3af',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
  },
}, { dark: false });

const darkTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    color: '#abb2bf',
  },
  '.cm-editor, .cm-scroller': {
    backgroundColor: 'transparent',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: '#6f7785',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
  },
}, { dark: true });

const WordWrapIcon: React.FC<{ className?: string }> = ({ className = 'h-3.5 w-3.5' }) => (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <line x1="2.5" y1="3.5" x2="13.5" y2="3.5" />
    <path d="M2.5 8h8.25a2.25 2.25 0 0 1 0 4.5H9" />
    <polyline points="10.5 10.75 8.75 12.5 10.5 14.25" />
    <line x1="2.5" y1="12.5" x2="5.5" y2="12.5" />
  </svg>
);

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
  const [languageSupport, setLanguageSupport] = useState<LanguageSupport | null>(null);
  const [wrapLines, setWrapLines] = useState(true);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => () => {
    if (copyTimerRef.current !== undefined) {
      window.clearTimeout(copyTimerRef.current);
    }
  }, []);

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

  const rawLanguageHint = artifact.language || TYPE_LANGUAGE_FALLBACK[artifact.type];
  const languageDescription = useMemo(
    () => resolveCodeLanguage(rawLanguageHint, artifact.fileName || artifact.filePath),
    [artifact.fileName, artifact.filePath, rawLanguageHint],
  );

  useEffect(() => {
    if (!languageDescription) {
      setLanguageSupport(null);
      return;
    }
    let cancelled = false;
    void loadCodeLanguage(languageDescription)
      .then(support => {
        if (!cancelled) setLanguageSupport(support);
      })
      .catch(() => {
        if (!cancelled) setLanguageSupport(null);
      });
    return () => {
      cancelled = true;
    };
  }, [languageDescription]);

  const sourceContent = artifact.content || fileContent;
  const renderTruncated = sourceContent.length > MAX_SOURCE_DISPLAY_CHARS;
  const displayContent = renderTruncated
    ? sourceContent.slice(0, MAX_SOURCE_DISPLAY_CHARS)
    : sourceContent;
  const displayLanguage = (
    languageDescription?.name
    || rawLanguageHint
    || 'text'
  ).toLowerCase();
  const truncatedDisplaySize = fileTruncated
    ? fileReadBytes
    : Math.min(sourceContent.length, MAX_SOURCE_DISPLAY_CHARS);

  const extensions = useMemo(() => [
    baseTheme,
    isDark ? darkTheme : lightTheme,
    syntaxHighlighting(isDark ? oneDarkHighlightStyle : oneLightHighlightStyle, { fallback: true }),
    EditorView.editable.of(false),
    ...(wrapLines ? [EditorView.lineWrapping] : []),
    ...(languageSupport ? [languageSupport] : []),
  ], [isDark, languageSupport, wrapLines]);

  const handleToggleWrapLines = useCallback(() => {
    setWrapLines(prev => !prev);
  }, []);

  const handleCopyCode = useCallback(async () => {
    if (!sourceContent) return;
    const ok = await copyTextToClipboard(sourceContent);
    if (!ok) return;
    setCopied(true);
    if (copyTimerRef.current !== undefined) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => {
      copyTimerRef.current = undefined;
      setCopied(false);
    }, COPY_FEEDBACK_MS);
  }, [sourceContent]);

  const codeControlsHost = useArtifactCodeControlsHost();
  const hasHostToolbar = Boolean(codeControlsHost);
  const codeControlsConfig = useMemo<ArtifactCodeControlsConfig | null>(() => {
    if (loading || loadError || !displayContent) return null;
    return {
      languageLabel: displayLanguage,
      wrapLines,
      onToggleWrapLines: handleToggleWrapLines,
      copied,
      onCopyCode: () => { void handleCopyCode(); },
    };
  }, [copied, displayContent, displayLanguage, handleCopyCode, handleToggleWrapLines, loadError, loading, wrapLines]);
  useRegisterArtifactCodeControls(codeControlsConfig);

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
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {!hasHostToolbar && (
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/60 px-4">
          <span className="font-mono text-xs text-secondary select-none">
            {displayLanguage}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleToggleWrapLines}
              title={t('artifactCodeWordWrap')}
              aria-label={t('artifactCodeWordWrap')}
              aria-pressed={wrapLines}
              className={`inline-flex h-6 w-6 items-center justify-center rounded transition-colors ${
                wrapLines
                  ? 'bg-surface-raised text-foreground'
                  : 'text-secondary hover:bg-surface hover:text-foreground'
              }`}
            >
              <WordWrapIcon />
            </button>
            <button
              type="button"
              onClick={() => void handleCopyCode()}
              title={copied ? t('artifactCodeCopied') : t('artifactCopyCode')}
              aria-label={copied ? t('artifactCodeCopied') : t('artifactCopyCode')}
              className="inline-flex h-6 w-6 items-center justify-center rounded text-secondary transition-colors hover:bg-surface hover:text-foreground"
            >
              {copied ? (
                <CheckIcon className="h-3.5 w-3.5 text-emerald-600" />
              ) : (
                <DocumentDuplicateIcon className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </div>
      )}
      {(fileTruncated || renderTruncated) && (
        <div className="shrink-0 border-b border-border bg-surface px-4 py-1.5 text-xs text-secondary">
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
