import { commandForSlot } from '@docx-editor.dev/core/editor';
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  ArrowUturnLeftIcon,
  ArrowUturnRightIcon,
  Bars3BottomLeftIcon,
  EllipsisHorizontalIcon,
  FolderIcon,
  MagnifyingGlassIcon,
} from '@heroicons/react/24/outline';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { i18nService } from '@/services/i18n';
import type { WordEditorSession } from '@/services/office/word/wordEditorSession';
import { resolveWordHeaderCompact } from '@/services/office/word/wordToolbarLayout';
import { openLocalPathWithToast } from '@/utils/localFileActions';

import type {
  OfficePreviewDocumentActions,
  OfficePreviewZoomControlsConfig,
} from '../common/OfficePreviewActionsContext';
import { OfficeZoomControls } from '../common/OfficeZoomControls';
import { ToolbarPopoverPanel, useToolbarPopover } from '../common/toolbar/OfficePopover';
import { OfficeToolbarDivider } from '../common/toolbar/OfficeToolbar';

const t = (key: string) => i18nService.t(key);
const keepFocus = (event: React.MouseEvent) => event.preventDefault();

const OUTLINE_MENU_WIDTH = 236;
const MORE_MENU_WIDTH = 204;

const HistorySlot = {
  Undo: 'history.undo',
  Redo: 'history.redo',
} as const;
type HistorySlot = typeof HistorySlot[keyof typeof HistorySlot];

function ShareForwardIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.45} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8.75 2.75L14 7.75L8.75 12.75V10.15C5.6 10.15 3.4 11.05 2 13.25C2.1 8.4 4.7 5.35 8.75 5.35V2.75Z" />
    </svg>
  );
}

function DownloadTrayIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.45} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 11v1.5A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5V11" />
      <path d="M5 7.5L8 10.5L11 7.5" />
      <path d="M8 2v8.5" />
    </svg>
  );
}

export interface WordHeaderBarProps {
  session: WordEditorSession;
  isFormatBarOpen: boolean;
  onToggleFormatBar: () => void;
  readOnly: boolean;
  showSlowSaving: boolean;
  filePath: string;
  isFindOpen: boolean;
  onToggleFind: () => void;
  zoomControls: OfficePreviewZoomControlsConfig;
  documentActions?: OfficePreviewDocumentActions | null;
}

/**
 * Unified single-row Word top bar: the document is directly editable by default, while the
 * formatting bar toggles cleanly on demand alongside outline, find, undo/redo, and document actions.
 */
