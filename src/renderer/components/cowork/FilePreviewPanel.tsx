import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react';

import { XMarkIcon, ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline';
import { FolderOpenIcon } from '@heroicons/react/24/outline';

import { i18nService } from '../../services/i18n';
import MarkdownContent from '../MarkdownContent';
import { useFilePreview } from './FilePreviewContext';

/** Minimum and maximum panel widths in pixels */
const MIN_PANEL_WIDTH = 320;
const MAX_PANEL_WIDTH = 900;
const DEFAULT_PANEL_WIDTH = 480;

/** File extensions that should render as Markdown */
const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdx']);

/** File extensions that should render in a sandboxed iframe */
const HTML_EXTS = new Set(['html', 'htm']);

/** File extensions for images */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg']);

/** Language mapping for syntax highlighting in code fence */
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  py: 'python',
  java: 'java',
  go: 'go',
  rs: 'rust',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  kt: 'kotlin',
  css: 'css',
  scss: 'scss',
  less: 'less',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  sql: 'sql',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  toml: 'toml',
  ini: 'ini',
  svg: 'xml',
  txt: 'text',
  log: 'text',
  csv: 'csv',
  tsv: 'csv',
  env: 'bash',
};

const isMacOS = (): boolean => {
  return (
    navigator.platform?.toLowerCase().includes('mac') ||
    navigator.userAgent?.toLowerCase().includes('mac')
  );
};

const FilePreviewPanel: React.FC = () => {
  const { preview, closePreview } = useFilePreview();
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const isDraggingRef = useRef(false);
  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(0);

  // Resize drag handling
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDraggingRef.current = true;
      dragStartXRef.current = e.clientX;
      dragStartWidthRef.current = panelWidth;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [panelWidth],
  );

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;
      // Dragging left increases width (panel is on the right)
      const delta = dragStartXRef.current - e.clientX;
      const newWidth = Math.min(
        MAX_PANEL_WIDTH,
        Math.max(MIN_PANEL_WIDTH, dragStartWidthRef.current + delta),
      );
      setPanelWidth(newWidth);
    };

    const handleMouseUp = () => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  const handleOpenFile = useCallback(async () => {
    if (!preview) return;
    try {
      await window.electron.shell.openPath(preview.filePath);
    } catch {
      console.error('[FilePreviewPanel] failed to open file:', preview.filePath);
    }
  }, [preview]);

  const handleRevealInFolder = useCallback(async () => {
    if (!preview) return;
    try {
      await window.electron.shell.showItemInFolder(preview.filePath);
    } catch {
      console.error('[FilePreviewPanel] failed to reveal in folder:', preview.filePath);
    }
  }, [preview]);

  /** Rendered content based on file type */
  const renderedContent = useMemo(() => {
    if (!preview) return null;
    const { content, fileType, filePath } = preview;

    // Markdown rendering
    if (MARKDOWN_EXTS.has(fileType)) {
      return (
        <div className="p-4 overflow-y-auto h-full">
          <MarkdownContent content={content} />
        </div>
      );
    }

    // HTML rendering in sandbox
    if (HTML_EXTS.has(fileType)) {
      return (
        <iframe
          srcDoc={content}
          sandbox="allow-scripts"
          className="w-full h-full border-0 bg-white"
          title={preview.fileName}
        />
      );
    }

    // Image preview (SVG is inline, others via file:// URL)
    if (IMAGE_EXTS.has(fileType)) {
      if (fileType === 'svg') {
        return (
          <div className="p-4 flex items-center justify-center h-full overflow-auto">
            <div className="max-w-full" dangerouslySetInnerHTML={{ __html: content }} />
          </div>
        );
      }
      // For binary images, use localfile:// protocol
      return (
        <div className="p-4 flex items-center justify-center h-full overflow-auto">
          <img
            src={`localfile://${filePath}`}
            alt={preview.fileName}
            className="max-w-full max-h-full object-contain"
          />
        </div>
      );
    }

    // Code / plain text: wrap in markdown code fence for syntax highlighting
    const lang = EXT_TO_LANG[fileType] || '';
    const codeContent = lang ? `\`\`\`${lang}\n${content}\n\`\`\`` : `\`\`\`\n${content}\n\`\`\``;

    return (
      <div className="p-4 overflow-y-auto h-full">
        <MarkdownContent content={codeContent} />
      </div>
    );
  }, [preview]);

  if (!preview) return null;

  const revealLabel = isMacOS()
    ? i18nService.t('fileCardRevealInFinder')
    : i18nService.t('fileCardRevealInExplorer');

  return (
    <div className="flex-shrink-0 flex flex-row h-full" style={{ width: panelWidth }}>
      {/* Drag handle */}
      <div
        className="w-1 flex-shrink-0 cursor-col-resize bg-border hover:bg-primary/50 active:bg-primary transition-colors"
        onMouseDown={handleMouseDown}
      />

      {/* Panel content */}
      <div className="flex-1 flex flex-col min-w-0 border-l border-border bg-background">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-surface shrink-0">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-foreground truncate" title={preview.filePath}>
              {preview.fileName}
            </div>
          </div>

          {/* Action buttons */}
          <button
            onClick={handleOpenFile}
            className="p-1 rounded text-secondary hover:text-foreground hover:bg-surface-hover transition-colors"
            title={i18nService.t('openFile')}
          >
            <ArrowTopRightOnSquareIcon className="w-4 h-4" />
          </button>
          <button
            onClick={handleRevealInFolder}
            className="p-1 rounded text-secondary hover:text-foreground hover:bg-surface-hover transition-colors"
            title={revealLabel}
          >
            <FolderOpenIcon className="w-4 h-4" />
          </button>
          <button
            onClick={closePreview}
            className="p-1 rounded text-secondary hover:text-foreground hover:bg-surface-hover transition-colors"
            title={i18nService.t('fileCardClosePreview')}
          >
            <XMarkIcon className="w-4 h-4" />
          </button>
        </div>

        {/* Content area */}
        <div className="flex-1 min-h-0 overflow-hidden">{renderedContent}</div>
      </div>
    </div>
  );
};

export default FilePreviewPanel;
