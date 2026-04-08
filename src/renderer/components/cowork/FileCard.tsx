import React, { useCallback, useState } from 'react';

import {
  DocumentIcon,
  DocumentTextIcon,
  CodeBracketIcon,
  PhotoIcon,
  GlobeAltIcon,
  TableCellsIcon,
} from '@heroicons/react/24/outline';
import {
  FolderOpenIcon,
  EyeIcon,
  ClipboardDocumentIcon,
  ArrowTopRightOnSquareIcon,
} from '@heroicons/react/24/outline';
import { CheckIcon } from '@heroicons/react/24/outline';

import { i18nService } from '../../services/i18n';
import { useFilePreview } from './FilePreviewContext';

/** Icon button with a styled tooltip shown on hover */
const IconButton: React.FC<{
  onClick: () => void;
  tooltip: string;
  children: React.ReactNode;
  className?: string;
}> = ({ onClick, tooltip, children, className = '' }) => (
  <button
    onClick={onClick}
    className={`relative group flex items-center justify-center w-7 h-7 rounded text-secondary hover:text-foreground hover:bg-surface-hover transition-colors ${className}`}
  >
    {children}
    <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-1 rounded bg-foreground text-background text-[11px] whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-50">
      {tooltip}
    </span>
  </button>
);

interface FileCardProps {
  /** Absolute file path */
  filePath: string;
  /** File content (from Write toolInput.content or Read result) */
  content?: string;
  /** Whether the tool result indicates an error */
  isError?: boolean;
  /** Tool type: 'write' or 'read' */
  toolType: 'write' | 'read';
}

const isMacOS = (): boolean => {
  return (
    navigator.platform?.toLowerCase().includes('mac') ||
    navigator.userAgent?.toLowerCase().includes('mac')
  );
};

/** Map file extensions to human-readable type labels */
const FILE_TYPE_LABELS: Record<string, string> = {
  md: 'Markdown',
  markdown: 'Markdown',
  ts: 'TypeScript',
  tsx: 'TypeScript React',
  js: 'JavaScript',
  jsx: 'JavaScript React',
  py: 'Python',
  java: 'Java',
  go: 'Go',
  rs: 'Rust',
  c: 'C',
  cpp: 'C++',
  h: 'C Header',
  cs: 'C#',
  rb: 'Ruby',
  php: 'PHP',
  swift: 'Swift',
  kt: 'Kotlin',
  html: 'HTML',
  htm: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  less: 'Less',
  json: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
  xml: 'XML',
  sql: 'SQL',
  sh: 'Shell',
  bash: 'Bash',
  zsh: 'Zsh',
  txt: 'Text',
  csv: 'CSV',
  tsv: 'TSV',
  svg: 'SVG',
  png: 'PNG Image',
  jpg: 'JPEG Image',
  jpeg: 'JPEG Image',
  gif: 'GIF Image',
  webp: 'WebP Image',
  pdf: 'PDF',
  docx: 'Word',
  xlsx: 'Excel',
  pptx: 'PowerPoint',
  toml: 'TOML',
  ini: 'INI',
  env: 'Environment',
  log: 'Log',
};

/** Get file extension (lowercase, no dot) */
const getFileExtension = (filePath: string): string => {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const basename = filePath.slice(lastSlash + 1);
  const dotIndex = basename.lastIndexOf('.');
  if (dotIndex <= 0) return '';
  return basename.slice(dotIndex + 1).toLowerCase();
};

/** Get file name from path */
const getFileName = (filePath: string): string => {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return filePath.slice(lastSlash + 1) || filePath;
};

/** Get directory from path */
const getDirectory = (filePath: string): string => {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return lastSlash >= 0 ? filePath.slice(0, lastSlash) : '';
};

