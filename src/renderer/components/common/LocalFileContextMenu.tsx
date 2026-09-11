import { ChevronRightIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';
import {
  getCachedAppsForFile,
  normalizeShellFilePath,
  prefetchAppsForFile,
  type ShellAppInfo,
} from '@/services/shellAppsCache';
import {
  openLocalPathWithToast,
  revealLocalPathWithToast,
  showShellFailureToast,
  showToast,
} from '@/utils/localFileActions';
import { canCopyLocalFileAsText } from '@/utils/localFileContentPolicy';

import type { ArtifactFileAccess } from '../../../shared/artifactPreview/types';
import { getFileTypeInfo } from '../icons/fileTypes/index';

const t = (key: string) => i18nService.t(key);

const MENU_CONTAINER_CLASS = 'pointer-events-auto fixed overflow-y-auto rounded-2xl border border-border bg-surface-raised p-1.5 shadow-[0_12px_36px_rgba(0,0,0,0.14),0_2px_8px_rgba(0,0,0,0.08)] dark:shadow-[0_12px_36px_rgba(0,0,0,0.5),0_2px_8px_rgba(0,0,0,0.4)] animate-in fade-in zoom-in-95 duration-100';
const MENU_ITEM_CLASS = 'flex h-9 w-full flex-shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-[13px] text-foreground hover:bg-black/[0.05] dark:hover:bg-white/[0.08] transition-colors text-left';
const MENU_ICON_CLASS = 'h-[18px] w-[18px] flex-shrink-0';
const SUBMENU_ESTIMATED_WIDTH = 224;
const VIEWPORT_MARGIN = 8;
const MENU_MIN_WIDTH = 196;
const MENU_MAX_WIDTH = 300;
const MENU_MAX_HEIGHT = 356;

const logContextMenuFailure = (operation: string, detail?: unknown): void => {
  const message = `${operation} failed${detail ? `: ${String(detail)}` : ''}`;
  console.warn(`[LocalFileContextMenu] ${message}`);
  try {
    window.electron?.log?.fromRenderer?.('warn', 'LocalFileContextMenu', message);
  } catch {
    // Diagnostic logging is best-effort and must not break file actions.
  }
};

const AppIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="4" />
    <path d="M8 12h8" />
    <path d="M12 8v8" />
  </svg>
);

export interface LocalFileContextMenuProps {
  filePath: string;
  fileAccess?: ArtifactFileAccess;
  isDirectory?: boolean;
  position: { x: number; y: number };
  onClose: () => void;
}

