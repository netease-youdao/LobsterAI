import React from 'react';

import { type Artifact } from '@/types/artifact';

import FileTypeIcon from '../icons/fileTypes/FileTypeIcon';
import {
  getPreviewCardDescriptor,
  type PreviewCardDescriptor,
  PreviewCardIconKind,
} from './previewCardPolicy';

export const ArtifactPreviewGlobeIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="10" />
    <ellipse cx="12" cy="12" rx="4.5" ry="10" />
    <path d="M2 12h20" />
  </svg>
);

export interface ArtifactPreviewIdentityProps {
  artifact: Artifact;
  descriptor?: PreviewCardDescriptor;
  subtitle?: React.ReactNode;
  subtitleTitle?: string;
  className?: string;
  iconContainerClassName?: string;
  iconClassName?: string;
  contentClassName?: string;
  titleClassName?: string;
  subtitleClassName?: string;
  unwrapped?: boolean;
  contentButtonProps?: React.ButtonHTMLAttributes<HTMLButtonElement>;
}

const ArtifactPreviewIdentity: React.FC<ArtifactPreviewIdentityProps> = ({
  artifact,
  descriptor: descriptorProp,
  subtitle,
  subtitleTitle,
  className,
  iconContainerClassName,
  iconClassName,
  contentClassName,
  titleClassName,
  subtitleClassName,
  unwrapped = false,
  contentButtonProps,
}) => {
  const descriptor = descriptorProp ?? getPreviewCardDescriptor(artifact);
  const usesGlobeIcon = descriptor.iconKind === PreviewCardIconKind.Globe;
  const resolvedIconContainerClassName =
    iconContainerClassName ??
    'flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl bg-surface dark:bg-white/[0.04]';
  const resolvedIconClassName = iconClassName ?? 'h-6 w-6';
  const resolvedContentClassName = contentClassName ?? 'min-w-0 flex-1';
  const resolvedTitleClassName = titleClassName ?? 'truncate text-sm font-medium text-foreground';
  const resolvedSubtitleClassName = subtitleClassName ?? 'mt-0.5 truncate text-xs text-secondary';

  const icon = (
    <div className={resolvedIconContainerClassName}>
      {usesGlobeIcon ? (
        <ArtifactPreviewGlobeIcon className={`${resolvedIconClassName} text-primary`} />
      ) : (
        <FileTypeIcon fileName={descriptor.iconFileName} className={resolvedIconClassName} />
      )}
    </div>
  );
  const content = (
    <>
      <div className={resolvedTitleClassName} title={descriptor.title}>
        {descriptor.title}
      </div>
      <div className={resolvedSubtitleClassName} title={subtitleTitle}>
        {subtitle ?? descriptor.subtitle}
      </div>
    </>
  );
  const contentElement = contentButtonProps ? (
    <button
      {...contentButtonProps}
      type={contentButtonProps.type ?? 'button'}
      className={contentButtonProps.className ?? resolvedContentClassName}
    >
      {content}
    </button>
  ) : (
    <div className={resolvedContentClassName}>{content}</div>
  );

  if (unwrapped) {
    return (
      <>
        {icon}
        {contentElement}
      </>
    );
  }

  return (
    <div className={className ?? 'flex min-w-0 items-center gap-3'}>
      {icon}
      {contentElement}
    </div>
  );
};

export default ArtifactPreviewIdentity;
