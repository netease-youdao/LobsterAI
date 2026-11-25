import {
  ArrowPathIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DocumentPlusIcon,
  EyeIcon,
  EyeSlashIcon,
  FolderIcon,
  FolderOpenIcon,
  MagnifyingGlassIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import {
  type WorkspaceDirectoryEntry,
  WorkspaceDirectoryEntryKind,
} from '@shared/artifactPreview/blankDocument';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { normalizeFilePathForDedup } from '@/services/artifactParser';
import {
  listWorkspaceDirectory,
  openWorkspaceDirectoryInSystem,
} from '@/services/artifactWorkspace';
import { i18nService } from '@/services/i18n';

import LocalFileContextMenu from '../common/LocalFileContextMenu';
import FileTypeIcon from '../icons/fileTypes/FileTypeIcon';
import Tooltip, { TooltipAlign, TooltipPosition } from '../ui/Tooltip';
import {
  type DirectoryLoadState,
  filterRefreshableExpandedDirs,
  flattenWorkspaceTree,
  normalizeDirectoryKey,
  splitWorkspacePathHeader,
  type WorkspaceTreeRow,
  WorkspaceTreeRowKind,
} from './workspaceFileTreeModel';

const t = (key: string) => i18nService.t(key);

const MAX_CACHED_VIEW_STATES = 50;
const persistedExpandedDirsByScope = new Map<string, Set<string>>();
const persistedIncludeHiddenByScope = new Map<string, boolean>();

function rememberExpandedDirs(scopeKey: string, dirs: Set<string>): void {
  persistedExpandedDirsByScope.delete(scopeKey);
  persistedExpandedDirsByScope.set(scopeKey, new Set(dirs));
  if (persistedExpandedDirsByScope.size > MAX_CACHED_VIEW_STATES) {
    const oldestKey = persistedExpandedDirsByScope.keys().next().value;
    if (oldestKey !== undefined) persistedExpandedDirsByScope.delete(oldestKey);
  }
}

function rememberIncludeHidden(scopeKey: string, includeHidden: boolean): void {
  persistedIncludeHiddenByScope.delete(scopeKey);
  persistedIncludeHiddenByScope.set(scopeKey, includeHidden);
  if (persistedIncludeHiddenByScope.size > MAX_CACHED_VIEW_STATES) {
    const oldestKey = persistedIncludeHiddenByScope.keys().next().value;
    if (oldestKey !== undefined) persistedIncludeHiddenByScope.delete(oldestKey);
  }
}

export const WorkspaceFileBrowserVariant = {
  Full: 'full',
  Drawer: 'drawer',
} as const;

export type WorkspaceFileBrowserVariant =
  typeof WorkspaceFileBrowserVariant[keyof typeof WorkspaceFileBrowserVariant];

interface WorkspaceFileBrowserProps {
  sessionId: string;
  workingDirectory: string;
  activeFilePath?: string | null;
  isActive?: boolean;
  refreshTrigger?: string;
  variant?: WorkspaceFileBrowserVariant;
  externalFilterQuery?: string;
  onOpenFile: (filePath: string) => Promise<void> | void;
  onOpenLocalFile?: () => void;
  onCreateBlankDocument?: () => void;
  onRevealWorkspace?: () => void;
}

interface ContextMenuState {
  filePath: string;
  isDirectory: boolean;
  position: { x: number; y: number };
}

const TOOLBAR_TOOLTIP_BUBBLE_CLASS =
  'rounded-lg border border-black/10 bg-[#1F242D] px-2.5 py-1 text-[11px] font-medium text-white shadow-[0_10px_28px_rgba(15,23,42,0.22)] dark:border-white/10 dark:bg-[#2B313C]';

const ToolbarIconButton: React.FC<{
  label: string;
  active?: boolean;
  disabled?: boolean;
  align?: TooltipAlign;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ label, active = false, disabled = false, align = TooltipAlign.Center, onClick, children }) => (
  <Tooltip
    portal
    content={label}
    position={TooltipPosition.Bottom}
    align={align}
    delay={280}
    bubbleClassName={TOOLBAR_TOOLTIP_BUBBLE_CLASS}
    className="shrink-0"
  >
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={`inline-flex h-6 w-6 items-center justify-center rounded transition-colors disabled:opacity-50 ${
        active
          ? 'bg-primary/10 text-primary'
          : 'text-secondary hover:bg-surface hover:text-foreground'
      }`}
    >
      {children}
    </button>
  </Tooltip>
);

