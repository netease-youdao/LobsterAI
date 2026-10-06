import {
  ArrowTopRightOnSquareIcon,
  ChatBubbleLeftRightIcon,
  ChevronRightIcon,
  ClipboardDocumentIcon,
  EllipsisHorizontalIcon,
  FolderIcon,
  GlobeAltIcon,
  InformationCircleIcon,
  StarIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { StarIcon as StarSolidIcon } from '@heroicons/react/24/solid';
import React, { useEffect, useMemo, useState } from 'react';

import {
  LibraryAvailability,
  LibraryItemKind,
} from '../../../shared/library/constants';
import type {
  LibraryItem,
  LibraryLocalDetailData,
  LibrarySessionRef,
} from '../../../shared/library/types';
import { loadDetectedFileArtifact } from '../../services/artifactDetection';
import { i18nService } from '../../services/i18n';
import type { Artifact } from '../../types/artifact';
import {
  ArtifactPreviewActionSource,
  ArtifactPublishEntryPoint,
} from '../artifacts/artifactAnalytics';
import {
  ArtifactFileShareProvider,
  useOptionalArtifactFileShare,
} from '../artifacts/ArtifactFileShareController';
import { isArtifactFileShareable } from '../artifacts/artifactFileSharePolicy';
import ArtifactRenderer from '../artifacts/ArtifactRenderer';
import {
  CARD_OVERFLOW_MENU_ITEM_CLASSNAME,
  CARD_OVERFLOW_MENU_SUBITEM_CLASSNAME,
  CARD_OVERFLOW_MENU_SUBMENU_CLASSNAME,
  CARD_OVERFLOW_MENU_SUBMENU_MAX_HEIGHT_PX,
  CARD_OVERFLOW_MENU_SURFACE_CLASSNAME,
} from '../common/CardOverflowMenu';
import {
  MANAGEMENT_BODY_TEXT,
  MANAGEMENT_META_TEXT,
  MANAGEMENT_TITLE_TEXT,
} from '../common/managementTypography';
import Modal from '../common/Modal';
import FileTypeIcon from '../icons/fileTypes/FileTypeIcon';
import ShareUploadIcon from '../icons/ShareUploadIcon';
import Tooltip, { TooltipAlign, TooltipPosition } from '../ui/Tooltip';
import { LIBRARY_ACTION_MENU_WIDTH_PX } from './libraryActionMenuPresentation';
import { LibraryAnalyticsSurface } from './libraryAnalytics';
import { createLibraryArtifactCandidate } from './libraryArtifactCandidate';
import {
  getLibraryPreviewActionIds,
  LibraryItemAction,
  type LibraryItemAction as LibraryItemActionValue,
} from './libraryItemActionPolicy';
import {
  formatLibraryTime,
  getLibraryDisplayFileName,
  isLibraryWebsiteItem,
} from './libraryItemPresentation';

interface LibraryPreviewModalProps {
  item: LibraryItem;
  analyticsPageViewId: string;
  detail: LibraryLocalDetailData | null;
  detailLoading: boolean;
  onClose: () => void;
  onToggleFavorite: () => void;
  onOpenWithApp: () => void;
  onReveal: () => void;
  onOpenLink: () => void;
  onCopyLink: () => void;
  onOpenSession: (session: LibrarySessionRef) => void;
  onShowSites: () => void;
}

const HeaderIcon: React.FC<{ item: LibraryItem }> = ({ item }) => {
  const isWebsite = isLibraryWebsiteItem(item);
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center">
      {isWebsite ? (
        <GlobeAltIcon className="h-[18px] w-[18px] text-primary" aria-hidden="true" />
      ) : (
        <FileTypeIcon
          fileName={getLibraryDisplayFileName(item)}
          className="h-[18px] w-[18px]"
        />
      )}
    </div>
  );
};

const ActionIcon: React.FC<{
  action: LibraryItemActionValue;
  item: LibraryItem;
}> = ({ action, item }) => {
  if (action === LibraryItemAction.ToggleFavorite) {
    return item.isFavorite
      ? <StarSolidIcon className="h-4 w-4 text-amber-500" />
      : <StarIcon className="h-4 w-4" />;
  }
  if (action === LibraryItemAction.RevealLocal) return <FolderIcon className="h-4 w-4" />;
  if (action === LibraryItemAction.CopyLink) {
    return <ClipboardDocumentIcon className="h-4 w-4" />;
  }
  if (action === LibraryItemAction.ShareLocal) return <ShareUploadIcon className="h-4 w-4" />;
  if (action === LibraryItemAction.RelatedSessions) {
    return <ChatBubbleLeftRightIcon className="h-4 w-4" />;
  }
  if (action === LibraryItemAction.OpenWithApp || action === LibraryItemAction.OpenLink) {
    return <ArrowTopRightOnSquareIcon className="h-4 w-4" />;
  }
  if (action === LibraryItemAction.ManageSite) return <GlobeAltIcon className="h-4 w-4" />;
  return <InformationCircleIcon className="h-4 w-4" />;
};

