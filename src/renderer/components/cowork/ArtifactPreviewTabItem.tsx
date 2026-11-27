import './artifactPreviewTabItem.css';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { splitArtifactFileNameExtension } from '@/components/artifacts/artifactHeaderPath';
import { i18nService } from '@/services/i18n';

import ArtifactPreviewTabMenu, { type ArtifactPreviewTabMenuAction } from './ArtifactPreviewTabMenu';

interface ArtifactPreviewTabItemProps {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  closeLabel: string;
  onActivate: () => void;
  onClose: () => void;
  onCloseOthers?: () => void;
  onCloseToRight?: () => void;
  canRename?: boolean;
  preserveExtensionOnRename?: boolean;
  renameLabel?: string;
  extraMenuActions?: ArtifactPreviewTabMenuAction[];
  isRenaming?: boolean;
  onStartRename?: () => void;
  onCancelRename?: () => void;
  onCommitRename?: (nextStem: string) => Promise<boolean> | boolean;
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
  onCloseOthers,
  onCloseToRight,
  canRename = false,
  preserveExtensionOnRename = true,
  renameLabel,
  extraMenuActions,
  isRenaming = false,
  onStartRename,
  onCancelRename,
  onCommitRename,
  indicator,
}) => {
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number }>();
  const { stem, extension } = useMemo(
    () => (preserveExtensionOnRename ? splitArtifactFileNameExtension(label) : { stem: label, extension: '' }),
    [label, preserveExtensionOnRename],
  );
  const [draftStem, setDraftStem] = useState(stem);
  const [isSubmittingRename, setIsSubmittingRename] = useState(false);
  const tabRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const renameSettledRef = useRef(false);

  const dismissMenu = useCallback(() => setMenuPosition(undefined), []);
  const handleCloseClick = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!isRenaming) {
      setDraftStem(stem);
      setIsSubmittingRename(false);
      renameSettledRef.current = false;
      return undefined;
    }

    setDraftStem(stem);
    renameSettledRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      tabRef.current?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isRenaming, stem]);

  const cancelRename = useCallback(() => {
    if (renameSettledRef.current || isSubmittingRename) return;
    renameSettledRef.current = true;
    setDraftStem(stem);
    onCancelRename?.();
  }, [isSubmittingRename, onCancelRename, stem]);

  const commitRename = useCallback(async () => {
    if (renameSettledRef.current || isSubmittingRename) return;
    renameSettledRef.current = true;
    const trimmed = draftStem.trim();
    if (!trimmed || trimmed === stem || !onCommitRename) {
      setDraftStem(stem);
      onCancelRename?.();
      return;
    }

    setIsSubmittingRename(true);
    try {
      await onCommitRename(trimmed);
    } finally {
      setIsSubmittingRename(false);
      onCancelRename?.();
    }
  }, [draftStem, isSubmittingRename, onCancelRename, onCommitRename, stem]);

  // Middle click closes the tab, like browser tabs do. Preventing the default on mousedown
  // stops Windows/Linux from starting autoscroll on the horizontally scrollable strip.
  const handleMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button === MIDDLE_MOUSE_BUTTON) {
      event.preventDefault();
    }
  }, []);
  const handleAuxClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== MIDDLE_MOUSE_BUTTON || isRenaming) return;
    event.preventDefault();
    onClose();
  }, [isRenaming, onClose]);

  return (
    <div
      ref={tabRef}
      data-artifact-preview-active={active ? 'true' : undefined}
      data-artifact-preview-renaming={isRenaming ? 'true' : undefined}
      onMouseDown={handleMouseDown}
      onAuxClick={handleAuxClick}
      onContextMenu={event => {
        if (isRenaming) return;
        event.preventDefault(); event.stopPropagation();
        setMenuPosition({ x: event.clientX, y: event.clientY });
      }}
      onKeyDown={event => {
        if (isRenaming) return;
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        setMenuPosition({ x: rect.left, y: rect.bottom });
      }}
      className={`artifact-preview-tab non-draggable group relative flex h-7 items-center rounded-lg text-xs transition-colors [container-type:inline-size] ${
        isRenaming
          ? 'min-w-[160px] max-w-[260px] shrink-0 border border-primary/60 bg-background text-foreground ring-2 ring-primary/15'
          : active
            ? 'min-w-[44px] max-w-[190px] flex-1 bg-surface-raised text-foreground shadow-sm'
            : 'min-w-[44px] max-w-[190px] flex-1 text-secondary hover:bg-surface hover:text-foreground'
      }`}
    >
      {isRenaming ? (
        <div className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2">
          <span className="artifact-preview-tab__icon flex shrink-0 items-center">{icon}</span>
          <input
            ref={inputRef}
            type="text"
            value={draftStem}
            disabled={isSubmittingRename}
            onChange={event => setDraftStem(event.target.value)}
            onBlur={() => { void commitRename(); }}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                void commitRename();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                cancelRename();
              }
            }}
            aria-label={renameLabel || i18nService.t('artifactRenameFile')}
            className="min-w-[72px] flex-1 bg-transparent text-xs font-medium text-foreground outline-none"
          />
          {extension && (
            <span className="shrink-0 select-none text-[11px] text-muted">{extension}</span>
          )}
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={onActivate}
            onDoubleClick={event => {
              if (!active || !canRename || !onStartRename) return;
              event.preventDefault();
              event.stopPropagation();
              onStartRename();
            }}
            className="artifact-preview-tab__activate flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 text-left"
            title={label}
            aria-haspopup="menu"
            aria-expanded={Boolean(menuPosition)}
          >
            <span className="artifact-preview-tab__icon flex shrink-0 items-center">{icon}</span>
            <span className="artifact-preview-tab__label truncate">{label}</span>
            {indicator}
          </button>
          {menuPosition && (
            <ArtifactPreviewTabMenu
              position={menuPosition}
              onDismiss={dismissMenu}
              onRenameTab={canRename && onStartRename ? onStartRename : undefined}
              renameLabel={renameLabel}
              extraActions={extraMenuActions}
              onCloseTab={onClose}
              onCloseOthers={onCloseOthers}
              onCloseToRight={onCloseToRight}
            />
          )}
          <button
            type="button"
            onClick={handleCloseClick}
            className="artifact-preview-tab__close absolute right-1.5 top-1/2 flex h-3.5 w-3.5 -translate-y-1/2 items-center justify-center rounded-full text-transparent transition-colors group-hover:bg-muted group-hover:text-background focus-visible:bg-muted focus-visible:text-background hover:!bg-foreground hover:!text-background"
            title={closeLabel}
            aria-label={closeLabel}
          >
            <ArtifactTabCloseIcon className="h-2.5 w-2.5" />
          </button>
        </>
      )}
    </div>
  );
};

export default ArtifactPreviewTabItem;
