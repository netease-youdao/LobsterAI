import React from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { i18nService } from '@/services/i18n';
import { openArtifactPreviewTab, selectSelectedArtifact } from '@/store/slices/artifactSlice';
import type { Artifact, ArtifactType } from '@/types/artifact';

import { reportArtifactPreviewAction } from './artifactAnalytics';

const t = (key: string) => i18nService.t(key);

const TYPE_ICONS: Record<ArtifactType, string> = {
  html: '🌐',
  svg: '🎨',
  image: '🖼',
  video: '🎬',
  mermaid: '📊',
  code: '📄',
  markdown: '📝',
  text: '📄',
  document: '📑',
  'local-service': '🌐',
};

interface ArtifactBadgeProps {
  artifact: Artifact;
}

const ArtifactBadge: React.FC<ArtifactBadgeProps> = ({ artifact }) => {
  const dispatch = useDispatch();
  const selected = useSelector(selectSelectedArtifact);
  const isSelected = selected?.id === artifact.id;

  const handleClick = () => {
    reportArtifactPreviewAction({
      actionType: 'badge_open',
      source: 'conversation_artifact_card',
      artifact,
      params: {
        openTarget: 'preview_panel',
        wasSelected: isSelected,
      },
    });
    dispatch(openArtifactPreviewTab({ sessionId: artifact.sessionId, artifactId: artifact.id }));
  };

  return (
    <button
      onClick={handleClick}
      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm transition-colors cursor-pointer
        ${isSelected
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-border bg-surface hover:bg-surface-hover text-foreground'
        }`}
    >
      <span>{TYPE_ICONS[artifact.type] || '📄'}</span>
      <span className="truncate max-w-[200px]">{artifact.title}</span>
      <span className="text-xs text-muted">{t('artifactView')}</span>
    </button>
  );
};

export default ArtifactBadge;