const getActionLabel = (item: LibraryItem, action: LibraryItemActionValue): string => {
  if (action === LibraryItemAction.ToggleFavorite) {
    return item.isFavorite
      ? i18nService.t('libraryRemoveFavorite')
      : i18nService.t('libraryAddFavorite');
  }
  if (action === LibraryItemAction.RevealLocal) return i18nService.t('libraryRevealFile');
  if (action === LibraryItemAction.ManageSite) return i18nService.t('libraryManageSite');
  if (action === LibraryItemAction.CopyLink) return i18nService.t('libraryCopyLink');
  if (action === LibraryItemAction.OpenLink) return i18nService.t('libraryOpenLink');
  if (action === LibraryItemAction.ShareLocal) return i18nService.t('htmlShare');
  if (action === LibraryItemAction.RelatedSessions) {
    return i18nService.t('libraryRelatedSessions');
  }
  return i18nService.t('libraryOpenWithApp');
};

type HeaderPopover = 'actions';

interface PreviewHeaderActionProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  tooltipAlign?: TooltipAlign;
}

const PreviewHeaderAction: React.FC<PreviewHeaderActionProps> = ({
  label,
  tooltipAlign = TooltipAlign.Center,
  className = '',
  children,
  ...buttonProps
}) => (
  <Tooltip
    content={label}
    position={TooltipPosition.Bottom}
    align={tooltipAlign}
    delay={250}
  >
    <button
      {...buttonProps}
      type="button"
      aria-label={label}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-lg text-secondary hover:bg-surface-raised hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
    >
      {children}
    </button>
  </Tooltip>
);