const WorkspaceFileBrowser: React.FC<WorkspaceFileBrowserProps> = ({
  sessionId,
  workingDirectory,
  activeFilePath,
  isActive = true,
  refreshTrigger,
  variant = WorkspaceFileBrowserVariant.Full,
  externalFilterQuery,
  onOpenFile,
  onOpenLocalFile,
  onCreateBlankDocument,
  onRevealWorkspace,
}) => {
  const isDrawerVariant = variant === WorkspaceFileBrowserVariant.Drawer;
  const normalizedWorkingDirectory = useMemo(
    () => normalizeDirectoryKey(workingDirectory),
    [workingDirectory],
  );
  const scopeKey = `${sessionId}\0${normalizedWorkingDirectory}`;
  const [resolvedRootPath, setResolvedRootPath] = useState(() => normalizedWorkingDirectory);
  const [dirStates, setDirStates] = useState<Record<string, DirectoryLoadState>>({});
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(
    () => new Set(persistedExpandedDirsByScope.get(scopeKey) ?? []),
  );
  const [includeHidden, setIncludeHidden] = useState<boolean>(
    () => persistedIncludeHiddenByScope.get(scopeKey) ?? false,
  );
  const [showFilter, setShowFilter] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const [isDrawerSectionExpanded, setIsDrawerSectionExpanded] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [openingFilePath, setOpeningFilePath] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const filterInputRef = useRef<HTMLInputElement>(null);
  const treeContainerRef = useRef<HTMLDivElement>(null);
  const expandedDirsRef = useRef<Set<string>>(expandedDirs);
  const includeHiddenRef = useRef<boolean>(includeHidden);
  const loadGenerationRef = useRef(0);
  const previousActiveRef = useRef(isActive);
  const previousScopeForActiveRef = useRef(scopeKey);
  const previousTriggerRef = useRef(refreshTrigger);
  const previousScopeForTriggerRef = useRef(scopeKey);

  const normalizedRootKey = useMemo(
    () => normalizeDirectoryKey(resolvedRootPath || normalizedWorkingDirectory),
    [normalizedWorkingDirectory, resolvedRootPath],
  );

  const loadDirectory = useCallback(async (
    targetPath: string | undefined,
    options: { includeHidden: boolean; generation: number; keepExistingEntries?: boolean },
  ): Promise<string | null> => {
    const requestedKey = normalizeDirectoryKey(targetPath || normalizedWorkingDirectory);
    if (requestedKey) {
      setDirStates(prev => {
        const current = prev[requestedKey];
        if (options.keepExistingEntries && current) {
          return { ...prev, [requestedKey]: { ...current, loading: true, error: null } };
        }
        return {
          ...prev,
          [requestedKey]: {
            entries: current?.entries ?? [],
            loading: true,
            error: null,
            truncated: current?.truncated ?? false,
            totalCount: current?.totalCount ?? 0,
          },
        };
      });
    }

    const result = await listWorkspaceDirectory({
      sessionId,
      cwd: normalizedWorkingDirectory,
      targetPath,
      includeHidden: options.includeHidden,
    });

    if (loadGenerationRef.current !== options.generation) {
      return null;
    }

    if (result.success) {
      const nextRoot = normalizeDirectoryKey(result.rootPath);
      const nextDirKey = normalizeDirectoryKey(result.directoryPath);
      setResolvedRootPath(nextRoot);
      setDirStates(prev => ({
        ...prev,
        [nextDirKey]: {
          entries: result.entries,
          loading: false,
          error: null,
          truncated: result.truncated,
          totalCount: result.totalCount,
        },
      }));
      return nextDirKey;
    }

    const fallbackKey = normalizeDirectoryKey(result.directoryPath || targetPath || normalizedWorkingDirectory) || '__root__';
    setDirStates(prev => ({
      ...prev,
      [fallbackKey]: {
        entries: prev[fallbackKey]?.entries ?? [],
        loading: false,
        error: result.error || t('workspaceFilesLoadFailed'),
        truncated: false,
        totalCount: 0,
      },
    }));
    return null;
  }, [normalizedWorkingDirectory, sessionId]);

  const refreshLoadedTree = useCallback(async (options?: {
    resetExpanded?: boolean;
    includeHidden?: boolean;
  }) => {
    const effectiveIncludeHidden = options?.includeHidden ?? includeHiddenRef.current;
    const generation = ++loadGenerationRef.current;
    setIsRefreshing(true);

    if (options?.resetExpanded) {
      const restoredExpanded = new Set(persistedExpandedDirsByScope.get(scopeKey) ?? []);
      expandedDirsRef.current = restoredExpanded;
      setExpandedDirs(restoredExpanded);
      setDirStates({});
      setResolvedRootPath(normalizedWorkingDirectory);
    }

    try {
      const rootKey = await loadDirectory(undefined, {
        includeHidden: effectiveIncludeHidden,
        generation,
        keepExistingEntries: !options?.resetExpanded,
      });
      if (!rootKey || loadGenerationRef.current !== generation) return;

      const expandedList = filterRefreshableExpandedDirs(
        rootKey,
        expandedDirsRef.current,
        effectiveIncludeHidden,
      );
      if (expandedList.length > 0) {
        await Promise.all(
          expandedList.map(dirPath =>
            loadDirectory(dirPath, {
              includeHidden: effectiveIncludeHidden,
              generation,
              keepExistingEntries: true,
            }),
          ),
        );
      }
    } finally {
      if (loadGenerationRef.current === generation) {
        setIsRefreshing(false);
      }
    }
  }, [loadDirectory, normalizedWorkingDirectory, scopeKey]);

  // Reload whenever workspace directory or session changes.
  useEffect(() => {
    const restoredHidden = persistedIncludeHiddenByScope.get(scopeKey) ?? false;
    includeHiddenRef.current = restoredHidden;
    setIncludeHidden(restoredHidden);
    setContextMenu(null);
    void refreshLoadedTree({
      resetExpanded: true,
      includeHidden: restoredHidden,
    });
    return () => {
      loadGenerationRef.current += 1;
    };
  }, [refreshLoadedTree, scopeKey]);

  // Refresh silently when switching back to the Files tab.
  useEffect(() => {
    const wasActive = previousActiveRef.current;
    previousActiveRef.current = isActive;
    if (previousScopeForActiveRef.current !== scopeKey) {
      previousScopeForActiveRef.current = scopeKey;
      return;
    }
    if (!wasActive && isActive) {
      void refreshLoadedTree({ resetExpanded: false });
    }
  }, [isActive, refreshLoadedTree, scopeKey]);

  // Refresh when session artifacts change (e.g. agent created/renamed a file).
  useEffect(() => {
    const previousTrigger = previousTriggerRef.current;
    previousTriggerRef.current = refreshTrigger;
    if (previousScopeForTriggerRef.current !== scopeKey) {
      previousScopeForTriggerRef.current = scopeKey;
      return;
    }
    if (previousTrigger !== refreshTrigger && isActive) {
      void refreshLoadedTree({ resetExpanded: false });
    }
  }, [isActive, refreshLoadedTree, refreshTrigger, scopeKey]);

  useEffect(() => {
    if (!showFilter) return;
    const frame = window.requestAnimationFrame(() => {
      filterInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [showFilter]);

  const handleToggleIncludeHidden = useCallback(() => {
    const nextIncludeHidden = !includeHiddenRef.current;
    includeHiddenRef.current = nextIncludeHidden;
    rememberIncludeHidden(scopeKey, nextIncludeHidden);
    setIncludeHidden(nextIncludeHidden);
    void refreshLoadedTree({
      resetExpanded: false,
      includeHidden: nextIncludeHidden,
    });
  }, [refreshLoadedTree, scopeKey]);

  const toggleDirectory = useCallback((dirPath: string) => {
    const dirKey = normalizeDirectoryKey(dirPath);
    if (!dirKey) return;

    const currentlyExpanded = expandedDirsRef.current.has(dirKey);
    const nextExpanded = new Set(expandedDirsRef.current);
    if (currentlyExpanded) {
      nextExpanded.delete(dirKey);
    } else {
      nextExpanded.add(dirKey);
    }
    expandedDirsRef.current = nextExpanded;
    rememberExpandedDirs(scopeKey, nextExpanded);
    setExpandedDirs(nextExpanded);

    if (!currentlyExpanded) {
      const generation = loadGenerationRef.current;
      void loadDirectory(dirKey, {
        includeHidden: includeHiddenRef.current,
        generation,
        keepExistingEntries: true,
      });
    }
  }, [loadDirectory, scopeKey]);

  const handleOpenFileEntry = useCallback(async (filePath: string) => {
    if (openingFilePath === filePath) return;
    setOpeningFilePath(filePath);
    try {
      await onOpenFile(filePath);
    } finally {
      setOpeningFilePath(current => (current === filePath ? null : current));
    }
  }, [onOpenFile, openingFilePath]);

  const handleEntryClick = useCallback((entry: WorkspaceDirectoryEntry) => {
    if (entry.kind === WorkspaceDirectoryEntryKind.Directory) {
      toggleDirectory(entry.path);
      return;
    }
    void handleOpenFileEntry(entry.path);
  }, [handleOpenFileEntry, toggleDirectory]);

  const handleEntryContextMenu = useCallback((
    event: React.MouseEvent,
    entry: WorkspaceDirectoryEntry,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      filePath: entry.path,
      isDirectory: entry.kind === WorkspaceDirectoryEntryKind.Directory,
      position: { x: event.clientX, y: event.clientY },
    });
  }, []);

  const handleRevealWorkspace = useCallback(() => {
    if (onRevealWorkspace) {
      onRevealWorkspace();
      return;
    }
    if (normalizedRootKey) {
      void openWorkspaceDirectoryInSystem(normalizedRootKey);
    }
  }, [normalizedRootKey, onRevealWorkspace]);

  const effectiveFilterQuery = isDrawerVariant ? (externalFilterQuery ?? '') : filterQuery;

  const rows = useMemo(
    () => flattenWorkspaceTree(normalizedRootKey, dirStates, expandedDirs, effectiveFilterQuery),
    [dirStates, effectiveFilterQuery, expandedDirs, normalizedRootKey],
  );

  const rootState = dirStates[normalizedRootKey] ?? dirStates.__root__;
  const isInitialLoading = Boolean(!rootState || (rootState.loading && rootState.entries.length === 0));
  const rootError = !isInitialLoading ? (rootState?.error ?? null) : null;
  const isWorkspaceEmpty = Boolean(
    !isInitialLoading && !rootError && (rootState?.entries.length ?? 0) === 0,
  );
  const activePathKey = useMemo(
    () => (activeFilePath ? normalizeFilePathForDedup(activeFilePath) : ''),
    [activeFilePath],
  );
  const pathHeader = useMemo(
    () => splitWorkspacePathHeader(normalizedRootKey),
    [normalizedRootKey],
  );

  const handleRowKeyDown = useCallback((
    event: React.KeyboardEvent<HTMLButtonElement>,
    row: Extract<WorkspaceTreeRow, { kind: typeof WorkspaceTreeRowKind.Entry }>,
    rowIndex: number,
  ) => {
    const buttons = Array.from(
      treeContainerRef.current?.querySelectorAll<HTMLButtonElement>('[data-workspace-tree-row="true"]') ?? [],
    );
    const currentButtonIndex = buttons.indexOf(event.currentTarget);

    if (event.key === 'ArrowDown' && currentButtonIndex >= 0 && currentButtonIndex + 1 < buttons.length) {
      event.preventDefault();
      buttons[currentButtonIndex + 1]?.focus();
      return;
    }
    if (event.key === 'ArrowUp' && currentButtonIndex > 0) {
      event.preventDefault();
      buttons[currentButtonIndex - 1]?.focus();
      return;
    }
    if (row.entry.kind === WorkspaceDirectoryEntryKind.Directory) {
      if (event.key === 'ArrowRight' && !row.isExpanded) {
        event.preventDefault();
        toggleDirectory(row.entry.path);
        return;
      }
      if (event.key === 'ArrowLeft' && row.isExpanded) {
        event.preventDefault();
        toggleDirectory(row.entry.path);
        return;
      }
    }
    if (event.key === 'ArrowLeft' && row.depth > 0) {
      for (let index = rowIndex - 1; index >= 0; index -= 1) {
        const candidate = rows[index];
        if (
          candidate?.kind === WorkspaceTreeRowKind.Entry
          && candidate.depth === row.depth - 1
          && candidate.entry.kind === WorkspaceDirectoryEntryKind.Directory
        ) {
          event.preventDefault();
          const targetButton = treeContainerRef.current?.querySelector<HTMLButtonElement>(
            `[data-workspace-entry-key="${CSS.escape(candidate.key)}"]`,
          );
          targetButton?.focus();
          return;
        }
      }
    }
  }, [rows, toggleDirectory]);

  if (isDrawerVariant) {
    const isExpandedSection = isDrawerSectionExpanded || Boolean(effectiveFilterQuery.trim());
    return (
      <div className="flex flex-col">
        <div className="group flex items-center gap-1 rounded-md px-1 py-1">
          <button
            type="button"
            onClick={() => setIsDrawerSectionExpanded(prev => !prev)}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-medium text-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            title={normalizedRootKey}
            aria-expanded={isExpandedSection}
          >
            {isExpandedSection ? (
              <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
            ) : (
              <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
            )}
            <FolderIcon className="h-3.5 w-3.5 shrink-0 text-secondary" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">
              {pathHeader.currentName || normalizedRootKey || t('artifactFiles')}
            </span>
          </button>
          <div className="flex shrink-0 items-center gap-0.5 opacity-75 transition-opacity group-hover:opacity-100">
            <ToolbarIconButton
              label={includeHidden ? t('workspaceFilesHideHidden') : t('workspaceFilesShowHidden')}
              active={includeHidden}
              onClick={handleToggleIncludeHidden}
            >
              {includeHidden ? (
                <EyeIcon className="h-3.5 w-3.5" />
              ) : (
                <EyeSlashIcon className="h-3.5 w-3.5" />
              )}
            </ToolbarIconButton>
            <ToolbarIconButton
              label={t('artifactRefresh')}
              disabled={isRefreshing}
              onClick={() => void refreshLoadedTree({ resetExpanded: false })}
            >
              <ArrowPathIcon className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
            </ToolbarIconButton>
            <ToolbarIconButton
              label={t('artifactNewTabRevealWorkspace')}
              align={TooltipAlign.End}
              onClick={handleRevealWorkspace}
            >
              <FolderOpenIcon className="h-3.5 w-3.5" />
            </ToolbarIconButton>
          </div>
        </div>

        {isExpandedSection && (
          isInitialLoading ? (
            <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-muted">
              <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" />
              <span>{t('loading')}</span>
            </div>
          ) : rootError ? (
            <div className="px-3 py-2 text-xs text-muted">
              <p className="break-words">{rootError}</p>
              <button
                type="button"
                onClick={() => void refreshLoadedTree({ resetExpanded: false })}
                className="mt-1.5 inline-flex items-center gap-1 text-primary hover:underline"
              >
                <ArrowPathIcon className="h-3 w-3" />
                <span>{t('workspaceFilesRetry')}</span>
              </button>
            </div>
          ) : isWorkspaceEmpty ? (
            <div className="px-3 py-2 text-xs text-muted">{t('workspaceFilesEmpty')}</div>
          ) : (
            <div
              ref={treeContainerRef}
              role="tree"
              aria-label={pathHeader.currentName || t('artifactNewTabFiles')}
              className="mt-0.5 space-y-0.5"
            >
              {rows.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted">{t('artifactSearchEmpty')}</div>
              ) : (
                rows.map((row, rowIndex) => {
                  const indentPx = 8 + row.depth * 16;

                  if (row.kind === WorkspaceTreeRowKind.EmptyFolder) {
                    return (
                      <div
                        key={row.key}
                        style={{ paddingLeft: indentPx + 18 }}
                        className="py-1 pr-2 text-xs italic text-muted select-none"
                      >
                        {t('workspaceFilesEmptyFolder')}
                      </div>
                    );
                  }

                  if (row.kind === WorkspaceTreeRowKind.Error) {
                    return (
                      <div
                        key={row.key}
                        style={{ paddingLeft: indentPx + 18 }}
                        className="truncate py-1 pr-2 text-xs text-muted select-none"
                        title={row.message}
                      >
                        {t('workspaceFilesLoadFailed')}: {row.message}
                      </div>
                    );
                  }

                  if (row.kind === WorkspaceTreeRowKind.Truncated) {
                    return (
                      <div
                        key={row.key}
                        style={{ paddingLeft: indentPx + 18 }}
                        className="py-1 pr-2 text-[11px] text-muted select-none"
                      >
                        {t('workspaceFilesTruncated')
                          .replace('{shown}', String(row.shownCount))
                          .replace('{total}', String(row.totalCount))}
                      </div>
                    );
                  }

                  const isDirectory = row.entry.kind === WorkspaceDirectoryEntryKind.Directory;
                  const isSelectedFile = !isDirectory
                    && Boolean(activePathKey)
                    && normalizeFilePathForDedup(row.entry.path) === activePathKey;
                  const isOpening = !isDirectory && openingFilePath === row.entry.path;

                  return (
                    <button
                      key={row.key}
                      type="button"
                      role="treeitem"
                      aria-expanded={isDirectory ? row.isExpanded : undefined}
                      aria-selected={isSelectedFile || undefined}
                      data-workspace-tree-row="true"
                      data-workspace-entry-key={row.key}
                      onClick={() => handleEntryClick(row.entry)}
                      onContextMenu={event => handleEntryContextMenu(event, row.entry)}
                      onKeyDown={event => handleRowKeyDown(event, row, rowIndex)}
                      style={{ paddingLeft: indentPx }}
                      title={row.entry.path}
                      className={`flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-[13px] leading-4 transition-colors select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                        isSelectedFile
                          ? 'bg-surface-raised font-medium text-foreground'
                          : 'text-foreground/90 hover:bg-surface'
                      } ${isOpening ? 'opacity-70' : ''}`}
                    >
                      {isDirectory ? (
                        <>
                          {row.isExpanded ? (
                            <ChevronDownIcon className="h-3 w-3 shrink-0 text-muted" aria-hidden="true" />
                          ) : (
                            <ChevronRightIcon className="h-3 w-3 shrink-0 text-muted" aria-hidden="true" />
                          )}
                          {row.isExpanded ? (
                            <FolderOpenIcon className="h-4 w-4 shrink-0 text-secondary" aria-hidden="true" />
                          ) : (
                            <FolderIcon className="h-4 w-4 shrink-0 text-secondary" aria-hidden="true" />
                          )}
                        </>
                      ) : (
                        <>
                          <span className="h-3 w-3 shrink-0" aria-hidden="true" />
                          <FileTypeIcon fileName={row.entry.name} className="h-4 w-4 shrink-0" />
                        </>
                      )}
                      <span className="min-w-0 flex-1 truncate">{row.entry.name}</span>
                      {(row.isLoading || isOpening) && (
                        <ArrowPathIcon className="h-3 w-3 shrink-0 animate-spin text-muted" aria-hidden="true" />
                      )}
                    </button>
                  );
                })
              )}
            </div>
          )
        )}

        {contextMenu && (
          <LocalFileContextMenu
            filePath={contextMenu.filePath}
            isDirectory={contextMenu.isDirectory}
            position={contextMenu.position}
            onOpen={contextMenu.isDirectory ? undefined : () => void handleOpenFileEntry(contextMenu.filePath)}
            onClose={() => setContextMenu(null)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {/* Workspace Path Sub-header (aligned with ArtifactPanel's h-9 toolbar) */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <div
          className="flex min-w-0 flex-1 items-baseline overflow-hidden text-[12.5px] leading-5"
          title={normalizedRootKey}
        >
          {pathHeader.parentPath && (
            <span className="min-w-0 truncate text-muted">{pathHeader.parentPath}</span>
          )}
          <span className="shrink-0 font-medium text-foreground">{pathHeader.currentName}</span>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <ToolbarIconButton
            label={t('workspaceFilesToggleFilter')}
            active={showFilter || Boolean(filterQuery.trim())}
            onClick={() => {
              setShowFilter(prev => {
                if (prev) setFilterQuery('');
                return !prev;
              });
            }}
          >
            <MagnifyingGlassIcon className="h-3.5 w-3.5" />
          </ToolbarIconButton>

          <ToolbarIconButton
            label={includeHidden ? t('workspaceFilesHideHidden') : t('workspaceFilesShowHidden')}
            active={includeHidden}
            onClick={handleToggleIncludeHidden}
          >
            {includeHidden ? (
              <EyeIcon className="h-3.5 w-3.5" />
            ) : (
              <EyeSlashIcon className="h-3.5 w-3.5" />
            )}
          </ToolbarIconButton>

          <ToolbarIconButton
            label={t('artifactRefresh')}
            disabled={isRefreshing}
            onClick={() => void refreshLoadedTree({ resetExpanded: false })}
          >
            <ArrowPathIcon className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
          </ToolbarIconButton>

          <ToolbarIconButton
            label={t('artifactNewTabRevealWorkspace')}
            align={TooltipAlign.End}
            onClick={handleRevealWorkspace}
          >
            <FolderIcon className="h-3.5 w-3.5" />
          </ToolbarIconButton>
        </div>
      </div>

      {/* Collapsible Filter Input */}
      {showFilter && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border/70 px-3 py-1.5">
          <MagnifyingGlassIcon className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
          <input
            ref={filterInputRef}
            type="text"
            value={filterQuery}
            onChange={event => setFilterQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setFilterQuery('');
                setShowFilter(false);
              }
            }}
            placeholder={t('workspaceFilesFilterPlaceholder')}
            aria-label={t('workspaceFilesFilterPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted"
          />
          {filterQuery && (
            <button
              type="button"
              onClick={() => {
                setFilterQuery('');
                filterInputRef.current?.focus();
              }}
              aria-label={t('close')}
              className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-surface hover:text-foreground"
            >
              <XMarkIcon className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}

      {/* Workspace Tree Body */}
      {isInitialLoading ? (
        <div className="flex flex-1 items-center justify-center p-6 text-xs text-muted">
          <ArrowPathIcon className="mr-2 h-4 w-4 animate-spin" />
          <span>{t('loading')}</span>
        </div>
      ) : rootError ? (
        <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
          <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-surface-raised text-muted">
            <FolderIcon className="h-5 w-5" />
          </div>
          <p className="text-sm font-medium text-foreground">{t('workspaceFilesLoadFailed')}</p>
          <p className="mt-1 max-w-[280px] break-words text-xs leading-5 text-muted">{rootError}</p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => void refreshLoadedTree({ resetExpanded: false })}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface-raised px-3 text-xs font-medium text-foreground transition-colors hover:border-foreground/15"
            >
              <ArrowPathIcon className="h-3.5 w-3.5 text-secondary" />
              <span>{t('workspaceFilesRetry')}</span>
            </button>
            {onOpenLocalFile && (
              <button
                type="button"
                onClick={onOpenLocalFile}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised"
              >
                <FolderOpenIcon className="h-3.5 w-3.5 text-secondary" />
                <span>{t('artifactNewTabOpenLocalFile')}</span>
              </button>
            )}
          </div>
        </div>
      ) : isWorkspaceEmpty ? (
        <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
          <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-surface-raised text-muted">
            <FolderIcon className="h-5 w-5" />
          </div>
          <p className="text-sm font-medium text-foreground">{t('workspaceFilesEmpty')}</p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            {onCreateBlankDocument && (
              <button
                type="button"
                onClick={onCreateBlankDocument}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface-raised px-3 text-xs font-medium text-foreground transition-colors hover:border-foreground/15"
              >
                <DocumentPlusIcon className="h-3.5 w-3.5 text-secondary" />
                <span>{t('artifactNewTabNewDocument')}</span>
              </button>
            )}
            {onOpenLocalFile && (
              <button
                type="button"
                onClick={onOpenLocalFile}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised"
              >
                <FolderOpenIcon className="h-3.5 w-3.5 text-secondary" />
                <span>{t('artifactNewTabOpenLocalFile')}</span>
              </button>
            )}
          </div>
        </div>
      ) : (
        <div
          ref={treeContainerRef}
          role="tree"
          aria-label={t('artifactNewTabFiles')}
          className="flex-1 overflow-y-auto px-2 py-1.5"
        >
          {rows.length === 0 ? (
            <div className="flex items-center justify-center p-6 text-xs text-muted">
              {t('artifactSearchEmpty')}
            </div>
          ) : (
            rows.map((row, rowIndex) => {
              const indentPx = 10 + row.depth * 22;

              if (row.kind === WorkspaceTreeRowKind.EmptyFolder) {
                return (
                  <div
                    key={row.key}
                    style={{ paddingLeft: indentPx }}
                    className="py-1 pr-2.5 text-xs italic text-muted select-none"
                  >
                    {t('workspaceFilesEmptyFolder')}
                  </div>
                );
              }

              if (row.kind === WorkspaceTreeRowKind.Error) {
                return (
                  <div
                    key={row.key}
                    style={{ paddingLeft: indentPx }}
                    className="truncate py-1 pr-2.5 text-xs text-muted select-none"
                    title={row.message}
                  >
                    {t('workspaceFilesLoadFailed')}: {row.message}
                  </div>
                );
              }

              if (row.kind === WorkspaceTreeRowKind.Truncated) {
                return (
                  <div
                    key={row.key}
                    style={{ paddingLeft: indentPx }}
                    className="py-1.5 pr-2.5 text-[11.5px] text-muted select-none"
                  >
                    {t('workspaceFilesTruncated')
                      .replace('{shown}', String(row.shownCount))
                      .replace('{total}', String(row.totalCount))}
                  </div>
                );
              }

              const isDirectory = row.entry.kind === WorkspaceDirectoryEntryKind.Directory;
              const isSelectedFile = !isDirectory
                && Boolean(activePathKey)
                && normalizeFilePathForDedup(row.entry.path) === activePathKey;
              const isOpening = !isDirectory && openingFilePath === row.entry.path;

              return (
                <button
                  key={row.key}
                  type="button"
                  role="treeitem"
                  aria-expanded={isDirectory ? row.isExpanded : undefined}
                  aria-selected={isSelectedFile || undefined}
                  data-workspace-tree-row="true"
                  data-workspace-entry-key={row.key}
                  onClick={() => handleEntryClick(row.entry)}
                  onContextMenu={event => handleEntryContextMenu(event, row.entry)}
                  onKeyDown={event => handleRowKeyDown(event, row, rowIndex)}
                  style={{ paddingLeft: indentPx }}
                  title={row.entry.path}
                  className={`flex w-full items-center gap-2.5 rounded-lg py-1.5 pr-2.5 text-left text-[13.5px] leading-5 transition-colors select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                    isSelectedFile
                      ? 'bg-primary/10 text-primary'
                      : 'text-foreground hover:bg-surface-raised'
                  } ${isOpening ? 'opacity-70' : ''}`}
                >
                  {isDirectory ? (
                    row.isExpanded ? (
                      <FolderOpenIcon className="h-[18px] w-[18px] shrink-0 text-secondary" aria-hidden="true" />
                    ) : (
                      <FolderIcon className="h-[18px] w-[18px] shrink-0 text-secondary" aria-hidden="true" />
                    )
                  ) : (
                    <FileTypeIcon fileName={row.entry.name} className="h-[18px] w-[18px] shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{row.entry.name}</span>
                  {(row.isLoading || isOpening) && (
                    <ArrowPathIcon className="h-3.5 w-3.5 shrink-0 animate-spin text-muted" aria-hidden="true" />
                  )}
                </button>
              );
            })
          )}
        </div>
      )}

      {contextMenu && (
        <LocalFileContextMenu
          filePath={contextMenu.filePath}
          isDirectory={contextMenu.isDirectory}
          position={contextMenu.position}
          onOpen={contextMenu.isDirectory ? undefined : () => void handleOpenFileEntry(contextMenu.filePath)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
};

export default WorkspaceFileBrowser;
