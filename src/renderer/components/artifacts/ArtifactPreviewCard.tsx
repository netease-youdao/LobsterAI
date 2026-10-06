import { ArrowTopRightOnSquareIcon } from '@heroicons/react/20/solid';
import { ArrowUpTrayIcon, ChevronDownIcon, FolderIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDispatch } from 'react-redux';

import { i18nService } from '@/services/i18n';
import {
  getCachedAppsForFile,
  getCachedBrowserApps,
  normalizeShellFilePath,
  prefetchAppsForFile,
  prefetchBrowserApps,
  type ShellAppInfo,
} from '@/services/shellAppsCache';
import { openArtifactPreviewTab } from '@/store/slices/artifactSlice';
import { type Artifact, ArtifactTypeValue } from '@/types/artifact';
import { revealLocalPathWithToast, showShellFailureToast } from '@/utils/localFileActions';

import ServiceDeploymentIcon from '../icons/ServiceDeploymentIcon';
import {
  ArtifactPreviewActionSource,
  ArtifactPublishEntryPoint,
  reportArtifactPreviewAction,
} from './artifactAnalytics';
import { useOptionalArtifactFileShare } from './ArtifactFileShareController';
import { isArtifactFileShareable } from './artifactFileSharePolicy';
import ArtifactPreviewIdentity from './ArtifactPreviewIdentity';
import { getPreviewCardDescriptor } from './previewCardPolicy';

const t = (key: string) => i18nService.t(key);

const AppIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="4" />
    <path d="M8 12h8" />
    <path d="M12 8v8" />
  </svg>
);

// ── Dropdown Menu for Document Artifacts ──────────────────────────

interface OpenDropdownProps {
  anchorRef: React.RefObject<HTMLElement>;
  artifact: Artifact;
  filePath?: string;
  browserUrl?: string;
  browserProjectDirectory?: string;
  revealFolderPath?: string;
  browserOpenAction?: {
    label: string;
    onOpen: () => void;
  };
  onClose: () => void;
}

