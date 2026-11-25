import { DocumentPlusIcon, FolderIcon, FolderOpenIcon } from '@heroicons/react/24/outline';
import React, { useMemo, useState } from 'react';

import { dedupeArtifactsForDisplay } from '@/services/artifactParser';
import { i18nService } from '@/services/i18n';
import type { Artifact, ArtifactType } from '@/types/artifact';

import FileTypeIcon from '../icons/fileTypes/FileTypeIcon';
import { ArtifactPreviewGlobeIcon } from './ArtifactPreviewIdentity';
import {
  getPreviewCardDescriptor,
  PreviewCardIconKind,
} from './previewCardPolicy';

const t = (key: string) => i18nService.t(key);

const TYPE_ORDER: Record<ArtifactType, number> = {
  html: 0,
  svg: 1,
  image: 2,
  video: 3,
  mermaid: 4,
  document: 5,
  markdown: 6,
  text: 7,
  code: 8,
  'local-service': 9,
};

const TYPE_LABEL_KEYS: Record<ArtifactType, string> = {
  html: 'artifactTypeHtml',
  svg: 'artifactTypeSvg',
  image: 'artifactTypeImage',
  video: 'artifactTypeVideo',
  mermaid: 'artifactTypeMermaid',
  document: 'artifactTypeDocument',
  markdown: 'artifactTypeMarkdown',
  text: 'artifactTypeText',
  code: 'artifactCode',
  'local-service': 'artifactTypeLocalService',
};

function getShortPath(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts.length > 2
    ? `.../${parts.slice(-2).join('/')}`
    : parts.join('/');
}

interface FileDirectoryViewProps {
  artifacts: Artifact[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  compact?: boolean;
  onOpenLocalFile?: () => void;
  onCreateBlankDocument?: () => void;
  onRevealWorkspace?: () => void;
}

const FileDirectoryView: React.FC<FileDirectoryViewProps> = ({
  artifacts,
  selectedId,
  onSelect,
  compact,
  onOpenLocalFile,
  onCreateBlankDocument,
  onRevealWorkspace,
}) => {
  const [search, setSearch] = useState('');

  const sortedAndFiltered = useMemo(() => {
    let items = dedupeArtifactsForDisplay(artifacts);

    if (search.trim()) {
      const keyword = search.trim().toLowerCase();
      items = items.filter(a => {
        const name = (a.fileName || a.title || '').toLowerCase();
        return name.includes(keyword);
      });
    }

    return [...items].sort((a, b) => {
      const typeA = TYPE_ORDER[a.type] ?? 99;
      const typeB = TYPE_ORDER[b.type] ?? 99;
      if (typeA !== typeB) return typeA - typeB;
      const nameA = (a.fileName || a.title || '').toLowerCase();
      const nameB = (b.fileName || b.title || '').toLowerCase();
      return nameA.localeCompare(nameB);
    });
  }, [artifacts, search]);

  if (artifacts.length === 0) {
    const hasActions = !compact && Boolean(onOpenLocalFile || onCreateBlankDocument || onRevealWorkspace);
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
        <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-surface-raised text-muted">
          <FolderIcon className="h-5 w-5" />
        </div>
        <p className="text-sm font-medium text-foreground">{t('artifactEmptyFiles')}</p>
        {hasActions && (
          <>
            <p className="mt-1 max-w-[260px] text-xs leading-5 text-muted">
              {t('artifactEmptyFilesHint')}
            </p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              {onOpenLocalFile && (
                <button
                  type="button"
                  onClick={onOpenLocalFile}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface-raised px-3 text-xs font-medium text-foreground transition-colors hover:border-foreground/15"
                >
                  <FolderOpenIcon className="h-3.5 w-3.5 text-secondary" />
                  <span>{t('artifactNewTabOpenLocalFile')}</span>
                </button>
              )}
              {onCreateBlankDocument && (
                <button
                  type="button"
                  onClick={onCreateBlankDocument}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised"
                >
                  <DocumentPlusIcon className="h-3.5 w-3.5 text-secondary" />
                  <span>{t('artifactNewTabNewDocument')}</span>
                </button>
              )}
              {onRevealWorkspace && (
                <button
                  type="button"
                  onClick={onRevealWorkspace}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
                >
                  <span>{t('artifactNewTabRevealWorkspace')}</span>
                </button>
              )}
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-3 py-2 shrink-0 flex items-center gap-1.5">
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={t('artifactSearchPlaceholder')}
          className="min-w-0 flex-1 px-2.5 py-1.5 text-xs rounded-lg border border-border bg-surface-raised/60 text-foreground placeholder:text-muted outline-none focus:border-primary transition-colors"
        />
        {!compact && onOpenLocalFile && (
          <button
            type="button"
            onClick={onOpenLocalFile}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
            title={t('artifactNewTabOpenLocalFile')}
            aria-label={t('artifactNewTabOpenLocalFile')}
          >
            <FolderOpenIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto">
        {sortedAndFiltered.length === 0 ? (
          <div className="flex items-center justify-center text-muted text-xs p-4">
            {t('artifactSearchEmpty')}
          </div>
        ) : (
          sortedAndFiltered.map((artifact, idx) => {
            const showGroupHeader = !compact && (
              idx === 0 || artifact.type !== sortedAndFiltered[idx - 1].type
            );
            const fileName = artifact.fileName || artifact.title;
            const descriptor = getPreviewCardDescriptor(artifact);
            return (
              <React.Fragment key={artifact.id}>
                {showGroupHeader && (
                  <div className="px-3 pt-2 pb-1 text-[10px] font-medium text-muted uppercase tracking-wide">
                    {t(TYPE_LABEL_KEYS[artifact.type] || 'artifactCode')}
                  </div>
                )}
                <div
                  onClick={() => onSelect(artifact.id)}
                  className={`flex items-center gap-2 px-3 py-2 cursor-pointer text-sm transition-colors
                    ${artifact.id === selectedId ? 'bg-primary/10 text-primary' : 'hover:bg-surface text-foreground'}`}
                >
                  {descriptor.iconKind === PreviewCardIconKind.Globe ? (
                    <ArtifactPreviewGlobeIcon className="h-4 w-4 shrink-0 text-primary" />
                  ) : (
                    <FileTypeIcon fileName={descriptor.iconFileName} className="h-4 w-4 shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="truncate">
                      {fileName}
                    </div>
                    {!compact && artifact.filePath && (
                      <div className="text-[10px] text-muted truncate">
                        {getShortPath(artifact.filePath)}
                      </div>
                    )}
                  </div>
                  {!compact && (
                    <span className="shrink-0 text-xs text-muted uppercase">
                      {artifact.type}
                    </span>
                  )}
                </div>
              </React.Fragment>
            );
          })
        )}
      </div>
    </div>
  );
};

export default FileDirectoryView;