const LocalFileContextMenu: React.FC<LocalFileContextMenuProps> = ({
  filePath,
  fileAccess,
  isDirectory = false,
  position,
  onClose,
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const openWithRowRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const [submenuPos, setSubmenuPos] = useState<{ top: number; left: number } | null>(null);
  const normalizedPath = normalizeShellFilePath(filePath);
  const cachedApps = isDirectory ? null : getCachedAppsForFile(filePath);
  const [apps, setApps] = useState<ShellAppInfo[]>(cachedApps ?? []);
  const [loadingApps, setLoadingApps] = useState(!cachedApps && !isDirectory);

  const fileName = normalizedPath.split(/[\\/]/).pop() ?? normalizedPath;
  const fileTypeLabel = getFileTypeInfo(fileName).label;
  const isImageFile = !isDirectory && fileTypeLabel === 'Image';
  const supportsCopyContents = !isDirectory && canCopyLocalFileAsText(fileName);
  const viewportMenuStyle = {
    minWidth: Math.max(0, Math.min(MENU_MIN_WIDTH, window.innerWidth - (VIEWPORT_MARGIN * 2))),
    maxWidth: Math.max(0, Math.min(MENU_MAX_WIDTH, window.innerWidth - (VIEWPORT_MARGIN * 2))),
    maxHeight: Math.max(0, Math.min(MENU_MAX_HEIGHT, window.innerHeight - (VIEWPORT_MARGIN * 2))),
  };

  useEffect(() => {
    if (isDirectory) return undefined;
    let cancelled = false;
    prefetchAppsForFile(filePath).then(result => {
      if (cancelled) return;
      if (result) setApps(result);
      setLoadingApps(false);
    });
    return () => { cancelled = true; };
  }, [filePath, isDirectory]);

  // Clamp the menu into the viewport once its rendered size is known.
  useLayoutEffect(() => {
    const menuEl = menuRef.current;
    if (!menuEl) return;
    const rect = menuEl.getBoundingClientRect();
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(position.x, window.innerWidth - rect.width - VIEWPORT_MARGIN),
    );
    const top = Math.max(
      VIEWPORT_MARGIN,
      Math.min(position.y, window.innerHeight - rect.height - VIEWPORT_MARGIN),
    );
    setMenuPos({ top, left });
  }, [position.x, position.y]);

  useEffect(() => {
    const handlePointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const handleViewportChange = () => onClose();
    const handleScroll = (e: Event) => {
      // Scrolling inside the menu itself (e.g. a long app list) must not dismiss it.
      if (rootRef.current && e.target instanceof Node && rootRef.current.contains(e.target)) {
        return;
      }
      onClose();
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('scroll', handleScroll, true);
    window.addEventListener('blur', handleViewportChange);
    window.addEventListener('resize', handleViewportChange);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('blur', handleViewportChange);
      window.removeEventListener('resize', handleViewportChange);
    };
  }, [onClose]);

  const openSubmenu = useCallback(() => {
    const rowEl = openWithRowRef.current;
    const menuEl = menuRef.current;
    if (!rowEl || !menuEl) return;
    const rowRect = rowEl.getBoundingClientRect();
    const menuRect = menuEl.getBoundingClientRect();
    let left = menuRect.right + 2;
    if (left + SUBMENU_ESTIMATED_WIDTH > window.innerWidth - VIEWPORT_MARGIN) {
      left = Math.max(VIEWPORT_MARGIN, menuRect.left - SUBMENU_ESTIMATED_WIDTH - 2);
    }
    setSubmenuPos({ top: rowRect.top - 6, left });
    setSubmenuOpen(true);
  }, []);

  const closeSubmenu = useCallback(() => setSubmenuOpen(false), []);

  // The submenu size depends on the async app list; re-clamp both axes when it
  // settles so narrow/short windows never leave actions off-screen.
  useLayoutEffect(() => {
    if (!submenuOpen) return;
    const el = submenuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const maxTop = window.innerHeight - rect.height - VIEWPORT_MARGIN;
    const maxLeft = window.innerWidth - rect.width - VIEWPORT_MARGIN;
    setSubmenuPos(prev => {
      if (!prev) return prev;
      const top = Math.max(VIEWPORT_MARGIN, Math.min(prev.top, maxTop));
      const left = Math.max(VIEWPORT_MARGIN, Math.min(prev.left, maxLeft));
      return top === prev.top && left === prev.left ? prev : { top, left };
    });
  }, [submenuOpen, apps, loadingApps]);

  const handleOpen = useCallback(async () => {
    onClose();
    await openLocalPathWithToast(normalizedPath);
  }, [normalizedPath, onClose]);

  const handleOpenWithApp = useCallback(async (appItem: ShellAppInfo) => {
    onClose();
    try {
      const result = await window.electron?.shell?.openPathWithApp(normalizedPath, appItem.path);
      if (!result?.success) {
        logContextMenuFailure(`open with ${appItem.name}`, result?.error);
        showShellFailureToast(result, 'openFileFailed');
      }
    } catch (error) {
      logContextMenuFailure(`open with ${appItem.name}`, error);
      showShellFailureToast(null, 'openFileFailed');
    }
  }, [normalizedPath, onClose]);

  const handleSaveAs = useCallback(async () => {
    onClose();
    try {
      const result = await window.electron?.dialog?.saveFileCopy(normalizedPath, fileAccess);
      if (result && !result.success) {
        logContextMenuFailure('save file copy', result.error);
        showToast(t('fileMenuSaveFailed'));
      }
    } catch (error) {
      logContextMenuFailure('save file copy', error);
      showToast(t('fileMenuSaveFailed'));
    }
  }, [fileAccess, normalizedPath, onClose]);

  const handleCopyPath = useCallback(async () => {
    onClose();
    try {
      const result = await window.electron?.clipboard?.writeText(normalizedPath);
      if (!result?.success) {
        logContextMenuFailure('copy file path');
      }
      showToast(t(result?.success ? 'copied' : 'copyFailed'));
    } catch (error) {
      logContextMenuFailure('copy file path', error);
      showToast(t('copyFailed'));
    }
  }, [normalizedPath, onClose]);

  const handleCopyContents = useCallback(async () => {
    onClose();
    try {
      const readResult = await window.electron?.dialog?.readTextFile(normalizedPath, fileAccess);
      if (readResult?.truncated) {
        logContextMenuFailure(
          'copy file contents because the file exceeds the safe read limit',
          `size=${readResult.size ?? 'unknown'}, readBytes=${readResult.readBytes ?? 'unknown'}`,
        );
        showToast(t('fileMenuCopyContentsTooLarge'));
        return;
      }
      const content = readResult?.success ? readResult.content : undefined;
      if (typeof content !== 'string' || content.includes('\u0000')) {
        logContextMenuFailure('copy file contents', readResult?.error || 'file is not readable text');
        showToast(t('copyFailed'));
        return;
      }
      const writeResult = await window.electron?.clipboard?.writeText(content);
      if (!writeResult?.success) {
        logContextMenuFailure('write file contents to clipboard');
      }
      showToast(t(writeResult?.success ? 'copied' : 'copyFailed'));
    } catch (error) {
      logContextMenuFailure('copy file contents', error);
      showToast(t('copyFailed'));
    }
  }, [fileAccess, normalizedPath, onClose]);

  const handleCopyImage = useCallback(async () => {
    onClose();
    try {
      const result = await window.electron?.clipboard?.writeImageFromFile(normalizedPath);
      if (!result?.success) {
        logContextMenuFailure('copy image');
      }
      showToast(t(result?.success ? 'copied' : 'copyFailed'));
    } catch (error) {
      logContextMenuFailure('copy image', error);
      showToast(t('copyFailed'));
    }
  }, [normalizedPath, onClose]);

  const handleReveal = useCallback(async () => {
    onClose();
    await revealLocalPathWithToast(normalizedPath);
  }, [normalizedPath, onClose]);

  const platform = window.electron?.platform;
  const revealLabel = platform === 'darwin'
    ? t('fileMenuRevealFinder')
    : platform === 'win32'
      ? t('fileMenuRevealExplorer')
      : t('showInFolder');

  return createPortal(
    <div ref={rootRef} className="pointer-events-none fixed inset-0 z-[10000]">
      <div
        ref={menuRef}
        className={MENU_CONTAINER_CLASS}
        style={{
          top: menuPos?.top ?? position.y,
          left: menuPos?.left ?? position.x,
          visibility: menuPos ? undefined : 'hidden',
          ...viewportMenuStyle,
        }}
      >
        <button type="button" onClick={handleOpen} onMouseEnter={closeSubmenu} className={MENU_ITEM_CLASS}>
          <span className="truncate">{t(isDirectory ? 'openFolder' : 'openFile')}</span>
        </button>
        {!isDirectory && (
          <button
            ref={openWithRowRef}
            type="button"
            onClick={() => (submenuOpen ? closeSubmenu() : openSubmenu())}
            onMouseEnter={openSubmenu}
            className={`${MENU_ITEM_CLASS}${submenuOpen ? ' bg-black/[0.05] dark:bg-white/[0.08]' : ''}`}
          >
            <span className="truncate">{t('fileMenuOpenWith')}</span>
            <ChevronRightIcon className="ml-auto h-3.5 w-3.5 flex-shrink-0 text-secondary" />
          </button>
        )}
        <div className="mx-2 my-1 border-t border-border" />
        {!isDirectory && (
          <button type="button" onClick={handleSaveAs} onMouseEnter={closeSubmenu} className={MENU_ITEM_CLASS}>
            <span className="truncate">{t('fileMenuSaveAs')}</span>
          </button>
        )}
        <button type="button" onClick={handleCopyPath} onMouseEnter={closeSubmenu} className={MENU_ITEM_CLASS}>
          <span className="truncate">{t('fileMenuCopyPath')}</span>
        </button>
        {isImageFile && (
          <button type="button" onClick={handleCopyImage} onMouseEnter={closeSubmenu} className={MENU_ITEM_CLASS}>
            <span className="truncate">{t('fileMenuCopyImage')}</span>
          </button>
        )}
        {supportsCopyContents && (
          <button type="button" onClick={handleCopyContents} onMouseEnter={closeSubmenu} className={MENU_ITEM_CLASS}>
            <span className="truncate">{t('fileMenuCopyContents')}</span>
          </button>
        )}
        <button type="button" onClick={handleReveal} onMouseEnter={closeSubmenu} className={MENU_ITEM_CLASS}>
          <span className="truncate">{revealLabel}</span>
        </button>
      </div>
      {submenuOpen && submenuPos && !isDirectory && (
        <div
          ref={submenuRef}
          className={MENU_CONTAINER_CLASS}
          style={{ top: submenuPos.top, left: submenuPos.left, ...viewportMenuStyle }}
        >
          {loadingApps ? (
            <div className="flex h-9 items-center gap-2.5 px-2.5 text-[13px] text-secondary">
              <div className="h-3.5 w-3.5 flex-shrink-0 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
              <span className="truncate">{t('artifactOpenWithLoadingApps')}</span>
            </div>
          ) : apps.length > 0 ? (
            apps.map((appItem, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => handleOpenWithApp(appItem)}
                className={MENU_ITEM_CLASS}
              >
                {appItem.icon ? (
                  <img src={appItem.icon} alt="" className={MENU_ICON_CLASS} draggable={false} />
                ) : (
                  <AppIcon className={`${MENU_ICON_CLASS} text-secondary`} />
                )}
                <span className="truncate">
                  {appItem.isDefault ? `${appItem.name}${t('artifactOpenWithDefaultSuffix')}` : appItem.name}
                </span>
              </button>
            ))
          ) : (
            <button type="button" onClick={handleOpen} className={MENU_ITEM_CLASS}>
              <span className="truncate">{t('artifactOpenWithApp')}</span>
            </button>
          )}
        </div>
      )}
    </div>,
    document.body,
  );
};

export default LocalFileContextMenu;
