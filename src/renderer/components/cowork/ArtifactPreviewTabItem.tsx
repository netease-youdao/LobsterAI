import './artifactPreviewTabItem.css';

import React, { useCallback } from 'react';

interface ArtifactPreviewTabItemProps {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  closeLabel: string;
  onActivate: () => void;
  onClose: () => void;
  /** Optional status marker rendered after the label, e.g. an unread dot. */
  indicator?: React.ReactNode;
}

const MIDDLE_MOUSE_BUTTON = 1;

const ArtifactTabCloseIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" {...props}>
    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
  </svg>
);

/**
 * One tab in the artifact header strip. Tabs share the strip width equally (Chrome-style):
 * each one is `flex-1` capped at 190px with a 44px floor. The label gets the full tab width
 * at rest; on hover the close button overlays the tab's right end and the label fades out
 * underneath it (see `artifactPreviewTabItem.css`, which also owns the narrow, icon-only mode).
 */
const ArtifactPreviewTabItem: React.FC<ArtifactPreviewTabItemProps> = ({
  active,
  icon,
  label,
  closeLabel,
  onActivate,
  onClose,
  indicator,
}) => {
  const handleCloseClick = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onClose();
  }, [onClose]);

  // Middle click closes the tab, like browser tabs do. Preventing the default on mousedown
  // stops Windows/Linux from starting autoscroll on the horizontally scrollable strip.
  const handleMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button === MIDDLE_MOUSE_BUTTON) {
      event.preventDefault();
    }
  }, []);
  const handleAuxClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== MIDDLE_MOUSE_BUTTON) return;
    event.preventDefault();
    onClose();
  }, [onClose]);

  return (
    <div
      data-artifact-preview-active={active ? 'true' : undefined}
      onMouseDown={handleMouseDown}
      onAuxClick={handleAuxClick}
      className={`artifact-preview-tab non-draggable group relative flex h-7 min-w-[44px] max-w-[190px] flex-1 items-center rounded-lg text-xs transition-colors [container-type:inline-size] ${
        active
          ? 'bg-surface-raised text-foreground shadow-sm'
          : 'text-secondary hover:bg-surface hover:text-foreground'
      }`}
    >
      <button
        type="button"
        onClick={onActivate}
        className="artifact-preview-tab__activate flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 text-left"
        title={label}
      >
        <span className="artifact-preview-tab__icon flex shrink-0 items-center">{icon}</span>
        <span className="artifact-preview-tab__label truncate">{label}</span>
        {indicator}
      </button>
      <button
        type="button"
        onClick={handleCloseClick}
        className="artifact-preview-tab__close absolute right-1.5 top-1/2 flex h-3.5 w-3.5 -translate-y-1/2 items-center justify-center rounded-full text-transparent transition-colors group-hover:bg-muted group-hover:text-background focus-visible:bg-muted focus-visible:text-background hover:!bg-foreground hover:!text-background"
        title={closeLabel}
        aria-label={closeLabel}
      >
        <ArtifactTabCloseIcon className="h-2.5 w-2.5" />
      </button>
    </div>
  );
};

export default ArtifactPreviewTabItem;
