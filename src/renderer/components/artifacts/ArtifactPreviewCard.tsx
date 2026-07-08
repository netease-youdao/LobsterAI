import { ArrowTopRightOnSquareIcon } from '@heroicons/react/20/solid';
import { ChevronDownIcon, FolderIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDispatch } from 'react-redux';

import { i18nService } from '@/services/i18n';
import { openArtifactPreviewTab } from '@/store/slices/artifactSlice';
import { type Artifact, ArtifactTypeValue } from '@/types/artifact';
import { revealLocalPathWithToast, showShellFailureToast } from '@/utils/localFileActions';

import FileTypeIcon from '../icons/fileTypes/FileTypeIcon';
import { reportArtifactPreviewAction } from './artifactAnalytics';
import {
  getPreviewCardDescriptor,
  PreviewCardDisplayKind,
} from './previewCardPolicy';

const t = (key: string) => i18nService.t(key);

const GlobeIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <ellipse cx="12" cy="12" rx="4.5" ry="10" />
    <path d="M2 12h20" />
  </svg>
);

const AppIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="4" />
    <path d="M8 12h8" />
    <path d="M12 8v8" />
  </svg>
);

function normalizeFilePath(filePath: string): string {
  let normalized = filePath;
  if (normalized.startsWith('file:///')) {
    normalized = normalized.slice(7);
  } else if (normalized.startsWith('file://')) {
    normalized = normalized.slice(7);
  } else if (normalized.startsWith('file:/')) {
    normalized = normalized.slice(5);
  }
  if (/^\/[A-Za-z]:/.test(normalized)) {
    normalized = normalized.slice(1);
  }
  return normalized;
}

// ── Dropdown Menu for Document Artifacts ──────────────────────────

