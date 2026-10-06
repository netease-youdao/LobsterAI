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
}

const FileDirectoryView: React.FC<FileDirectoryViewProps> = ({ artifacts, selectedId, onSelect, compact }) => {
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
    return (
      <div className="flex-1 flex items-center justify-center text-muted text-sm p-4">
        {t('artifactEmptyFiles')}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-3 py-2 shrink-0">
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={t('artifactSearchPlaceholder')}
          className="w-full px-2 py-1 text-xs rounded border border-border bg-surface text-foreground placeholder:text-muted outline-none focus:border-primary transition-colors"
        />
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
