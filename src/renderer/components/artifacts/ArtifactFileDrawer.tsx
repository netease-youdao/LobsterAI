import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  MagnifyingGlassIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import React, { useMemo, useRef, useState } from 'react';

import {
  dedupeArtifactsForDisplay,
  normalizeFilePathForDedup,
} from '@/services/artifactParser';
import { i18nService } from '@/services/i18n';
import type { Artifact } from '@/types/artifact';

import FileTypeIcon from '../icons/fileTypes/FileTypeIcon';
import { ArtifactPreviewGlobeIcon } from './ArtifactPreviewIdentity';
import {
  getPreviewCardDescriptor,
  PreviewCardIconKind,
} from './previewCardPolicy';
import WorkspaceFileBrowser, { WorkspaceFileBrowserVariant } from './WorkspaceFileBrowser';

const t = (key: string) => i18nService.t(key);

export interface ArtifactFileDrawerProps {
  sessionId: string;
  workingDirectory?: string;
  artifacts: Artifact[];
  selectedArtifactId: string | null;
  activeFilePath?: string | null;
  isOpen: boolean;
  refreshTrigger?: string;
  onSelectArtifact: (id: string) => void;
  onOpenWorkspaceFile?: (filePath: string) => Promise<void> | void;
  onRevealWorkspace?: () => void;
  onClose: () => void;
}

const ArtifactFileDrawer: React.FC<ArtifactFileDrawerProps> = ({
  sessionId,
  workingDirectory,
  artifacts,
  selectedArtifactId,
  activeFilePath,
  isOpen,
  refreshTrigger,
  onSelectArtifact,
  onOpenWorkspaceFile,
  onRevealWorkspace,
  onClose,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [isTaskSectionExpanded, setIsTaskSectionExpanded] = useState(true);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const dedupedArtifacts = useMemo(
    () => dedupeArtifactsForDisplay(artifacts),
    [artifacts],
  );

  const filteredTaskArtifacts = useMemo(() => {
    const keyword = searchQuery.trim().toLowerCase();
    if (!keyword) return dedupedArtifacts;
    return dedupedArtifacts.filter(artifact => {
      const name = (artifact.fileName || artifact.title || '').toLowerCase();
      return name.includes(keyword);
    });
  }, [dedupedArtifacts, searchQuery]);

  const activePathKey = useMemo(
    () => (activeFilePath ? normalizeFilePathForDedup(activeFilePath) : ''),
    [activeFilePath],
  );

  const hasWorkspaceTree = Boolean(workingDirectory?.trim() && onOpenWorkspaceFile);
  const showTaskSection = dedupedArtifacts.length > 0 || !hasWorkspaceTree;
  const effectiveTaskExpanded = isTaskSectionExpanded || Boolean(searchQuery.trim());

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Search & close header */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/70 px-2.5 py-2">
        <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-border bg-surface/70 px-2 transition-colors focus-within:border-primary/50 focus-within:bg-background">
          <MagnifyingGlassIcon className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={event => setSearchQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                if (searchQuery) {
                  setSearchQuery('');
                } else {
                  onClose();
                }
              }
            }}
            placeholder={t('artifactDrawerSearchPlaceholder')}
            aria-label={t('artifactDrawerSearchPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => {
                setSearchQuery('');
                searchInputRef.current?.focus();
              }}
              aria-label={t('close')}
              className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted transition-colors hover:text-foreground"
            >
              <XMarkIcon className="h-3 w-3" />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          title={t('artifactCloseFileList')}
          aria-label={t('artifactCloseFileList')}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-secondary transition-colors hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
        >
          <XMarkIcon className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      {/* Unified scrollable list: Task files + Workspace directory tree */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 space-y-2.5">
        {showTaskSection && (
          <div>
            <button
              type="button"
              onClick={() => setIsTaskSectionExpanded(prev => !prev)}
              aria-expanded={effectiveTaskExpanded}
              className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-xs font-medium text-foreground transition-colors hover:bg-surface/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              {effectiveTaskExpanded ? (
                <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
              ) : (
                <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
              )}
              <span className="min-w-0 flex-1 truncate">{t('artifactDrawerTaskFiles')}</span>
              <span className="shrink-0 pr-1 text-[11px] font-normal tabular-nums text-muted">
                {dedupedArtifacts.length}
              </span>
            </button>

            {effectiveTaskExpanded && (
              dedupedArtifacts.length === 0 ? (
                <div className="flex flex-col items-center justify-center px-3 py-6 text-center">
                  <FolderIcon className="mb-1.5 h-5 w-5 text-muted" aria-hidden="true" />
                  <span className="text-xs text-muted">{t('artifactEmptyFiles')}</span>
                </div>
              ) : filteredTaskArtifacts.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted">
                  {t('artifactSearchEmpty')}
                </div>
              ) : (
                <div className="mt-0.5 space-y-0.5" role="list" aria-label={t('artifactDrawerTaskFiles')}>
                  {filteredTaskArtifacts.map(artifact => {
                    const fileName = artifact.fileName || artifact.title;
                    const descriptor = getPreviewCardDescriptor(artifact);
                    const isSelected = artifact.id === selectedArtifactId
                      || Boolean(
                        activePathKey
                        && artifact.filePath
                        && normalizeFilePathForDedup(artifact.filePath) === activePathKey,
                      );
                    return (
                      <button
                        key={artifact.id}
                        type="button"
                        role="listitem"
                        onClick={() => onSelectArtifact(artifact.id)}
                        title={artifact.filePath || fileName}
                        className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] leading-4 transition-colors select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                          isSelected
                            ? 'bg-surface-raised font-medium text-foreground'
                            : 'text-foreground/90 hover:bg-surface'
                        }`}
                      >
                        {descriptor.iconKind === PreviewCardIconKind.Globe ? (
                          <ArtifactPreviewGlobeIcon className="h-4 w-4 shrink-0 text-primary" />
                        ) : (
                          <FileTypeIcon fileName={descriptor.iconFileName} className="h-4 w-4 shrink-0" />
                        )}
                        <span className="min-w-0 flex-1 truncate">{fileName}</span>
                      </button>
                    );
                  })}
                </div>
              )
            )}
          </div>
        )}

        {hasWorkspaceTree && workingDirectory && onOpenWorkspaceFile && (
          <div className={showTaskSection ? 'border-t border-border/60 pt-2' : undefined}>
            <WorkspaceFileBrowser
              sessionId={sessionId}
              workingDirectory={workingDirectory}
              activeFilePath={activeFilePath}
              isActive={isOpen}
              refreshTrigger={refreshTrigger}
              variant={WorkspaceFileBrowserVariant.Drawer}
              externalFilterQuery={searchQuery}
              onOpenFile={onOpenWorkspaceFile}
              onRevealWorkspace={onRevealWorkspace}
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default ArtifactFileDrawer;
