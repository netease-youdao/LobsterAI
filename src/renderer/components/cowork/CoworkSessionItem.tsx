import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CoworkSessionSummary, CoworkSessionStatus } from '../../types/cowork';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import EllipsisHorizontalIcon from '../icons/EllipsisHorizontalIcon';
import PencilSquareIcon from '../icons/PencilSquareIcon';
import TrashIcon from '../icons/TrashIcon';
import ListChecksIcon from '../icons/ListChecksIcon';
import { i18nService } from '../../services/i18n';

interface CoworkSessionItemProps {
  session: CoworkSessionSummary;
  hasUnread: boolean;
  isActive: boolean;
  isBatchMode: boolean;
  isSelected: boolean;
  showBatchOption?: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onTogglePin: (pinned: boolean) => void;
  onRename: (title: string) => void;
  onToggleSelection: () => void;
  onEnterBatchMode: () => void;
  onMoveToFolder?: (folder: string) => void;
  existingFolders?: string[];
}

const statusLabels: Record<CoworkSessionStatus, string> = {
  idle: 'coworkStatusIdle',
  running: 'coworkStatusRunning',
  completed: 'coworkStatusCompleted',
  error: 'coworkStatusError',
};

const PushPinIcon: React.FC<React.SVGProps<SVGSVGElement> & { slashed?: boolean }> = ({
  slashed,
  ...props
}) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  >
    <g transform="rotate(45 12 12)">
      <path d="M9 3h6l-1 5 2 2v2H8v-2l2-2-1-5z" />
      <path d="M12 12v9" />
    </g>
    {slashed && <path d="M5 5L19 19" />}
  </svg>
);

const FolderIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
  </svg>
);

const formatRelativeTime = (timestamp: number): { compact: string; full: string } => {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return { compact: 'now', full: i18nService.t('justNow') };
  if (minutes < 60) return { compact: `${minutes}m`, full: `${minutes} ${i18nService.t('minutesAgo')}` };
  if (hours < 24) return { compact: `${hours}h`, full: `${hours} ${i18nService.t('hoursAgo')}` };
  if (days === 1) return { compact: '1d', full: i18nService.t('yesterday') };
  return { compact: `${days}d`, full: `${days} ${i18nService.t('daysAgo')}` };
};

