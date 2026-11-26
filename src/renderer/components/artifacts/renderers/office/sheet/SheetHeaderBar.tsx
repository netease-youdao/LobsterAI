import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  ArrowUturnLeftIcon,
  ArrowUturnRightIcon,
  CheckIcon,
  EllipsisHorizontalIcon,
  FolderIcon,
  MagnifyingGlassIcon,
} from '@heroicons/react/24/outline';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { i18nService } from '@/services/i18n';
import type { SheetEditorSession } from '@/services/office/sheet/sheetEditorSession';
import { resolveSheetHeaderCompact } from '@/services/office/sheet/sheetToolbarLayout';
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
const MORE_MENU_WIDTH = 212;

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

export interface SheetHeaderBarProps {
  session: SheetEditorSession;
  isFormatBarOpen: boolean;
  onToggleFormatBar: () => void;
  isFormulaBarOpen: boolean;
  onToggleFormulaBar: () => void;
  formulaPreview?: string;
  disabled: boolean;
  readOnly: boolean;
  showSlowSaving: boolean;
  filePath: string;
  zoomControls: OfficePreviewZoomControlsConfig;
  documentActions?: OfficePreviewDocumentActions | null;
}

/**
 * Unified single-row Excel top bar (40px, aligned with WordHeaderBar and SlidesToolbar):
 * cells are directly editable by default, while the formatting bar and formula bar stay tucked
 * away until requested (with a subtle indicator on `fx` when the selected cell holds a formula).
 */