const LibraryPreviewModalContent: React.FC<LibraryPreviewModalProps> = ({
  item,
  analyticsPageViewId,
  detail,
  detailLoading,
  onClose,
  onToggleFavorite,
  onOpenWithApp,
  onReveal,
  onOpenLink,
  onCopyLink,
  onOpenSession,
  onShowSites,
}) => {
  const artifactFileShare = useOptionalArtifactFileShare();
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [loading, setLoading] = useState(false);
  const [activePopover, setActivePopover] = useState<HeaderPopover>();
  const [isSessionsExpanded, setIsSessionsExpanded] = useState(false);
  const localItem = item.itemKind === LibraryItemKind.LocalArtifact ? item : undefined;

  const candidate = useMemo<Artifact | null>(() => (
    localItem ? createLibraryArtifactCandidate(localItem) : null
  ), [localItem]);

  useEffect(() => {
    let active = true;
    setArtifact(null);
    if (!candidate || localItem?.availability !== LibraryAvailability.Available) {
      setLoading(false);
      return () => { active = false; };
    }
    setLoading(true);
    void loadDetectedFileArtifact(candidate).then(loaded => {
      if (!active) return;
      setArtifact(loaded);
      setLoading(false);
    });
    return () => { active = false; };
  }, [candidate, localItem?.availability]);

  useEffect(() => {
    if (!activePopover) return undefined;
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-library-preview-popover]')) return;
      setActivePopover(undefined);
      setIsSessionsExpanded(false);
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [activePopover]);

  const sessions = detail?.sessions.length
    ? detail.sessions
    : item.latestSession
      ? [item.latestSession]
      : [];
  const previewActions = getLibraryPreviewActionIds(item);
  const regularPreviewActions = previewActions.filter(
    action => action !== LibraryItemAction.RelatedSessions,
  );
  const hasRelatedSessionsAction = previewActions.includes(LibraryItemAction.RelatedSessions);
  const relatedSessionCount = localItem
    ? Math.max(localItem.relatedSessionCount, sessions.length)
    : sessions.length;
  const hasPreviewMenuItems = previewActions.length > 0;
  const canShare = Boolean(
    localItem
    && artifact
    && artifactFileShare
    && isArtifactFileShareable(artifact),
  );

  const handleShare = (): void => {
    if (!artifact || !artifactFileShare || !canShare) return;
    void artifactFileShare.openShare(artifact, {
      source: ArtifactPreviewActionSource.LibraryPreview,
      entryPoint: ArtifactPublishEntryPoint.LibraryToolbar,
      surface: LibraryAnalyticsSurface.MyFiles,
      pageViewId: analyticsPageViewId,
    });
  };

  const runAction = (action: LibraryItemActionValue): void => {
    setActivePopover(undefined);
    setIsSessionsExpanded(false);
    if (action === LibraryItemAction.ToggleFavorite) onToggleFavorite();
    else if (action === LibraryItemAction.OpenWithApp) onOpenWithApp();
    else if (action === LibraryItemAction.RevealLocal) onReveal();
    else if (action === LibraryItemAction.OpenLink) onOpenLink();
    else if (action === LibraryItemAction.CopyLink) onCopyLink();
    else if (action === LibraryItemAction.ManageSite) onShowSites();
  };

  const togglePopover = (): void => {
    setActivePopover(current => current === 'actions' ? undefined : 'actions');
    setIsSessionsExpanded(false);
  };
  const handleEscape = artifactFileShare?.isOverlayOpen
    ? undefined
    : isSessionsExpanded
      ? () => setIsSessionsExpanded(false)
      : activePopover
        ? () => setActivePopover(undefined)
        : onClose;

  return (
    <Modal
      onClose={onClose}
      onEscape={handleEscape}
      overlayClassName="fixed inset-0 z-40 flex h-[100dvh] items-center justify-center bg-black/45 px-4 py-12 backdrop-blur-[2px] lg:px-8"
      className="non-draggable flex h-full max-h-[820px] min-h-0 w-full max-w-[1320px] min-w-0 overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="library-preview-title"
        className="flex min-h-0 min-w-0 w-full flex-1 flex-col"
      >
        <header className="relative z-20 flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
          <HeaderIcon item={item} />
          <div className="min-w-0 flex-1">
            <h2
              id="library-preview-title"
              className={`truncate ${MANAGEMENT_TITLE_TEXT} font-semibold leading-5 text-foreground`}
            >
              {item.title}
            </h2>
            <p className={`truncate ${MANAGEMENT_META_TEXT} leading-[var(--lobster-leading-xs)] text-secondary`}>
              {i18nService.t('libraryLastModifiedAt')}: {formatLibraryTime(item.sortTime)}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-1" data-library-preview-popover>
            {localItem && (
              <PreviewHeaderAction
                label={i18nService.t('htmlShare')}
                onClick={handleShare}
                disabled={!canShare}
              >
                <ShareUploadIcon className="h-4 w-4" />
              </PreviewHeaderAction>
            )}
            <PreviewHeaderAction
              label={item.isFavorite
                ? i18nService.t('libraryRemoveFavorite')
                : i18nService.t('libraryAddFavorite')}
              onClick={onToggleFavorite}
              aria-pressed={item.isFavorite}
              className={item.isFavorite
                ? 'bg-amber-500/10 !text-amber-500 hover:bg-amber-500/15 hover:!text-amber-500'
                : ''}
            >
              {item.isFavorite
                ? <StarSolidIcon className="h-4 w-4" />
                : <StarIcon className="h-4 w-4" />}
            </PreviewHeaderAction>
            {hasPreviewMenuItems && (
              <PreviewHeaderAction
                label={i18nService.t('moreActions')}
                onClick={togglePopover}
                aria-haspopup="menu"
                aria-expanded={activePopover === 'actions'}
              >
                <EllipsisHorizontalIcon className="h-[18px] w-[18px]" />
              </PreviewHeaderAction>
            )}
            <div className="mx-0.5 h-5 w-px bg-border" />
            <PreviewHeaderAction
              label={i18nService.t('close')}
              tooltipAlign={TooltipAlign.End}
              onClick={onClose}
            >
              <XMarkIcon className="h-[18px] w-[18px]" />
            </PreviewHeaderAction>
          </div>

          {activePopover && (
            <div
              data-library-preview-popover
              style={{ width: LIBRARY_ACTION_MENU_WIDTH_PX }}
              className={`absolute right-3 top-full z-30 mt-1 max-w-[calc(100%-24px)] ${CARD_OVERFLOW_MENU_SURFACE_CLASSNAME}`}
            >
              {activePopover === 'actions' && (
                <div role="menu" aria-label={i18nService.t('moreActions')}>
                  {regularPreviewActions.map(action => {
                    const disabled = action === LibraryItemAction.OpenWithApp
                      && localItem?.availability !== LibraryAvailability.Available;
                    return (
                      <button
                        key={action}
                        type="button"
                        role="menuitem"
                        disabled={disabled}
                        onClick={() => runAction(action)}
                        className={`${CARD_OVERFLOW_MENU_ITEM_CLASSNAME} text-foreground`}
                      >
                        <ActionIcon action={action} item={item} />
                        {getActionLabel(item, action)}
                      </button>
                    );
                  })}
                  {hasRelatedSessionsAction && (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        aria-haspopup="menu"
                        aria-expanded={isSessionsExpanded}
                        onKeyDown={(event) => {
                          if (event.key === 'ArrowRight') {
                            event.preventDefault();
                            setIsSessionsExpanded(true);
                          } else if (event.key === 'ArrowLeft') {
                            event.preventDefault();
                            setIsSessionsExpanded(false);
                          }
                        }}
                        onClick={() => setIsSessionsExpanded(value => !value)}
                        className={`${CARD_OVERFLOW_MENU_ITEM_CLASSNAME} text-foreground`}
                      >
                        <ActionIcon action={LibraryItemAction.RelatedSessions} item={item} />
                        <span className="min-w-0 flex-1 truncate">
                          {i18nService.t('libraryRelatedSessions')}
                        </span>
                        <span className="text-tertiary">{relatedSessionCount}</span>
                        <ChevronRightIcon
                          className={`h-3.5 w-3.5 shrink-0 text-tertiary transition-transform ${
                            isSessionsExpanded ? 'rotate-90' : ''
                          }`}
                        />
                      </button>
                      {isSessionsExpanded && (
                        <div
                          role="group"
                          aria-label={i18nService.t('libraryRelatedSessions')}
                          style={{ maxHeight: CARD_OVERFLOW_MENU_SUBMENU_MAX_HEIGHT_PX }}
                          className={CARD_OVERFLOW_MENU_SUBMENU_CLASSNAME}
                        >
                          {detailLoading ? (
                            <div className="px-2 py-3 text-xs text-secondary">
                              {i18nService.t('loading')}
                            </div>
                          ) : sessions.length > 0 ? (
                            sessions.map(session => (
                              <button
                                key={session.sessionId}
                                type="button"
                                role="menuitem"
                                onClick={() => onOpenSession(session)}
                                className={`${CARD_OVERFLOW_MENU_SUBITEM_CLASSNAME} text-foreground`}
                              >
                                <span className="min-w-0 flex-1 truncate">{session.title}</span>
                              </button>
                            ))
                          ) : (
                            <div className="px-2 py-3 text-xs text-secondary">
                              {i18nService.t('libraryUnlinkedSession')}
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </header>

        <div
          className="min-h-0 min-w-0 flex-1 overflow-hidden bg-surface"
          onMouseDown={() => {
            setActivePopover(undefined);
            setIsSessionsExpanded(false);
          }}
        >
          {localItem ? (
            loading ? (
              <div className={`flex h-full items-center justify-center ${MANAGEMENT_BODY_TEXT} text-secondary`}>
                {i18nService.t('loading')}
              </div>
            ) : artifact ? (
              <ArtifactRenderer artifact={artifact} />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <InformationCircleIcon className="h-9 w-9 text-tertiary" />
                <p className={`max-w-md ${MANAGEMENT_BODY_TEXT} leading-[var(--lobster-leading-sm)] text-secondary`}>
                  {i18nService.t('libraryPreviewUnavailable')}
                </p>
                <button
                  type="button"
                  onClick={onOpenWithApp}
                  disabled={localItem.availability !== LibraryAvailability.Available}
                  className="h-9 rounded-lg border border-border px-3 text-xs text-foreground hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {i18nService.t('libraryOpenWithApp')}
                </button>
              </div>
            )
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-surface-raised">
                <GlobeAltIcon className="h-8 w-8 text-primary" />
              </div>
              <div>
                <h3 className={`${MANAGEMENT_TITLE_TEXT} font-semibold text-foreground`}>
                  {item.title}
                </h3>
                <p className={`${MANAGEMENT_BODY_TEXT} mt-1 max-w-md leading-[var(--lobster-leading-sm)] text-secondary`}>
                  {i18nService.t('libraryCloudPreviewDescription')}
                </p>
              </div>
              <button
                type="button"
                onClick={onOpenLink}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-xs font-medium text-white hover:opacity-90"
              >
                <ArrowTopRightOnSquareIcon className="h-4 w-4" />
                {i18nService.t('libraryOpenLink')}
              </button>
            </div>
          )}
        </div>
      </section>
    </Modal>
  );
};

const LibraryPreviewModal: React.FC<LibraryPreviewModalProps> = props => {
  if (props.item.itemKind !== LibraryItemKind.LocalArtifact) {
    return <LibraryPreviewModalContent {...props} />;
  }
  return (
    <ArtifactFileShareProvider sessionId={props.item.latestSession.sessionId}>
      <LibraryPreviewModalContent {...props} />
    </ArtifactFileShareProvider>
  );
};

export default LibraryPreviewModal;
