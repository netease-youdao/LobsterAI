import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  FolderIcon,
  FolderOpenIcon,
  DocumentTextIcon,
  PhotoIcon,
  ChevronRightIcon,
  ArrowTopRightOnSquareIcon,
  XMarkIcon,
  MagnifyingGlassIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';

type FileEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: number;
};

type DirState = {
  entries: FileEntry[];
  loading: boolean;
  error: string | null;
  expanded: boolean;
};

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico']);

const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const getFileExtension = (name: string): string => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i).toLowerCase() : '';
};

const isImageFile = (name: string): boolean => IMAGE_EXTENSIONS.has(getFileExtension(name));

interface FileTreeItemProps {
  entry: FileEntry;
  depth: number;
  selectedPath: string | null;
  onSelect: (entry: FileEntry) => void;
  dirStates: Map<string, DirState>;
  onToggleDir: (dirPath: string) => void;
  searchQuery: string;
}

const FileTreeItem: React.FC<FileTreeItemProps> = ({
  entry,
  depth,
  selectedPath,
  onSelect,
  dirStates,
  onToggleDir,
  searchQuery,
}) => {
  const isSelected = selectedPath === entry.path;
  const dirState = entry.isDirectory ? dirStates.get(entry.path) : null;
  const isExpanded = dirState?.expanded ?? false;

  const handleClick = () => {
    if (entry.isDirectory) {
      onToggleDir(entry.path);
    } else {
      onSelect(entry);
    }
  };

  // Filter by search query
  if (searchQuery && !entry.isDirectory && !entry.name.toLowerCase().includes(searchQuery.toLowerCase())) {
    return null;
  }

  return (
    <>
      <div
        className={`group w-full flex items-center gap-1.5 px-2 py-1 text-left text-xs transition-colors rounded-md cursor-pointer
          ${isSelected
            ? 'dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:text-claude-darkText text-claude-text'
            : 'dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover/50 hover:bg-claude-surfaceHover/50'
          }`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={handleClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleClick(); }}
      >
        {entry.isDirectory ? (
          <>
            <ChevronRightIcon
              className={`h-3 w-3 flex-shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
            />
            {isExpanded
              ? <FolderOpenIcon className="h-4 w-4 flex-shrink-0 text-blue-500" />
              : <FolderIcon className="h-4 w-4 flex-shrink-0 text-blue-500" />
            }
          </>
        ) : (
          <>
            <span className="w-3 flex-shrink-0" />
            {isImageFile(entry.name)
              ? <PhotoIcon className="h-4 w-4 flex-shrink-0 text-green-500" />
              : <DocumentTextIcon className="h-4 w-4 flex-shrink-0" />
            }
          </>
        )}
        <span className="truncate flex-1">{entry.name}</span>
        <span className="text-[10px] opacity-50 flex-shrink-0 tabular-nums ml-auto">{formatFileSize(entry.size)}</span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            window.electron.shell.openPath(entry.path);
          }}
          className="flex-shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-100 dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:text-claude-darkText hover:text-claude-text transition-opacity"
          title={i18nService.t('filePanelOpenInSystem')}
        >
          <ArrowTopRightOnSquareIcon className="h-3 w-3" />
        </button>
      </div>

      {/* Render children if directory is expanded */}
      {entry.isDirectory && isExpanded && dirState && (
        <>
          {dirState.loading && (
            <div className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary py-1"
              style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
            >
              {i18nService.t('loading')}...
            </div>
          )}
          {dirState.error && (
            <div className="text-[10px] text-red-500 py-1"
              style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
            >
              {dirState.error}
            </div>
          )}
          {dirState.entries.map((child) => (
            <FileTreeItem
              key={child.path}
              entry={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
              dirStates={dirStates}
              onToggleDir={onToggleDir}
              searchQuery={searchQuery}
            />
          ))}
        </>
      )}
    </>
  );
};

interface FilePreviewProps {
  filePath: string;
  fileName: string;
}

const FilePreview: React.FC<FilePreviewProps> = ({ filePath, fileName }) => {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isBinary, setIsBinary] = useState(false);
  const [language, setLanguage] = useState<string | null>(null);
  const [isTruncated, setIsTruncated] = useState(false);
  const [isImage, setIsImage] = useState(false);
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadFile = async () => {
      setLoading(true);
      setError(null);
      setContent(null);
      setIsBinary(false);
      setIsImage(false);
      setImageDataUrl(null);

      // Check if image
      if (isImageFile(fileName)) {
        try {
          const result = await window.electron.dialog.readFileAsDataUrl(filePath);
          if (!cancelled && result.success && result.dataUrl) {
            setIsImage(true);
            setImageDataUrl(result.dataUrl);
            setLoading(false);
            return;
          }
        } catch {
          // Fall through to text read
        }
      }

      try {
        const result = await window.electron.files.readFileContent({ filePath });
        if (cancelled) return;

        if (!result.success) {
          setError(result.error || 'Failed to read file');
        } else if (result.isBinary) {
          setIsBinary(true);
        } else {
          setContent(result.content ?? '');
          setLanguage(result.language ?? null);
          setIsTruncated(result.isTruncated ?? false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Unknown error');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadFile();
    return () => { cancelled = true; };
  }, [filePath, fileName]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center dark:text-claude-darkTextSecondary text-claude-textSecondary text-xs">
        {i18nService.t('loading')}...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center text-red-500 text-xs px-4 text-center">
        {error}
      </div>
    );
  }

  if (isImage && imageDataUrl) {
    return (
      <div className="flex-1 flex items-center justify-center p-4 overflow-auto">
        <img src={imageDataUrl} alt={fileName} className="max-w-full max-h-full object-contain rounded" />
      </div>
    );
  }

  if (isBinary) {
    return (
      <div className="flex-1 flex items-center justify-center dark:text-claude-darkTextSecondary text-claude-textSecondary text-xs">
        {i18nService.t('filePanelBinaryFile')}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto">
      {isTruncated && (
        <div className="sticky top-0 px-3 py-1 text-[10px] dark:bg-amber-950/30 bg-amber-50 dark:text-amber-400 text-amber-600 border-b dark:border-claude-darkBorder border-claude-border">
          {i18nService.t('filePanelTruncated')}
        </div>
      )}
      <pre className="p-3 text-xs leading-relaxed dark:text-claude-darkText text-claude-text font-mono whitespace-pre-wrap break-all">
        <code className={language ? `language-${language}` : ''}>{content}</code>
      </pre>
    </div>
  );
};

interface FilePanelProps {
  cwd: string;
  onClose: () => void;
  onOpenInSystem: () => void;
}

const FilePanel: React.FC<FilePanelProps> = ({ cwd, onClose, onOpenInSystem }) => {
  const [dirStates, setDirStates] = useState<Map<string, DirState>>(new Map());
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [panelWidth, setPanelWidth] = useState(320);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // Load root directory on mount
  useEffect(() => {
    loadDirectory(cwd, true);
  }, [cwd]);

  const loadDirectory = useCallback(async (dirPath: string, expanded: boolean) => {
    setDirStates((prev) => {
      const next = new Map(prev);
      const existing = next.get(dirPath);
      if (existing && !expanded) {
        next.set(dirPath, { ...existing, expanded: false });
        return next;
      }
      next.set(dirPath, { entries: existing?.entries ?? [], loading: true, error: null, expanded: true });
      return next;
    });

    try {
      const result = await window.electron.files.listDirectory({ dirPath });
      setDirStates((prev) => {
        const next = new Map(prev);
        next.set(dirPath, {
          entries: result.success ? result.entries : [],
          loading: false,
          error: result.success ? null : (result.error || 'Failed to load'),
          expanded: true,
        });
        return next;
      });
    } catch (err) {
      setDirStates((prev) => {
        const next = new Map(prev);
        next.set(dirPath, {
          entries: [],
          loading: false,
          error: err instanceof Error ? err.message : 'Unknown error',
          expanded: true,
        });
        return next;
      });
    }
  }, []);

  const handleToggleDir = useCallback((dirPath: string) => {
    const state = dirStates.get(dirPath);
    if (state?.expanded) {
      setDirStates((prev) => {
        const next = new Map(prev);
        next.set(dirPath, { ...state, expanded: false });
        return next;
      });
    } else {
      loadDirectory(dirPath, true);
    }
  }, [dirStates, loadDirectory]);

  const handleSelectFile = useCallback((entry: FileEntry) => {
    setSelectedFile(entry);
  }, []);

  // Resize handling
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizeRef.current = { startX: e.clientX, startWidth: panelWidth };

    const handleMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return;
      const delta = resizeRef.current.startX - ev.clientX;
      const newWidth = Math.min(Math.max(resizeRef.current.startWidth + delta, 240), 600);
      setPanelWidth(newWidth);
    };

    const handleUp = () => {
      resizeRef.current = null;
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
    };

    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
  }, [panelWidth]);

  const rootState = dirStates.get(cwd);

  return (
    <div
      className="flex flex-col h-full border-l dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg"
      style={{ width: panelWidth }}
    >
      {/* Resize handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-claude-accent/30 z-10"
        onMouseDown={handleResizeStart}
      />

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
        <span className="text-sm font-medium dark:text-claude-darkText text-claude-text">
          {i18nService.t('filePanelTitle')}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onOpenInSystem}
            className="p-1 rounded dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
            title={i18nService.t('filePanelOpenInSystem')}
          >
            <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
            title={i18nService.t('close')}
          >
            <XMarkIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="px-3 py-2 shrink-0">
        <div className="relative">
          <MagnifyingGlassIcon className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={i18nService.t('filePanelSearch')}
            className="w-full pl-7 pr-2 py-1.5 rounded-md text-xs dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text dark:border-claude-darkBorder border-claude-border border focus:outline-none focus:ring-1 focus:ring-claude-accent"
          />
        </div>
      </div>

      {/* File tree + Preview split */}
      <div className="flex-1 flex flex-col min-h-0">
        {/* File tree */}
        <div className={`overflow-y-auto px-1 ${selectedFile ? 'h-1/2 border-b dark:border-claude-darkBorder border-claude-border' : 'flex-1'}`}>
          {rootState?.loading && !rootState.entries.length ? (
            <div className="flex items-center justify-center py-8 dark:text-claude-darkTextSecondary text-claude-textSecondary text-xs">
              {i18nService.t('loading')}...
            </div>
          ) : rootState?.error ? (
            <div className="flex items-center justify-center py-8 text-red-500 text-xs">
              {rootState.error}
            </div>
          ) : (
            rootState?.entries.map((entry) => (
              <FileTreeItem
                key={entry.path}
                entry={entry}
                depth={0}
                selectedPath={selectedFile?.path ?? null}
                onSelect={handleSelectFile}
                dirStates={dirStates}
                onToggleDir={handleToggleDir}
                searchQuery={searchQuery}
              />
            ))
          )}
        </div>

        {/* File preview */}
        {selectedFile ? (
          <div className="h-1/2 flex flex-col min-h-0">
            <div className="flex items-center justify-between px-3 py-1.5 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
              <span className="text-xs font-medium dark:text-claude-darkText text-claude-text truncate">
                {selectedFile.name}
              </span>
              <button
                type="button"
                onClick={() => setSelectedFile(null)}
                className="p-0.5 rounded dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
              >
                <XMarkIcon className="h-3 w-3" />
              </button>
            </div>
            <FilePreview filePath={selectedFile.path} fileName={selectedFile.name} />
          </div>
        ) : (
          <div className="hidden" />
        )}
      </div>
    </div>
  );
};

export default FilePanel;