export function SheetHeaderBar({
  session,
  isFormatBarOpen,
  onToggleFormatBar,
  isFormulaBarOpen,
  onToggleFormulaBar,
  formulaPreview,
  disabled,
  readOnly,
  showSlowSaving,
  filePath,
  zoomControls,
  documentActions,
}: SheetHeaderBarProps): React.ReactElement {
  useSyncExternalStore(session.subscribe, session.getVersion);
  const headerRef = useRef<HTMLDivElement>(null);
  const [headerWidth, setHeaderWidth] = useState(0);
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

  const isCompactHeader = resolveSheetHeaderCompact(headerWidth);
  const showFormulaDot = !isFormulaBarOpen && Boolean(formulaPreview);
  const gridlinesVisible = session.gridlinesVisible();

  const fxTitle = isFormulaBarOpen
    ? t('sheetHideFormulaBar')
    : formulaPreview
      ? `${t('sheetShowFormulaBar')} (${formulaPreview})`
      : t('sheetShowFormulaBar');

  const flushThen = (action?: () => void) => {
    if (!action) return;
    if (readOnly) {
      action();
      return;
    }
    void session.document.flush().finally(() => action());
  };

  return (
    <div ref={headerRef} className="lobster-sheet-header" role="toolbar" aria-label={t('sheetEditor')}>
      {/* Left zone: Format toggle + Formula bar toggle + Find + Undo/Redo */}
      <div className="lobster-sheet-header-left">
        {!readOnly && (
          <button
            type="button"
            className={`lobster-sheet-mode-btn${isFormatBarOpen ? ' is-active' : ''}`}
            title={isFormatBarOpen ? t('sheetHideFormatBar') : t('sheetShowFormatBar')}
            aria-label={isFormatBarOpen ? t('sheetHideFormatBar') : t('sheetShowFormatBar')}
            aria-pressed={isFormatBarOpen}
            disabled={disabled}
            onMouseDown={keepFocus}
            onClick={onToggleFormatBar}
          >
            <span className="lobster-sheet-format-glyph" aria-hidden="true">Aa</span>
            <span>{t('sheetFormatBar')}</span>
          </button>
        )}

        <div className="lobster-sheet-utility-group">
          <button
            type="button"
            className={`lobster-sheet-icon-btn lobster-sheet-fx-btn${isFormulaBarOpen ? ' is-active' : ''}`}
            title={fxTitle}
            aria-label={fxTitle}
            aria-pressed={isFormulaBarOpen}
            disabled={disabled}
            onMouseDown={keepFocus}
            onClick={onToggleFormulaBar}
          >
            <span className="lobster-sheet-fx-glyph" aria-hidden="true">fx</span>
            {showFormulaDot && <span className="lobster-sheet-fx-dot" aria-hidden="true" />}
          </button>

          <button
            type="button"
            className="lobster-sheet-icon-btn"
            title={t('sheetFind')}
            aria-label={t('sheetFind')}
            disabled={disabled}
            onMouseDown={keepFocus}
            onClick={() => session.openFind()}
          >
            <MagnifyingGlassIcon className="h-4 w-4" aria-hidden="true" />
          </button>

          {!readOnly && !isCompactHeader && (
            <>
              <OfficeToolbarDivider />
              <button
                type="button"
                className="lobster-sheet-icon-btn"
                title={t('officeUndo')}
                aria-label={t('officeUndo')}
                disabled={disabled || !session.canUndo}
                onMouseDown={keepFocus}
                onClick={() => { void session.api?.undo(); }}
              >
                <ArrowUturnLeftIcon className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                className="lobster-sheet-icon-btn"
                title={t('officeRedo')}
                aria-label={t('officeRedo')}
                disabled={disabled || !session.canRedo}
                onMouseDown={keepFocus}
                onClick={() => { void session.api?.redo(); }}
              >
                <ArrowUturnRightIcon className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </>
          )}
        </div>

        {readOnly && (
          <span role="status" className="lobster-sheet-status-pill is-readonly">
            {t('officeReadOnlyStatus')}
          </span>
        )}
        {!readOnly && showSlowSaving && (
          <span role="status" aria-live="polite" className="lobster-sheet-status-pill">
            {t('officeSaving')}
          </span>
        )}
      </div>

      {/* Right zone: Share + Download + More + Workspace File List */}
      <div className="lobster-sheet-header-right">
        {documentActions?.canShare && (
          <button
            type="button"
            className="lobster-sheet-icon-btn"
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
            className="lobster-sheet-icon-btn"
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
          className={`lobster-sheet-icon-btn${morePopover.open ? ' is-active' : ''}`}
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
              {!readOnly && isCompactHeader && (
                <>
                  <button
                    type="button"
                    className="lobster-office-menu-item lobster-sheet-popover-item"
                    disabled={disabled || !session.canUndo}
                    onMouseDown={keepFocus}
                    onClick={() => {
                      morePopover.setOpen(false);
                      void session.api?.undo();
                    }}
                  >
                    <ArrowUturnLeftIcon className="h-3.5 w-3.5 shrink-0" />
                    <span>{t('officeUndo')}</span>
                  </button>
                  <button
                    type="button"
                    className="lobster-office-menu-item lobster-sheet-popover-item"
                    disabled={disabled || !session.canRedo}
                    onMouseDown={keepFocus}
                    onClick={() => {
                      morePopover.setOpen(false);
                      void session.api?.redo();
                    }}
                  >
                    <ArrowUturnRightIcon className="h-3.5 w-3.5 shrink-0" />
                    <span>{t('officeRedo')}</span>
                  </button>
                  <span className="lobster-sheet-menu-divider" role="separator" />
                </>
              )}

              {!readOnly && (
                <>
                  <button
                    type="button"
                    className={`lobster-office-menu-item lobster-sheet-popover-item${gridlinesVisible ? ' is-active' : ''}`}
                    disabled={disabled}
                    onMouseDown={keepFocus}
                    onClick={() => {
                      morePopover.setOpen(false);
                      session.toggleGridlines();
                    }}
                  >
                    <CheckIcon className={`h-3.5 w-3.5 shrink-0${gridlinesVisible ? '' : ' opacity-0'}`} aria-hidden="true" />
                    <span>{t('sheetShowGridlines')}</span>
                  </button>
                  <span className="lobster-sheet-menu-divider" role="separator" />
                </>
              )}

              {documentActions?.canRefresh && (
                <button
                  type="button"
                  className="lobster-office-menu-item lobster-sheet-popover-item"
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
                  className="lobster-office-menu-item lobster-sheet-popover-item"
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
                  className="lobster-office-menu-item lobster-sheet-popover-item"
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
              <span className="lobster-sheet-menu-divider" role="separator" />
              <div className="lobster-sheet-more-zoom">
                <span className="lobster-sheet-more-zoom-label">{t('artifactBrowserZoom')}</span>
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
            className={`lobster-sheet-icon-btn${documentActions.isFileListDrawerOpen ? ' is-active' : ''}`}
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