interface AppInfo {
  name: string;
  path: string;
  isDefault: boolean;
  icon?: string;
}

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
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [loading, setLoading] = useState(Boolean(filePath || browserUrl));

  useEffect(() => {
    if (!filePath && !browserUrl) {
      setApps([]);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    const appsPromise = filePath
      ? window.electron?.shell?.getAppsForFile(normalizeFilePath(filePath))
      : window.electron?.shell?.getBrowserApps(
          browserProjectDirectory ? { projectDirectory: browserProjectDirectory } : undefined,
        );
    if (!appsPromise) {
      setLoading(false);
      return undefined;
    }
    appsPromise.then(result => {
      if (cancelled) return;
      if (result?.success && result.apps?.length > 0) {
        setApps(result.apps);
      }
      setLoading(false);
    }).catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [browserProjectDirectory, browserUrl, filePath]);

  useEffect(() => {
    if (!anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const MAX_MENU_HEIGHT = 320;
    const systemAppActionCount = filePath || browserUrl ? apps.length : 0;
    const revealActionCount = revealFolderPath || filePath ? 1 : 0;
    const actionCount =
      systemAppActionCount +
      revealActionCount +
      (browserOpenAction ? 1 : 0);
    const naturalHeight = loading ? 88 : Math.max(88, actionCount * 36 + 16);
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
    const left = Math.min(rect.right, window.innerWidth - 200);
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

  const handleOpenWithSpecificApp = useCallback(async (app: AppInfo) => {
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
        const result = await window.electron?.shell?.openPathWithApp(normalizeFilePath(filePath), app.path);
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
    const normalized = normalizeFilePath(filePath);
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
    const normalized = normalizeFilePath(pathToReveal);
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

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[10000] min-w-[180px] max-h-[320px] overflow-y-auto rounded-lg border border-border bg-surface-raised shadow-lg py-1 animate-in fade-in zoom-in-95 duration-100"
      style={{ top: position.top, left: position.left, transform: 'translateX(-100%)' }}
    >
      {browserOpenAction && (
        <button
          type="button"
          onClick={handleBrowserOpen}
          className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-foreground hover:bg-black/[0.06] dark:hover:bg-white/[0.08] transition-colors text-left"
        >
          <GlobeIcon className="w-4 h-4 text-primary flex-shrink-0" />
          <span className="truncate">{browserOpenAction.label}</span>
        </button>
      )}
      {(filePath || browserUrl) && loading ? (
        <div className="flex items-center justify-center px-3 py-3">
          <div className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        </div>
      ) : (filePath || browserUrl) && apps.length > 0 ? (
        <>
          {apps.map((app, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => handleOpenWithSpecificApp(app)}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-foreground hover:bg-black/[0.06] dark:hover:bg-white/[0.08] transition-colors text-left"
            >
              {app.icon ? (
                <img src={app.icon} alt="" className="w-4 h-4 flex-shrink-0" draggable={false} />
              ) : (
                <AppIcon className="w-4 h-4 text-secondary flex-shrink-0" />
              )}
              <span className="truncate">{app.name}</span>
            </button>
          ))}
        </>
      ) : filePath && !browserOpenAction ? (
        <button
          type="button"
          onClick={handleOpenWithDefault}
          className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-foreground hover:bg-black/[0.06] dark:hover:bg-white/[0.08] transition-colors text-left"
        >
          <AppIcon className="w-4 h-4 text-secondary flex-shrink-0" />
          <span>{t('artifactOpenWithApp')}</span>
        </button>
      ) : null}
      {(revealFolderPath || filePath) && (
        <>
          <div className="mx-2 my-1 border-t border-border" />
          <button
            type="button"
            onClick={handleRevealInFolder}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-foreground hover:bg-black/[0.06] dark:hover:bg-white/[0.08] transition-colors text-left"
          >
            <FolderIcon className="w-4 h-4 text-secondary flex-shrink-0" />
            <span>{t('artifactOpenInFolder')}</span>
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
  onOpenHtmlFile?: (artifact: Artifact) => void;
}

const ArtifactPreviewCard: React.FC<ArtifactPreviewCardProps> = ({
  artifact,
  localServiceDirectory,
  onOpenLocalService,
  onOpenHtmlFile,
}) => {
  const dispatch = useDispatch();
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
    dispatch(openArtifactPreviewTab({ sessionId: artifact.sessionId, artifactId: artifact.id }));
  }, [artifact, dispatch, onOpenHtmlFile, onOpenLocalService]);

  const descriptor = getPreviewCardDescriptor(artifact);
  const isWebsiteCard = descriptor.displayKind === PreviewCardDisplayKind.Website;
  const supportsOpenMenu = descriptor.supportsOpenMenu;
  const cardClassName = 'artifact-preview-card-row group flex min-h-[58px] items-center gap-3 px-4 py-3 transition-colors w-full text-left';
  const iconClassName = 'w-5 h-5';
  const localServiceUrl = artifact.type === ArtifactTypeValue.LocalService
    ? artifact.url || artifact.content
    : '';
  const effectiveLocalServiceDirectory = artifact.type === ArtifactTypeValue.LocalService
    ? artifact.localService?.projectDirectory?.trim() || localServiceDirectory?.trim() || ''
    : '';
  const localServiceProjectName = getDirectoryBaseName(effectiveLocalServiceDirectory);
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
    <div className="text-xs text-secondary truncate" title={effectiveLocalServiceDirectory || undefined}>
      <span className="group-hover:hidden">{displaySubtitle}</span>
      <span className="hidden group-hover:inline">{descriptor.hoverSubtitle}</span>
    </div>
  );

  if (supportsOpenMenu) {
    return (
      <div className={cardClassName}>
        <div className="flex-shrink-0 w-8 h-8 rounded-md bg-surface dark:bg-white/[0.04] flex items-center justify-center">
          {isWebsiteCard ? (
            <GlobeIcon className={`${iconClassName} text-primary`} />
          ) : (
            <FileTypeIcon fileName={descriptor.iconFileName} className={iconClassName} />
          )}
        </div>
        <button
          type="button"
          onClick={handleClick}
          className="flex-1 min-w-0 text-left cursor-pointer bg-transparent border-none p-0"
        >
          <div className="text-sm font-medium text-foreground truncate">{descriptor.title}</div>
          {subtitle}
        </button>
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
          className="flex-shrink-0 ml-auto flex items-center gap-1 text-primary text-sm font-medium px-2 py-1 min-w-[78px] justify-end rounded-md hover:bg-primary/10 dark:hover:bg-primary/15 transition-colors"
          aria-label={t('artifactPreviewCardOpenWith')}
        >
          <span>{t('artifactPreviewCardOpenWith')}</span>
          <ChevronDownIcon className="w-3.5 h-3.5" />
        </button>
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
    <button
      type="button"
      onClick={handleClick}
      className={`${cardClassName} cursor-pointer`}
    >
      <div className="flex-shrink-0 w-8 h-8 rounded-md bg-surface dark:bg-white/[0.04] flex items-center justify-center">
        {isWebsiteCard ? (
          <GlobeIcon className={`${iconClassName} text-primary`} />
        ) : (
          <FileTypeIcon fileName={descriptor.iconFileName} className={iconClassName} />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-foreground truncate">{descriptor.title}</div>
        {subtitle}
      </div>
      <div className="flex-shrink-0 flex items-center gap-1 text-primary text-sm font-medium leading-none">
        <ArrowTopRightOnSquareIcon className="w-4 h-4 shrink-0" />
        <span>{t('artifactOpen')}</span>
      </div>
    </button>
  );
};

export default ArtifactPreviewCard;