const CoworkSessionItem: React.FC<CoworkSessionItemProps> = ({
  session,
  hasUnread,
  isActive,
  isBatchMode,
  isSelected,
  showBatchOption = true,
  onSelect,
  onDelete,
  onTogglePin,
  onRename,
  onToggleSelection,
  onEnterBatchMode,
  onMoveToFolder,
  existingFolders = [],
}) => {
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(session.title);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  // Sub-menu: null = hidden, {x,y} = visible at position
  const [subMenuPos, setSubMenuPos] = useState<{ x: number; y: number } | null>(null);
  // New folder dialog
  const [showNewFolderDialog, setShowNewFolderDialog] = useState(false);
  const [newFolderValue, setNewFolderValue] = useState('');

  const menuRef = useRef<HTMLDivElement>(null);
  const subMenuRef = useRef<HTMLDivElement>(null);
  const actionButtonRef = useRef<HTMLButtonElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const newFolderInputRef = useRef<HTMLInputElement>(null);
  const ignoreNextBlurRef = useRef(false);
  const subMenuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isRenaming) {
      setRenameValue(session.title);
      ignoreNextBlurRef.current = false;
    }
  }, [isRenaming, session.title]);

  const calculateMenuPosition = (height: number) => {
    const rect = actionButtonRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const menuWidth = 180;
    const padding = 8;
    const x = Math.min(Math.max(padding, rect.right - menuWidth), window.innerWidth - menuWidth - padding);
    const y = Math.min(rect.bottom + 8, window.innerHeight - height - padding);
    return { x, y };
  };

  const openMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isRenaming) return;
    if (menuPosition) { closeMenu(); return; }
    const itemCount = (showBatchOption ? 1 : 0) + 2 + (onMoveToFolder ? 1 : 0) + 1; // batch+rename+pin+folder+delete
    const position = calculateMenuPosition(itemCount * 36 + 8);
    if (position) setMenuPosition(position);
    setShowConfirmDelete(false);
  };

  const closeMenu = () => {
    setMenuPosition(null);
    setShowConfirmDelete(false);
    closeSubMenu();
  };

  const openSubMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (subMenuTimerRef.current) clearTimeout(subMenuTimerRef.current);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const subMenuWidth = 160;
    const subMenuHeight = (existingFolders.length + (session.folder ? 1 : 0) + 1) * 36 + 8;
    const padding = 4;
    let x = rect.right + padding;
    if (x + subMenuWidth > window.innerWidth - padding) x = rect.left - subMenuWidth - padding;
    const y = Math.min(rect.top, window.innerHeight - subMenuHeight - padding);
    setSubMenuPos({ x, y });
  };

  const closeSubMenu = () => {
    if (subMenuTimerRef.current) clearTimeout(subMenuTimerRef.current);
    setSubMenuPos(null);
  };

  const scheduleCloseSubMenu = () => {
    subMenuTimerRef.current = setTimeout(() => setSubMenuPos(null), 150);
  };

  const cancelCloseSubMenu = () => {
    if (subMenuTimerRef.current) clearTimeout(subMenuTimerRef.current);
  };

  const handleTogglePin = (e: React.MouseEvent) => {
    e.stopPropagation();
    onTogglePin(!session.pinned);
    closeMenu();
  };

  const handleRenameClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    ignoreNextBlurRef.current = false;
    setIsRenaming(true);
    setShowConfirmDelete(false);
    setRenameValue(session.title);
    setMenuPosition(null);
  };

  const handleRenameSave = (e?: React.SyntheticEvent) => {
    e?.stopPropagation();
    ignoreNextBlurRef.current = true;
    const nextTitle = renameValue.trim();
    if (nextTitle && nextTitle !== session.title) onRename(nextTitle);
    setIsRenaming(false);
  };

  const handleRenameCancel = (e?: React.MouseEvent | React.KeyboardEvent) => {
    e?.stopPropagation();
    ignoreNextBlurRef.current = true;
    setRenameValue(session.title);
    setIsRenaming(false);
  };

  const handleRenameBlur = (event: React.FocusEvent<HTMLInputElement>) => {
    if (ignoreNextBlurRef.current) { ignoreNextBlurRef.current = false; return; }
    handleRenameSave(event);
  };

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowConfirmDelete(true);
    setMenuPosition(null);
  };

  const handleConfirmDelete = () => { onDelete(); setShowConfirmDelete(false); };
  const handleCancelDelete = (e?: React.MouseEvent) => { e?.stopPropagation(); setShowConfirmDelete(false); };

  const handleBatchClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    closeMenu();
    onEnterBatchMode();
  };

  const handleFolderSelect = (folderName: string) => {
    if (onMoveToFolder) onMoveToFolder(folderName);
    closeMenu();
  };

  const handleNewFolderClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setNewFolderValue('');
    setShowNewFolderDialog(true);
    closeMenu();
    // focus is handled by the useEffect below
  };

  const handleNewFolderConfirm = () => {
    const name = newFolderValue.trim();
    if (name && onMoveToFolder) onMoveToFolder(name);
    setShowNewFolderDialog(false);
  };

  // Close main menu on outside click / escape / scroll
  useEffect(() => {
    if (!menuPosition) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !menuRef.current?.contains(target) &&
        !subMenuRef.current?.contains(target) &&
        !actionButtonRef.current?.contains(target)
      ) {
        closeMenu();
      }
    };
    const handleEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') closeMenu(); };
    const handleScroll = () => closeMenu();
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleScroll);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleScroll);
    };
  }, [menuPosition]);

  useEffect(() => {
    if (!isRenaming) return;
    requestAnimationFrame(() => { renameInputRef.current?.focus(); renameInputRef.current?.select(); });
  }, [isRenaming]);

  useEffect(() => {
    if (!showNewFolderDialog) return;
    requestAnimationFrame(() => newFolderInputRef.current?.focus());
  }, [showNewFolderDialog]);

  const relativeTime = formatRelativeTime(session.updatedAt);
  const showRunningIndicator = session.status === 'running';
  const showUnreadIndicator = !showRunningIndicator && hasUnread;
  const showStatusIndicator = showRunningIndicator || showUnreadIndicator;

  // menuItems only changes when the structural props change; handlers are stable refs via useCallback
  const menuItems = useMemo(() => {
    type MenuItem = { key: string; label: string; onClick: (e: React.MouseEvent) => void; tone: 'neutral' | 'danger'; hasArrow?: boolean };
    const items: MenuItem[] = [
      { key: 'rename', label: i18nService.t('renameConversation'), onClick: handleRenameClick, tone: 'neutral' },
      { key: 'pin', label: session.pinned ? i18nService.t('coworkUnpinSession') : i18nService.t('coworkPinSession'), onClick: handleTogglePin, tone: 'neutral' },
      ...(onMoveToFolder ? [{ key: 'folder', label: i18nService.t('moveToFolder'), onClick: (e: React.MouseEvent) => e.stopPropagation(), tone: 'neutral' as const, hasArrow: true }] : []),
      { key: 'delete', label: i18nService.t('deleteSession'), onClick: handleDeleteClick, tone: 'danger' },
    ];
    if (showBatchOption) {
      items.unshift({ key: 'batch', label: i18nService.t('batchOperations'), onClick: handleBatchClick, tone: 'neutral' });
    }
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.pinned, !!onMoveToFolder, showBatchOption]);

  return (
    <div
      onClick={() => {
        if (isRenaming) return;
        closeMenu();
        if (isBatchMode) {
          onToggleSelection();
          return;
        }
        onSelect();
      }}
      className={`group relative p-3 rounded-lg cursor-pointer transition-all duration-150 ${
        isActive
          ? 'bg-black/[0.06] dark:bg-white/[0.08]'
          : 'hover:bg-black/[0.04] dark:hover:bg-white/[0.05]'
      }`}
    >
      {/* Content area */}
      <div className="flex items-start">
        {isBatchMode && (
          <div className="flex items-center mr-2 mt-0.5 flex-shrink-0">
            <input
              type="checkbox"
              checked={isSelected}
              onChange={(e) => {
                e.stopPropagation();
                onToggleSelection();
              }}
              onClick={(e) => e.stopPropagation()}
              className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 accent-claude-accent cursor-pointer"
            />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className={`flex items-center mb-1 ${showStatusIndicator ? 'gap-2' : 'gap-0'}`}>
            {/* Status indicator */}
            {showStatusIndicator && (
              <span
                className={`block w-2 h-2 rounded-full bg-claude-accent flex-shrink-0 ${
                  showRunningIndicator ? 'shadow-[0_0_6px_rgba(59,130,246,0.5)] animate-pulse' : ''
                }`}
                title={showRunningIndicator ? i18nService.t(statusLabels[session.status]) : undefined}
              />
            )}
            {isRenaming ? (
              <input
                ref={renameInputRef}
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    handleRenameSave(event);
                  }
                  if (event.key === 'Escape') {
                    handleRenameCancel(event);
                  }
                }}
                onBlur={handleRenameBlur}
                className="flex-1 min-w-0 rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg px-2 py-1 text-sm font-medium dark:text-claude-darkText text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent"
              />
            ) : (
              <h3 className="text-sm font-medium dark:text-claude-darkText text-claude-text truncate">
                {session.title}
              </h3>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
            <span className="whitespace-nowrap" title={relativeTime.full}>
              {relativeTime.compact}
            </span>
            <span className="text-[10px] uppercase tracking-wider whitespace-nowrap">
              {i18nService.t(statusLabels[session.status])}
            </span>
          </div>
        </div>
      </div>

      {/* Actions - absolutely positioned overlay */}
      {!isBatchMode && (
      <div
        className={`absolute right-1.5 top-1.5 transition-opacity ${
          isRenaming
            ? 'opacity-0 pointer-events-none'
            : session.pinned
              ? 'opacity-100'
              : 'opacity-0 group-hover:opacity-100'
        }`}
      >
        <button
          ref={actionButtonRef}
          onClick={openMenu}
          className="p-1.5 rounded-lg bg-claude-surfaceMuted dark:bg-claude-darkSurfaceMuted dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurface hover:bg-claude-surface transition-colors"
          aria-label={i18nService.t('coworkSessionActions')}
        >
          {session.pinned ? (
            <span className="relative block h-4 w-4">
              <PushPinIcon className="h-4 w-4 transition-opacity duration-150 group-hover:opacity-0" />
              <EllipsisHorizontalIcon className="absolute inset-0 h-4 w-4 opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
            </span>
          ) : (
            <EllipsisHorizontalIcon className="h-4 w-4" />
          )}
        </button>
      </div>
      )}

      {menuPosition && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[180px] rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-lg overflow-hidden"
          style={{ top: menuPosition.y, left: menuPosition.x }}
          role="menu"
        >
          {menuItems.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={item.onClick}
              onMouseEnter={item.key === 'folder' ? openSubMenu : scheduleCloseSubMenu}
              onMouseLeave={item.key === 'folder' ? scheduleCloseSubMenu : undefined}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                item.tone === 'danger'
                  ? 'text-red-500 hover:bg-red-500/10'
                  : 'dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
              }`}
            >
              {item.key === 'batch' && <ListChecksIcon className="h-4 w-4 flex-shrink-0" />}
              {item.key === 'rename' && <PencilSquareIcon className="h-4 w-4 flex-shrink-0" />}
              {item.key === 'pin' && <PushPinIcon slashed={session.pinned} className={`h-4 w-4 flex-shrink-0 ${session.pinned ? 'opacity-60' : ''}`} />}
              {item.key === 'folder' && <FolderIcon className="h-4 w-4 flex-shrink-0" />}
              {item.key === 'delete' && <TrashIcon className="h-4 w-4 flex-shrink-0" />}
              <span className="flex-1">{item.label}</span>
              {item.hasArrow && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3.5 w-3.5 flex-shrink-0 opacity-50">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Folder sub-menu */}
      {subMenuPos && (
        <div
          ref={subMenuRef}
          className="fixed z-50 min-w-[160px] rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-lg py-1"
          style={{ top: subMenuPos.y, left: subMenuPos.x }}
          onMouseEnter={cancelCloseSubMenu}
          onMouseLeave={scheduleCloseSubMenu}
        >
          {existingFolders.map((f) => (
            <button
              key={f}
              type="button"
              onClick={(e) => { e.stopPropagation(); handleFolderSelect(f); }}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover ${session.folder === f ? 'opacity-50 cursor-default pointer-events-none' : ''}`}
            >
              <FolderIcon className="h-4 w-4 flex-shrink-0 opacity-60" />
              <span className="flex-1 truncate">{f}</span>
              {session.folder === f && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="h-3.5 w-3.5 flex-shrink-0">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </button>
          ))}
          {session.folder && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); handleFolderSelect(''); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors text-red-500 hover:bg-red-500/10"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 flex-shrink-0">
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
                <line x1="9" y1="10" x2="15" y2="16" /><line x1="15" y1="10" x2="9" y2="16" />
              </svg>
              <span>{i18nService.t('removeFromFolder')}</span>
            </button>
          )}
          {(existingFolders.length > 0 || session.folder) && (
            <div className="my-1 border-t dark:border-claude-darkBorder border-claude-border" />
          )}
          <button
            type="button"
            onClick={handleNewFolderClick}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 flex-shrink-0">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
              <line x1="12" y1="11" x2="12" y2="17" /><line x1="9" y1="14" x2="15" y2="14" />
            </svg>
            <span>{i18nService.t('newFolderPlaceholder').replace('…', '')}</span>
          </button>
        </div>
      )}

      {/* New folder dialog */}
      {showNewFolderDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setShowNewFolderDialog(false)}
        >
          <div
            className="w-full max-w-xs mx-4 dark:bg-claude-darkSurface bg-claude-surface rounded-2xl shadow-xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 pt-5 pb-3">
              <h2 className="text-sm font-semibold dark:text-claude-darkText text-claude-text mb-3">
                {i18nService.t('newFolderPlaceholder').replace('…', '')}
              </h2>
              <input
                ref={newFolderInputRef}
                value={newFolderValue}
                onChange={(e) => setNewFolderValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleNewFolderConfirm();
                  if (e.key === 'Escape') setShowNewFolderDialog(false);
                }}
                placeholder={i18nService.t('newFolderPlaceholder')}
                className="w-full rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg px-3 py-2 text-sm dark:text-claude-darkText text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent"
              />
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t dark:border-claude-darkBorder border-claude-border">
              <button
                type="button"
                onClick={() => setShowNewFolderDialog(false)}
                className="px-3 py-1.5 text-sm font-medium rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                type="button"
                onClick={handleNewFolderConfirm}
                disabled={!newFolderValue.trim()}
                className="px-3 py-1.5 text-sm font-medium rounded-lg bg-claude-accent text-white hover:bg-claude-accent/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {i18nService.t('confirm') || '确定'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showConfirmDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={handleCancelDelete}
        >
          <div
            className="w-full max-w-sm mx-4 dark:bg-claude-darkSurface bg-claude-surface rounded-2xl shadow-xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 px-5 py-4">
              <div className="p-2 rounded-full bg-red-100 dark:bg-red-900/30">
                <ExclamationTriangleIcon className="h-5 w-5 text-red-600 dark:text-red-500" />
              </div>
              <h2 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
                {i18nService.t('deleteTaskConfirmTitle')}
              </h2>
            </div>

            <div className="px-5 pb-4">
              <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('deleteTaskConfirmMessage')}
              </p>
            </div>

            <div className="flex items-center justify-end gap-3 px-5 py-4 border-t dark:border-claude-darkBorder border-claude-border">
              <button
                onClick={handleCancelDelete}
                className="px-4 py-2 text-sm font-medium rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                onClick={handleConfirmDelete}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-red-500 hover:bg-red-600 text-white transition-colors"
              >
                {i18nService.t('deleteSession')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CoworkSessionItem;