export function WordHeaderBar({
  session,
  isFormatBarOpen,
  onToggleFormatBar,
  readOnly,
  showSlowSaving,
  filePath,
  isFindOpen,
  onToggleFind,
  zoomControls,
  documentActions,
}: WordHeaderBarProps): React.ReactElement {
  useSyncExternalStore(session.subscribeEditor, session.getEditorSnapshot);
  const headerRef = useRef<HTMLDivElement>(null);
  const [headerWidth, setHeaderWidth] = useState(0);
  const outlinePopover = useToolbarPopover(OUTLINE_MENU_WIDTH);
  const morePopover = useToolbarPopover(MORE_MENU_WIDTH);

  useEffect(() => {
    const element = headerRef.current;
    if (!element) return undefined;
    setHeaderWidth(element.clientWidth);
    const observer = new ResizeObserver(entries => {
      const nextWidth = Math.round(entries[0]?.contentRect.width ?? element.clientWidth);
      setHeaderWidth(prev => (prev === nextWidth ? prev : nextWidth));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const editor = session.editor;
  const isCompactHeader = resolveWordHeaderCompact(headerWidth);
  const outline = outlinePopover.open ? (editor?.getOutline() ?? []) : [];

  const undoCommand = commandForSlot(HistorySlot.Undo);
  const redoCommand = commandForSlot(HistorySlot.Redo);
  const canUndo = Boolean(undoCommand && editor?.can(undoCommand).ok);
  const canRedo = Boolean(redoCommand && editor?.can(redoCommand).ok);

  const runHistory = (slot: HistorySlot) => {
    if (!editor) return;
    if (slot === HistorySlot.Undo) {
      if (session.undo()) {
        editor.focus();
        return;
      }
      if (undoCommand && editor.can(undoCommand).ok) {
        editor.exec(undoCommand);
        editor.focus();
      }
      return;
    }
    if (session.redo()) {
      editor.focus();
      return;
    }
    if (redoCommand && editor.can(redoCommand).ok) {
      editor.exec(redoCommand);
      editor.focus();
    }
  };

  const flushThen = (action?: () => void) => {
    if (!action) return;
    if (readOnly) {
      action();
      return;
    }
    void session.document.flush().finally(() => action());
  };

  const hasMoreMenuActions = Boolean(
    documentActions?.canRefresh
    || documentActions?.canRevealInFolder
    || filePath,
  );

  return (
    <div ref={headerRef} className="lobster-word-header" role="toolbar" aria-label={t('wordEditor')}>
      {/* Left zone: Format bar toggle + Outline + Find + Undo/Redo */}
      <div className="lobster-word-header-left">
        {!readOnly && (
          <button
            type="button"
            className={`lobster-word-mode-btn${isFormatBarOpen ? ' is-active' : ''}`}
            title={isFormatBarOpen ? t('wordHideFormatBar') : t('wordShowFormatBar')}
            aria-label={isFormatBarOpen ? t('wordHideFormatBar') : t('wordShowFormatBar')}
            aria-pressed={isFormatBarOpen}
            onMouseDown={keepFocus}
            onClick={onToggleFormatBar}
          >
            <span className="lobster-word-format-glyph" aria-hidden="true">Aa</span>
            <span>{t('wordFormatBar')}</span>
          </button>
        )}

        <div className="lobster-word-utility-group">
          <button
            ref={outlinePopover.trigger}
            type="button"
            className={`lobster-word-icon-btn${outlinePopover.open ? ' is-active' : ''}`}
            title={t('wordOutline')}
            aria-label={t('wordOutline')}
            aria-haspopup="menu"
            aria-expanded={outlinePopover.open}
            disabled={!editor}
            onMouseDown={keepFocus}
            onClick={() => outlinePopover.setOpen(open => !open)}
          >
            <Bars3BottomLeftIcon className="h-4 w-4" aria-hidden="true" />
          </button>
          <ToolbarPopoverPanel popover={outlinePopover} label={t('wordOutline')} width={OUTLINE_MENU_WIDTH}>
            {outlinePopover.open && (
              <div className="lobster-word-outline-list">
                <span className="lobster-word-menu-heading">{t('wordOutline')}</span>
                {outline.length === 0 ? (
                  <div className="lobster-word-outline-empty">{t('wordOutlineEmpty')}</div>
                ) : (
                  outline.map(item => (
                    <button
                      key={item.blockId}
                      type="button"
                      className="lobster-office-menu-item lobster-word-outline-item"
                      style={{ paddingLeft: `${8 + Math.max(0, Math.min(item.level - 1, 4)) * 12}px` }}
                      title={item.text}
                      onMouseDown={keepFocus}
                      onClick={() => {
                        outlinePopover.setOpen(false);
                        editor?.scrollToBlock(item.blockId);
                      }}
                    >
                      <span className="truncate">{item.text}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </ToolbarPopoverPanel>

          <button
            type="button"
            className={`lobster-word-icon-btn${isFindOpen ? ' is-active' : ''}`}
            title={t('wordFind')}
            aria-label={t('wordFind')}
            aria-pressed={isFindOpen}
            disabled={!editor}
            onMouseDown={keepFocus}
            onClick={onToggleFind}
          >
            <MagnifyingGlassIcon className="h-4 w-4" aria-hidden="true" />
          </button>

          {!readOnly && !isCompactHeader && (
            <>
              <OfficeToolbarDivider />
              <button
                type="button"
                className="lobster-word-icon-btn"
                title={t('officeUndo')}
                aria-label={t('officeUndo')}
                disabled={!canUndo}
                onMouseDown={keepFocus}
                onClick={() => runHistory(HistorySlot.Undo)}
              >
                <ArrowUturnLeftIcon className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                className="lobster-word-icon-btn"
                title={t('officeRedo')}
                aria-label={t('officeRedo')}
                disabled={!canRedo}
                onMouseDown={keepFocus}
                onClick={() => runHistory(HistorySlot.Redo)}
              >
                <ArrowUturnRightIcon className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </>
          )}
        </div>

        {readOnly && (
          <span role="status" className="lobster-word-status-pill is-readonly">
            {t('officeReadOnlyStatus')}
          </span>
        )}
        {!readOnly && showSlowSaving && (
          <span role="status" aria-live="polite" className="lobster-word-status-pill">
            {t('officeSaving')}
          </span>
        )}
      </div>

      {/* Right zone: Share + Download + More + File Drawer toggle */}
      <div className="lobster-word-header-right">
        {documentActions?.canShare && (
          <button
            type="button"
            className="lobster-word-icon-btn"
            title={t('htmlShare')}
            aria-label={t('htmlShare')}
            onMouseDown={keepFocus}
            onClick={() => flushThen(documentActions.onShare)}
          >
            <ShareForwardIcon />
          </button>
        )}

        {documentActions?.canDownload && (
          <button
            type="button"
            className="lobster-word-icon-btn"
            title={t('artifactDownload')}
            aria-label={t('artifactDownload')}
            onMouseDown={keepFocus}
            onClick={() => flushThen(documentActions.onDownload)}
          >
            <DownloadTrayIcon />
          </button>
        )}

        <button
          ref={morePopover.trigger}
          type="button"
          className={`lobster-word-icon-btn${morePopover.open ? ' is-active' : ''}`}
          title={t('artifactActionsMenu')}
          aria-label={t('artifactActionsMenu')}
          aria-haspopup="menu"
          aria-expanded={morePopover.open}
          onMouseDown={keepFocus}
          onClick={() => morePopover.setOpen(open => !open)}
        >
          <EllipsisHorizontalIcon className="h-4 w-4" aria-hidden="true" />
        </button>
        <ToolbarPopoverPanel popover={morePopover} label={t('artifactActionsMenu')} width={MORE_MENU_WIDTH}>
          {morePopover.open && (
            <>
              {documentActions?.canRefresh && (
                <button
                  type="button"
                  className="lobster-office-menu-item lobster-word-popover-item"
                  onMouseDown={keepFocus}
                  onClick={() => {
                    morePopover.setOpen(false);
                    documentActions.onRefresh();
                  }}
                >
                  <ArrowPathIcon className="h-3.5 w-3.5 shrink-0" />
                  <span>{t('artifactRefresh')}</span>
                </button>
              )}
              {documentActions?.canRevealInFolder && (
                <button
                  type="button"
                  className="lobster-office-menu-item lobster-word-popover-item"
                  onMouseDown={keepFocus}
                  onClick={() => {
                    morePopover.setOpen(false);
                    documentActions.onRevealInFolder();
                  }}
                >
                  <FolderIcon className="h-3.5 w-3.5 shrink-0" />
                  <span>{t('artifactViewDirectory')}</span>
                </button>
              )}
              {filePath && (
                <button
                  type="button"
                  className="lobster-office-menu-item lobster-word-popover-item"
                  onMouseDown={keepFocus}
                  onClick={() => {
                    morePopover.setOpen(false);
                    flushThen(() => { void openLocalPathWithToast(filePath); });
                  }}
                >
                  <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5 shrink-0" />
                  <span>{t('officeOpenExternal')}</span>
                </button>
              )}
              {hasMoreMenuActions && <span className="lobster-word-menu-divider" role="separator" />}
              <div className="lobster-word-more-zoom">
                <span className="lobster-word-more-zoom-label">{t('artifactBrowserZoom')}</span>
                <OfficeZoomControls
                  zoomFactor={zoomControls.zoomFactor}
                  displayZoomFactor={zoomControls.displayZoomFactor}
                  onZoomOut={zoomControls.onZoomOut}
                  onZoomIn={zoomControls.onZoomIn}
                  onResetZoom={zoomControls.onResetZoom}
                />
              </div>
            </>
          )}
        </ToolbarPopoverPanel>

        {documentActions?.canOpenFileList && documentActions.onOpenFileList && (
          <button
            ref={documentActions.fileListButtonRef}
            type="button"
            data-artifact-file-drawer-toggle="true"
            className={`lobster-word-icon-btn${documentActions.isFileListDrawerOpen ? ' is-active' : ''}`}
            title={documentActions.isFileListDrawerOpen ? t('artifactCloseFileList') : t('artifactFileList')}
            aria-label={documentActions.isFileListDrawerOpen ? t('artifactCloseFileList') : t('artifactFileList')}
            aria-pressed={Boolean(documentActions.isFileListDrawerOpen)}
            onMouseDown={keepFocus}
            onClick={() => documentActions.onOpenFileList?.()}
          >
            <FolderIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
