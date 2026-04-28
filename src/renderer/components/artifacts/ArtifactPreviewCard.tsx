import { ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline';
import React from 'react';
import { useDispatch } from 'react-redux';

import { i18nService } from '@/services/i18n';
import { selectArtifact } from '@/store/slices/artifactSlice';
import type { Artifact, ArtifactType } from '@/types/artifact';

const t = (key: string) => i18nService.t(key);

const GlobeIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <ellipse cx="12" cy="12" rx="4.5" ry="10" />
    <path d="M2 12h20" />
  </svg>
);

const SvgIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <path d="m21 15-5-5L5 21" />
  </svg>
);

const ImageIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <path d="m21 15-5-5L5 21" />
  </svg>
);

const MermaidIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="8.5" y="14" width="7" height="7" rx="1" />
    <path d="M6.5 10v1.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V10" />
    <path d="M12 12.5V14" />
  </svg>
);

const ReactIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <ellipse cx="12" cy="12" rx="10" ry="4" />
    <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)" />
    <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)" />
    <circle cx="12" cy="12" r="1.5" fill="currentColor" />
  </svg>
);

const TYPE_ICON_MAP: Record<ArtifactType, React.FC<{ className?: string }>> = {
  html: GlobeIcon,
  svg: SvgIcon,
  image: ImageIcon,
  mermaid: MermaidIcon,
  react: ReactIcon,
  code: GlobeIcon,
};

const TYPE_LABEL_KEY: Record<ArtifactType, string> = {
  html: 'artifactTypeHtml',
  svg: 'artifactTypeSvg',
  image: 'artifactTypeImage',
  mermaid: 'artifactTypeMermaid',
  react: 'artifactTypeReact',
  code: 'artifactTypeHtml',
};

interface ArtifactPreviewCardProps {
  artifact: Artifact;
}

const ArtifactPreviewCard: React.FC<ArtifactPreviewCardProps> = ({ artifact }) => {
  const dispatch = useDispatch();

  const handleClick = () => {
    dispatch(selectArtifact(artifact.id));
  };

  const IconComponent = TYPE_ICON_MAP[artifact.type];
  const title = artifact.fileName || artifact.title;
  const subtitle = t(TYPE_LABEL_KEY[artifact.type]);

  return (
    <button
      type="button"
      onClick={handleClick}
      className="flex items-center gap-3 px-4 py-3 rounded-xl border border-border bg-surface-raised hover:bg-surface-hover transition-colors cursor-pointer max-w-sm w-full text-left"
    >
      <div className="flex-shrink-0 w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
        <IconComponent className="w-5 h-5 text-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-foreground truncate">{title}</div>
        <div className="text-xs text-secondary">{subtitle}</div>
      </div>
      <div className="flex-shrink-0 flex items-center gap-1 text-primary text-sm font-medium">
        <ArrowTopRightOnSquareIcon className="w-4 h-4" />
        <span>{t('artifactOpen')}</span>
      </div>
    </button>
  );
};

export default ArtifactPreviewCard;