const OpenDropdown: React.FC<OpenDropdownProps> = ({
  anchorRef,
  artifact,
  filePath,
  browserUrl,
  browserProjectDirectory,
  revealFolderPath,
  browserOpenAction,
  onClose,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const cachedApps = filePath
    ? getCachedAppsForFile(filePath)
    : browserUrl
      ? getCachedBrowserApps(browserProjectDirectory)
      : null;
  const [apps, setApps] = useState<ShellAppInfo[]>(cachedApps ?? []);
  const [loading, setLoading] = useState(!cachedApps && Boolean(filePath || browserUrl));

  useEffect(() => {
    if (!filePath && !browserUrl) {
      setApps([]);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    // Cache hits (normally prefetched on card mount) resolve synchronously,
    // so the menu renders in its final state on the very first frame.
    const appsPromise = filePath
      ? prefetchAppsForFile(filePath)
      : prefetchBrowserApps(browserProjectDirectory);
    appsPromise.then(result => {
      if (cancelled) return;
      if (result) setApps(result);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [browserProjectDirectory, browserUrl, filePath]);

  useEffect(() => {
    if (!anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const MAX_MENU_HEIGHT = 356;
    const MENU_ROW_HEIGHT = 36;
    const systemAppRowCount = filePath || browserUrl
      ? (loading ? 1 : Math.max(apps.length, filePath && !browserOpenAction ? 1 : 0))
      : 0;
    const revealRowCount = revealFolderPath || filePath ? 1 : 0;
    const rowCount =
      systemAppRowCount +
      revealRowCount +
      (browserOpenAction ? 1 : 0);
    const separatorHeight = revealRowCount > 0 && rowCount > revealRowCount ? 9 : 0;
    const naturalHeight = Math.max(48, rowCount * MENU_ROW_HEIGHT + separatorHeight + 12);
    const estimatedHeight = Math.min(MAX_MENU_HEIGHT, naturalHeight);
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const spaceAbove = rect.top - 8;
    let top: number;
    if (spaceBelow >= estimatedHeight + 4) {
      top = rect.bottom + 4;
    } else if (spaceAbove >= estimatedHeight + 4) {
      top = rect.top - estimatedHeight - 4;
    } else {
      // Neither side has enough room — pick whichever is larger and clamp.
      top = spaceBelow >= spaceAbove
        ? Math.max(8, window.innerHeight - estimatedHeight - 8)
        : 8;
    }
    // The menu is right-aligned to the anchor via translateX(-100%); keep it
    // inside the viewport on both sides.
    const MENU_ESTIMATED_WIDTH = 232;
    const left = Math.max(
      MENU_ESTIMATED_WIDTH + 8,
      Math.min(rect.right, window.innerWidth - 8),
    );
    setPosition({ top, left });
  }, [anchorRef, apps, browserOpenAction, browserUrl, filePath, loading, revealFolderPath]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node) &&
          anchorRef.current && !anchorRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [anchorRef, onClose]);

  const handleOpenWithSpecificApp = useCallback(async (app: ShellAppInfo) => {
    if (!filePath && !browserUrl) return;
    let success = false;
    try {
      if (browserUrl) {
        const result = await window.electron?.shell?.openUrlWithApp(browserUrl, app.path);
        success = Boolean(result?.success);
        if (!result?.success) {
          console.warn('[ArtifactPreviewCard] system app open request failed:', {
            appName: app.name,
            targetType: 'url',
            error: result?.error,
          });
          showShellFailureToast(result, 'openFileFailed');
        }
      } else if (filePath) {
        const result = await window.electron?.shell?.openPathWithApp(normalizeShellFilePath(filePath), app.path);
        success = Boolean(result?.success);
        if (!result?.success) {
          console.warn('[ArtifactPreviewCard] system app open request failed:', {
            appName: app.name,
            targetType: 'file',
            error: result?.error,
          });
          showShellFailureToast(result, 'openFileFailed');
        }
      }
    } catch (error) {
      console.warn('[ArtifactPreviewCard] failed to open artifact with app:', error);
      showShellFailureToast(null, 'openFileFailed');
    }
    reportArtifactPreviewAction({
      actionType: 'open_external_app',
      source: 'conversation_artifact_card',
      artifact,
      params: {
        appName: app.name,
        isDefaultApp: app.isDefault,
        openTarget: 'external_app',
        result: success ? 'success' : 'failed',
      },
    });
    onClose();
  }, [artifact, browserUrl, filePath, onClose]);

  const handleOpenWithDefault = useCallback(async () => {
    if (!filePath) return;
    const normalized = normalizeShellFilePath(filePath);
    let success = false;
    try {
      const result = await window.electron?.shell?.openPath(normalized);
      success = Boolean(result?.success);
      if (!result?.success) {
        showShellFailureToast(result, 'openFileFailed');
      }
    } catch {
      showShellFailureToast(null, 'openFileFailed');
    }
    reportArtifactPreviewAction({
      actionType: 'open_external_app',
      source: 'conversation_artifact_card',
      artifact,
      params: {
        appName: 'default',
        openTarget: 'external_app',
        result: success ? 'success' : 'failed',
      },
    });
    onClose();
  }, [artifact, filePath, onClose]);

  const handleRevealInFolder = useCallback(async () => {
    const pathToReveal = revealFolderPath || filePath;
    if (!pathToReveal) return;
    const normalized = normalizeShellFilePath(pathToReveal);
    await revealLocalPathWithToast(normalized);
    reportArtifactPreviewAction({
      actionType: 'reveal_in_folder',
      source: 'conversation_artifact_card',
      artifact,
      params: {
        openTarget: 'folder',
      },
    });
    onClose();
  }, [artifact, filePath, onClose, revealFolderPath]);

  const handleBrowserOpen = useCallback(() => {
    reportArtifactPreviewAction({
      actionType: 'open_lobster_browser',
      source: 'conversation_artifact_card',
      artifact,
      params: {
        openTarget: 'lobster_browser',
      },
    });
    browserOpenAction?.onOpen();
    onClose();
  }, [artifact, browserOpenAction, onClose]);

  if (!position) return null;

  const menuItemClassName = 'flex h-9 w-full flex-shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-[13px] text-foreground hover:bg-black/[0.05] dark:hover:bg-white/[0.08] transition-colors text-left';
  const menuIconClassName = 'h-[18px] w-[18px] flex-shrink-0';

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[10000] min-w-[224px] max-w-[300px] max-h-[356px] overflow-y-auto rounded-2xl border border-border bg-surface-raised p-1.5 shadow-[0_12px_36px_rgba(0,0,0,0.14),0_2px_8px_rgba(0,0,0,0.08)] dark:shadow-[0_12px_36px_rgba(0,0,0,0.5),0_2px_8px_rgba(0,0,0,0.4)] animate-in fade-in zoom-in-95 duration-100"
      style={{ top: position.top, left: position.left, transform: 'translateX(-100%)' }}
    >
      {browserOpenAction && (
        <button
          type="button"
          onClick={handleBrowserOpen}
          className={menuItemClassName}
        >
          <img src="logo.png" alt="" className={menuIconClassName} draggable={false} />
          <span className="truncate">{browserOpenAction.label}</span>
        </button>
      )}
      {(filePath || browserUrl) && loading ? (
        <div className="flex h-9 items-center gap-2.5 px-2.5 text-[13px] text-secondary">
          <div className="h-3.5 w-3.5 flex-shrink-0 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
          <span className="truncate">{t('artifactOpenWithLoadingApps')}</span>
        </div>
      ) : (filePath || browserUrl) && apps.length > 0 ? (
        <>
          {apps.map((app, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => handleOpenWithSpecificApp(app)}
              className={menuItemClassName}
            >
              {app.icon ? (
                <img src={app.icon} alt="" className={menuIconClassName} draggable={false} />
              ) : (
                <AppIcon className={`${menuIconClassName} text-secondary`} />
              )}
              <span className="truncate">
                {app.isDefault ? `${app.name}${t('artifactOpenWithDefaultSuffix')}` : app.name}
              </span>
            </button>
          ))}
        </>
      ) : filePath && !browserOpenAction ? (
        <button
          type="button"
          onClick={handleOpenWithDefault}
          className={menuItemClassName}
        >
          <AppIcon className={`${menuIconClassName} text-secondary`} />
          <span className="truncate">{t('artifactOpenWithApp')}</span>
        </button>
      ) : null}
      {(revealFolderPath || filePath) && (
        <>
          <div className="mx-2 my-1 border-t border-border" />
          <button
            type="button"
            onClick={handleRevealInFolder}
            className={menuItemClassName}
          >
            <FolderIcon className={`${menuIconClassName} text-secondary`} strokeWidth={1.6} />
            <span className="truncate">{t('artifactOpenInFolder')}</span>
          </button>
        </>
      )}
    </div>,
    document.body
  );
};

function getDirectoryBaseName(directory?: string): string {
  const normalized = directory?.trim().replace(/\\/g, '/') || '';
  if (!normalized) return '';
  const trimmed = normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
  const lastSlash = trimmed.lastIndexOf('/');
  return lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
}

// ── Main Card Component ──────────────────────────────────────────

interface ArtifactPreviewCardProps {
  artifact: Artifact;
  localServiceDirectory?: string;
  onOpenLocalService?: (artifact: Artifact) => void;
  onDeployLocalService?: (artifact: Artifact) => void;
  onOpenHtmlFile?: (artifact: Artifact) => void;
  /**
   * Overrides the default preview-tab behavior for contexts without the
   * artifact panel (e.g. the scheduled task run modal).
   */
  onOpenPreview?: (artifact: Artifact) => void;
}

const ArtifactPreviewCard: React.FC<ArtifactPreviewCardProps> = ({
  artifact,
  localServiceDirectory,
  onOpenLocalService,
  onDeployLocalService,
  onOpenHtmlFile,
  onOpenPreview,
}) => {
  const dispatch = useDispatch();
  const artifactFileShare = useOptionalArtifactFileShare();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownAnchorRef = useRef<HTMLButtonElement>(null);

  const handleClick = useCallback(() => {
    reportArtifactPreviewAction({
      actionType: 'card_open',
      source: 'conversation_artifact_card',
      artifact,
      params: {
        openTarget: artifact.type === ArtifactTypeValue.LocalService || artifact.type === ArtifactTypeValue.Html
          ? 'lobster_browser'
          : 'preview_panel',
      },
    });
    if (artifact.type === ArtifactTypeValue.LocalService && onOpenLocalService) {
      onOpenLocalService(artifact);
      return;
    }
    if (artifact.type === ArtifactTypeValue.Html && artifact.filePath && onOpenHtmlFile) {
      onOpenHtmlFile(artifact);
      return;
    }
    if (onOpenPreview) {
      onOpenPreview(artifact);
      return;
    }
    dispatch(openArtifactPreviewTab({ sessionId: artifact.sessionId, artifactId: artifact.id }));
  }, [artifact, dispatch, onOpenHtmlFile, onOpenLocalService, onOpenPreview]);

  const handleShareClick = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    void artifactFileShare?.openShare(artifact, {
      source: ArtifactPreviewActionSource.ConversationArtifactCard,
      entryPoint: ArtifactPublishEntryPoint.PreviewCard,
    });
  }, [artifact, artifactFileShare]);

  const handleDeployClick = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onDeployLocalService?.(artifact);
  }, [artifact, onDeployLocalService]);

  const descriptor = getPreviewCardDescriptor(artifact);
  const supportsOpenMenu = descriptor.supportsOpenMenu;
  const canShare = artifact.type !== ArtifactTypeValue.LocalService &&
    Boolean(artifactFileShare) &&
    isArtifactFileShareable(artifact);
  const canDeploy = artifact.type === ArtifactTypeValue.LocalService &&
    Boolean(onDeployLocalService);
  const cardClassName = 'artifact-preview-card-row group flex min-h-[58px] items-center gap-3 px-4 py-3 transition-colors w-full text-left';
  const iconClassName = 'w-5 h-5';
  const localServiceUrl = artifact.type === ArtifactTypeValue.LocalService
    ? artifact.url || artifact.content
    : '';
  const effectiveLocalServiceDirectory = artifact.type === ArtifactTypeValue.LocalService
    ? artifact.localService?.projectDirectory?.trim() || localServiceDirectory?.trim() || ''
    : '';
  const localServiceProjectName = getDirectoryBaseName(effectiveLocalServiceDirectory);

  // Warm the "Open with" app list (and app icons) as soon as the card shows,
  // so the dropdown opens instantly instead of flashing a loading state.
  const prefetchFilePath = supportsOpenMenu && artifact.type !== ArtifactTypeValue.LocalService
    ? artifact.filePath
    : undefined;
  const prefetchBrowserDirectory = supportsOpenMenu && artifact.type === ArtifactTypeValue.LocalService
    ? effectiveLocalServiceDirectory
    : undefined;
  const shouldPrefetchBrowserApps = supportsOpenMenu &&
    artifact.type === ArtifactTypeValue.LocalService &&
    Boolean(localServiceUrl);
  useEffect(() => {
    if (prefetchFilePath) {
      void prefetchAppsForFile(prefetchFilePath);
    } else if (shouldPrefetchBrowserApps) {
      void prefetchBrowserApps(prefetchBrowserDirectory || undefined);
    }
  }, [prefetchBrowserDirectory, prefetchFilePath, shouldPrefetchBrowserApps]);
  const displaySubtitle = artifact.type === ArtifactTypeValue.LocalService && localServiceProjectName
    ? `${localServiceProjectName} · ${descriptor.subtitle}`
    : descriptor.subtitle;
  const browserOpenAction = (
    (artifact.type === ArtifactTypeValue.Html && artifact.filePath) ||
    (artifact.type === ArtifactTypeValue.LocalService && localServiceUrl)
  )
    ? { label: t('artifactPreviewCardLobsterBrowser'), onOpen: handleClick }
    : undefined;
  const subtitle = (
    <>
      <span className="group-hover:hidden">{displaySubtitle}</span>
      <span className="hidden group-hover:inline">{descriptor.hoverSubtitle}</span>
    </>
  );

  if (supportsOpenMenu) {
    return (
      <div className={cardClassName}>
        <ArtifactPreviewIdentity
          artifact={artifact}
          descriptor={descriptor}
          subtitle={subtitle}
          subtitleTitle={effectiveLocalServiceDirectory || undefined}
          iconContainerClassName="flex-shrink-0 w-8 h-8 rounded-md bg-surface dark:bg-white/[0.04] flex items-center justify-center"
          iconClassName={iconClassName}
          titleClassName="text-sm font-medium text-foreground truncate"
          subtitleClassName="text-xs text-secondary truncate"
          unwrapped
          contentButtonProps={{
            type: 'button',
            onClick: handleClick,
            className: 'flex-1 min-w-0 text-left cursor-pointer bg-transparent border-none p-0',
          }}
        />
        <button
          ref={dropdownAnchorRef as React.RefObject<HTMLButtonElement>}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setDropdownOpen(v => {
              const nextOpen = !v;
              reportArtifactPreviewAction({
                actionType: 'open_menu_toggle',
                source: 'conversation_artifact_card',
                artifact,
                params: {
                  targetOpen: nextOpen,
                },
              });
              return nextOpen;
            });
          }}
          className="ml-auto inline-flex h-9 min-w-[96px] flex-shrink-0 items-center justify-center gap-1 rounded-lg border border-border bg-transparent px-3 text-sm font-medium text-foreground transition-colors hover:bg-surface"
          aria-label={t('artifactPreviewCardOpenWith')}
        >
          <span>{t('artifactPreviewCardOpenWith')}</span>
          <ChevronDownIcon className="w-3.5 h-3.5" />
        </button>
        {canShare && (
          <button
            type="button"
            onClick={handleShareClick}
            className="inline-flex h-9 min-w-[82px] flex-shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border bg-transparent px-3 text-sm font-medium text-foreground transition-colors hover:bg-surface"
            aria-label={t('htmlShare')}
          >
            <ArrowUpTrayIcon className="h-4 w-4" />
            <span>{t('htmlShare')}</span>
          </button>
        )}
        {canDeploy && (
          <button
            type="button"
            onClick={handleDeployClick}
            className="inline-flex h-9 min-w-[82px] flex-shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border bg-transparent px-3 text-sm font-medium text-foreground transition-colors hover:bg-surface"
            aria-label={t('nodeDeploymentProgressDeploy')}
          >
            <ServiceDeploymentIcon className="h-4 w-4 translate-y-px" />
            <span>{t('nodeDeploymentProgressDeploy')}</span>
          </button>
        )}
        {dropdownOpen && (
          <OpenDropdown
            anchorRef={dropdownAnchorRef as React.RefObject<HTMLElement>}
            artifact={artifact}
            filePath={artifact.filePath}
            browserUrl={artifact.type === ArtifactTypeValue.LocalService ? localServiceUrl : undefined}
            browserProjectDirectory={
              artifact.type === ArtifactTypeValue.LocalService
                ? effectiveLocalServiceDirectory || undefined
                : undefined
            }
            revealFolderPath={
              artifact.type === ArtifactTypeValue.LocalService
                ? effectiveLocalServiceDirectory || undefined
                : undefined
            }
            browserOpenAction={browserOpenAction}
            onClose={() => setDropdownOpen(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div className={cardClassName}>
      <button
        type="button"
        onClick={handleClick}
        className="flex min-w-0 flex-1 items-center gap-3 bg-transparent p-0 text-left cursor-pointer"
      >
        <ArtifactPreviewIdentity
          artifact={artifact}
          descriptor={descriptor}
          subtitle={subtitle}
          subtitleTitle={effectiveLocalServiceDirectory || undefined}
          iconContainerClassName="flex-shrink-0 w-8 h-8 rounded-md bg-surface dark:bg-white/[0.04] flex items-center justify-center"
          iconClassName={iconClassName}
          contentClassName="flex-1 min-w-0"
          titleClassName="text-sm font-medium text-foreground truncate"
          subtitleClassName="text-xs text-secondary truncate"
          unwrapped
        />
        <div className="flex-shrink-0 flex items-center gap-1 text-primary text-sm font-medium leading-none">
          <ArrowTopRightOnSquareIcon className="w-4 h-4 shrink-0" />
          <span>{t('artifactOpen')}</span>
        </div>
      </button>
      {canShare && (
        <button
          type="button"
          onClick={handleShareClick}
          className="inline-flex h-9 min-w-[82px] flex-shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border bg-transparent px-3 text-sm font-medium text-foreground transition-colors hover:bg-surface"
          aria-label={t('htmlShare')}
        >
          <ArrowUpTrayIcon className="h-4 w-4" />
          <span>{t('htmlShare')}</span>
        </button>
      )}
    </div>
  );
};

export default ArtifactPreviewCard;
