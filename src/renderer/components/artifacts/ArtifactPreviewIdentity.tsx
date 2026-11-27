import React from 'react';

import { type Artifact } from '@/types/artifact';

import FileTypeIcon from '../icons/fileTypes/FileTypeIcon';
import {
  getPreviewCardDescriptor,
  type PreviewCardDescriptor,
  PreviewCardIconKind,
} from './previewCardPolicy';

export const WorkspaceFilesIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" {...props}>
    <path
      d="M1.75 4.25A1.75 1.75 0 0 1 3.5 2.5h2.72c.46 0 .9.19 1.22.52l.78.81c.19.2.45.31.73.31h3.55a1.75 1.75 0 0 1 1.75 1.75v6.36A1.75 1.75 0 0 1 12.5 14h-9a1.75 1.75 0 0 1-1.75-1.75V4.25Z"
      fill="#F59E0B"
    />
    <path
      d="M1.75 6.25h12.5v6a1.75 1.75 0 0 1-1.75 1.75h-9a1.75 1.75 0 0 1-1.75-1.75v-6Z"
      fill="#FBBF24"
    />
  </svg>
);

export const ArtifactBrowserIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.25"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...props}
  >
    <circle cx="8" cy="8" r="6" />
    <ellipse cx="8" cy="8" rx="2.5" ry="6" />
    <path d="M2 8h12" />
  </svg>
);

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