/** Approximate content size in human-readable format */
const formatContentSize = (content: string): string => {
  const bytes = new Blob([content]).size;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/** Get appropriate icon component for a file extension */
const getFileIcon = (ext: string): React.FC<React.SVGProps<SVGSVGElement>> => {
  const codeExts = new Set([
    'ts',
    'tsx',
    'js',
    'jsx',
    'py',
    'java',
    'go',
    'rs',
    'c',
    'cpp',
    'h',
    'cs',
    'rb',
    'php',
    'swift',
    'kt',
    'sh',
    'bash',
    'zsh',
    'json',
    'yaml',
    'yml',
    'xml',
    'toml',
    'ini',
    'sql',
    'css',
    'scss',
    'less',
    'html',
    'htm',
    'svg',
  ]);
  const imageExts = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico']);
  const tableExts = new Set(['csv', 'tsv', 'xlsx', 'xls']);
  const webExts = new Set(['html', 'htm', 'svg']);

  if (webExts.has(ext)) return GlobeAltIcon;
  if (imageExts.has(ext)) return PhotoIcon;
  if (tableExts.has(ext)) return TableCellsIcon;
  if (codeExts.has(ext)) return CodeBracketIcon;
  if (ext === 'md' || ext === 'markdown' || ext === 'txt') return DocumentTextIcon;
  return DocumentIcon;
};

const FileCard: React.FC<FileCardProps> = ({ filePath, content, isError = false, toolType }) => {
  const [copySuccess, setCopySuccess] = useState(false);
  const { openPreview } = useFilePreview();

  const ext = getFileExtension(filePath);
  const fileName = getFileName(filePath);
  const directory = getDirectory(filePath);
  const typeLabel = FILE_TYPE_LABELS[ext] || ext.toUpperCase() || 'File';
  const sizeLabel = content ? formatContentSize(content) : null;
  const FileIcon = getFileIcon(ext);

  const handleOpenFile = useCallback(async () => {
    try {
      await window.electron.shell.openPath(filePath);
    } catch {
      console.error('[FileCard] failed to open file:', filePath);
    }
  }, [filePath]);

  const handleRevealInFolder = useCallback(async () => {
    try {
      await window.electron.shell.showItemInFolder(filePath);
    } catch {
      console.error('[FileCard] failed to reveal in folder:', filePath);
    }
  }, [filePath]);

  const handleCopyPath = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(filePath);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch {
      console.error('[FileCard] failed to copy path');
    }
  }, [filePath]);

  const handlePreview = useCallback(() => {
    if (content) {
      openPreview(filePath, content);
    }
  }, [filePath, content, openPreview]);

  const revealLabel = isMacOS()
    ? i18nService.t('fileCardRevealInFinder')
    : i18nService.t('fileCardRevealInExplorer');

  return (
    <div
      className={`rounded-lg border ${
        isError ? 'border-red-500/30 bg-red-500/5' : 'border-border bg-surface'
      }`}
    >
      {/* File info row */}
      <div className="flex items-center gap-2 px-3 py-2">
        <FileIcon
          className={`w-5 h-5 flex-shrink-0 ${isError ? 'text-red-500' : 'text-primary'}`}
        />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-foreground truncate" title={fileName}>
            {fileName}
          </div>
          <div className="text-xs text-muted truncate" title={directory}>
            {directory}
          </div>
          <div className="flex items-center gap-1 mt-0.5 truncate">
            <span className="text-[10px] text-secondary flex-shrink-0">{typeLabel}</span>
            {sizeLabel && (
              <>
                <span className="text-[10px] text-border flex-shrink-0">·</span>
                <span className="text-[10px] text-secondary flex-shrink-0">{sizeLabel}</span>
              </>
            )}
            {toolType === 'write' && !isError && (
              <>
                <span className="text-[10px] text-border flex-shrink-0">·</span>
                <span className="text-[10px] text-green-500 flex-shrink-0">
                  {i18nService.t('fileCardWriteSuccess')}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Action buttons — utility buttons are icon-only with styled tooltips */}
      <div className="flex items-center flex-wrap gap-1 px-2 py-1.5 border-t border-border bg-surfaceInset">
        <IconButton onClick={handleOpenFile} tooltip={i18nService.t('openFile')}>
          <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5 flex-shrink-0" />
        </IconButton>

        <IconButton onClick={handleRevealInFolder} tooltip={revealLabel}>
          <FolderOpenIcon className="w-3.5 h-3.5 flex-shrink-0" />
        </IconButton>

        <IconButton
          onClick={handleCopyPath}
          tooltip={
            copySuccess ? i18nService.t('fileCardCopied') : i18nService.t('fileCardCopyPath')
          }
        >
          {copySuccess ? (
            <CheckIcon className="w-3.5 h-3.5 flex-shrink-0 text-green-500" />
          ) : (
            <ClipboardDocumentIcon className="w-3.5 h-3.5 flex-shrink-0" />
          )}
        </IconButton>

        {content && (
          <button
            onClick={handlePreview}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs text-primary hover:text-primary hover:bg-primary/10 transition-colors ml-auto"
          >
            <EyeIcon className="w-3.5 h-3.5 flex-shrink-0" />
            <span>{i18nService.t('artifactPreview')}</span>
          </button>
        )}
      </div>
    </div>
  );
};

export default FileCard;
