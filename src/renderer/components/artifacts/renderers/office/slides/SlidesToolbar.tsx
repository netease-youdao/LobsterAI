import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  ArrowUturnLeftIcon,
  ArrowUturnRightIcon,
  ChatBubbleBottomCenterTextIcon,
  CheckIcon,
  EllipsisHorizontalIcon,
  FolderIcon,
  PlayIcon,
  Squares2X2Icon,
} from '@heroicons/react/24/outline';
import React, { useSyncExternalStore } from 'react';

import { i18nService } from '@/services/i18n';
import { type SlidesEditorSession, SlidesZoomMode } from '@/services/office/slides/slidesEditorSession';
import {
  resolveSlidesToolbarDensity,
  SLIDES_ZOOM_LIMITS,
  SLIDES_ZOOM_PRESETS,
  SlidesThumbLayout,
  SlidesToolbarDensity,
} from '@/services/office/slides/slidesLayout';
import { openLocalPathWithToast } from '@/utils/localFileActions';

import type { OfficePreviewDocumentActions } from '../common/OfficePreviewActionsContext';
import { OfficeZoom } from '../common/OfficeZoomControls';
import { ToolbarPopoverPanel, useToolbarPopover } from '../common/toolbar/OfficePopover';
import { OfficeToolbar, OfficeToolbarButton, OfficeToolbarDivider } from '../common/toolbar/OfficeToolbar';

const t = (key: string) => i18nService.t(key);
const keepFocus = (event: React.MouseEvent) => event.preventDefault();

const ZOOM_MENU_WIDTH = 168;
const PRESENT_MENU_WIDTH = 164;
const MORE_MENU_WIDTH = 196;

/** PowerPoint text-box icon: clean T inside a dashed frame. */
function TextBoxIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.3} aria-hidden="true">
      <rect x="1.75" y="2.5" width="12.5" height="11" rx="1.5" strokeDasharray="2 1.5" />
      <path d="M5.25 5.5h5.5M8 5.5v5.5" strokeLinecap="round" />
    </svg>
  );
}

/** Add slide icon: a landscape slide with a crisp plus badge. */
function AddSlideIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.3} aria-hidden="true">
      <rect x="1.75" y="3" width="12.5" height="10" rx="1.5" />
      <path d="M8 6v4M6 8h4" strokeLinecap="round" />
    </svg>
  );
}

/** Sidebar dock icon for toggling the wide-mode thumbnail rail. */
function SidebarToggleIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.35} aria-hidden="true">
      <rect x="2" y="2.75" width="12" height="10.5" rx="1.75" />
      <path d="M5.75 2.75v10.5" strokeLinecap="round" />
    </svg>
  );
}

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

export interface SlidesToolbarProps {
  session: SlidesEditorSession;
  disabled: boolean;
  readOnly: boolean;
  showSlowSaving: boolean;
  filePath: string;
  documentActions?: OfficePreviewDocumentActions | null;
  onPresent: (startIndex: number) => void;
}

/**
 * Unified single-row PPT header toolbar combining lightweight slide creation tools,
 * visible zoom controls, fullscreen Present mode, and host document actions (share/download/more).
 */
export function SlidesToolbar({
  session,
  disabled,
  readOnly,
  showSlowSaving,
  filePath,
  documentActions,
  onPresent,
}: SlidesToolbarProps): React.ReactElement {
  useSyncExternalStore(session.subscribe, session.getVersion);
  const zoomPopover = useToolbarPopover(ZOOM_MENU_WIDTH);
  const presentPopover = useToolbarPopover(PRESENT_MENU_WIDTH);
  const morePopover = useToolbarPopover(MORE_MENU_WIDTH);

  const editable = !disabled && !readOnly && session.editable;
  const hasSlides = session.slideCount > 0;
  const hasSlide = editable && session.currentIndex >= 0;
  const density = resolveSlidesToolbarDensity(session.width);
  const isFull = density === SlidesToolbarDensity.Full;
  const isMinimal = density === SlidesToolbarDensity.Minimal;
  const isLeftLayout = session.thumbLayout === SlidesThumbLayout.Left;
  const zoomPercent = Math.round(session.zoom * 100);
  const isFitZoom = session.zoomMode === SlidesZoomMode.Fit;

  const flushThen = (action?: () => void) => {
    if (!action) return;
    if (readOnly) {
      action();
      return;
    }
    void session.document.flush().finally(() => action());
  };

  const thumbToggleLabel = isLeftLayout
    ? (session.thumbnailsShown ? t('slidesUnpinThumbnails') : t('slidesPinThumbnails'))
    : (session.thumbnailsShown ? t('slidesHideThumbnails') : t('slidesShowThumbnails'));

  return (
    <OfficeToolbar label="slidesToolbar">
      <div className="lobster-slides-toolbar-inner">
        {/* Left zone: slide creation tools + exceptional status */}
        <div className="lobster-slides-toolbar-left">
          {isLeftLayout && !session.thumbnailsShown && (
            <button
              type="button"
              className="lobster-slides-icon-btn"
              title={t('slidesPinThumbnails')}
              aria-label={t('slidesPinThumbnails')}
              onMouseDown={keepFocus}
              onClick={() => session.toggleSlideList()}
            >
              <SidebarToggleIcon />
            </button>
          )}

          {!readOnly && (
            <div className="lobster-slides-tool-pill">
              {isFull && (
                <>
                  <OfficeToolbarButton label="officeUndo" disabled={!editable || !session.canUndo} onClick={() => session.undo()}>
                    <ArrowUturnLeftIcon className="h-3.5 w-3.5" />
                  </OfficeToolbarButton>
                  <OfficeToolbarButton label="officeRedo" disabled={!editable || !session.canRedo} onClick={() => session.redo()}>
                    <ArrowUturnRightIcon className="h-3.5 w-3.5" />
                  </OfficeToolbarButton>
                  <OfficeToolbarDivider />
                </>
              )}
              <OfficeToolbarButton label="slidesInsertTextBox" disabled={!hasSlide} onClick={() => session.insertTextBox()}>
                <TextBoxIcon />
              </OfficeToolbarButton>
              <OfficeToolbarButton label="slidesNewSlide" disabled={!editable} onClick={() => session.addSlide()}>
                <AddSlideIcon />
              </OfficeToolbarButton>
            </div>
          )}

          {readOnly && (
            <span role="status" className="lobster-slides-status-pill is-readonly">
              {t('officeReadOnlyStatus')}
            </span>
          )}
          {!readOnly && showSlowSaving && (
            <span role="status" aria-live="polite" className="lobster-slides-status-pill">
              {t('officeSaving')}
            </span>
          )}
        </div>

        {/* Right zone: Zoom + Present + Share/Download + More */}
        <div className="lobster-slides-toolbar-right">
          {/* Zoom dropdown */}
          <button
            ref={zoomPopover.trigger}
            type="button"
            className="lobster-slides-dropdown-btn"
            title={t('artifactBrowserZoom')}
            aria-label={t('artifactBrowserZoom')}
            aria-haspopup="menu"
            aria-expanded={zoomPopover.open}
            disabled={!hasSlides}
            onMouseDown={keepFocus}
            onClick={() => zoomPopover.setOpen(open => !open)}
          >
            <span className="lobster-slides-dropdown-label">
              {isFitZoom && !isMinimal ? t('slidesZoomFit') : `${zoomPercent}%`}
            </span>
            <span className="lobster-slides-caret" aria-hidden="true">▾</span>
          </button>
          <ToolbarPopoverPanel popover={zoomPopover} label={t('artifactBrowserZoom')} width={ZOOM_MENU_WIDTH}>
            {zoomPopover.open && (
              <>
                <div className="lobster-slides-zoom-stepper">
                  <button
                    type="button"
                    className="lobster-slides-zoom-step-btn"
                    title={t('artifactBrowserZoomOut')}
                    aria-label={t('artifactBrowserZoomOut')}
                    disabled={session.zoom <= SLIDES_ZOOM_LIMITS.min}
                    onMouseDown={keepFocus}
                    onClick={() => session.setZoom(session.zoom - OfficeZoom.Step)}
                  >
                    −
                  </button>
                  <span className="lobster-slides-zoom-readout">{zoomPercent}%</span>
                  <button
                    type="button"
                    className="lobster-slides-zoom-step-btn"
                    title={t('artifactBrowserZoomIn')}
                    aria-label={t('artifactBrowserZoomIn')}
                    disabled={session.zoom >= SLIDES_ZOOM_LIMITS.max}
                    onMouseDown={keepFocus}
                    onClick={() => session.setZoom(session.zoom + OfficeZoom.Step)}
                  >
                    +
                  </button>
                </div>
                <span className="lobster-slides-menu-divider" role="separator" />
                <button
                  type="button"
                  className={`lobster-office-menu-item lobster-slides-popover-item${isFitZoom ? ' is-active' : ''}`}
                  onMouseDown={keepFocus}
                  onClick={() => {
                    zoomPopover.setOpen(false);
                    session.fitToWindow();
                  }}
                >
                  <CheckIcon className={`h-3.5 w-3.5 shrink-0${isFitZoom ? '' : ' opacity-0'}`} aria-hidden="true" />
                  <span>{t('slidesZoomFit')}</span>
                </button>
                {SLIDES_ZOOM_PRESETS.map(preset => {
                  const active = !isFitZoom && Math.abs(session.zoom - preset) < 0.005;
                  return (
                    <button
                      key={preset}
                      type="button"
                      className={`lobster-office-menu-item lobster-slides-popover-item${active ? ' is-active' : ''}`}
                      onMouseDown={keepFocus}
                      onClick={() => {
                        zoomPopover.setOpen(false);
                        session.setZoom(preset);
                      }}
                    >
                      <CheckIcon className={`h-3.5 w-3.5 shrink-0${active ? '' : ' opacity-0'}`} aria-hidden="true" />
                      <span>{Math.round(preset * 100)}%</span>
                    </button>
                  );
                })}
              </>
            )}
          </ToolbarPopoverPanel>

          {/* Present split button */}
          <div className="lobster-slides-present-group">
            <button
              type="button"
              className="lobster-slides-present-main"
              title={t('slidesPresent')}
              aria-label={t('slidesPresent')}
              disabled={!hasSlides}
              onMouseDown={keepFocus}
              onClick={() => onPresent(Math.max(0, session.currentIndex))}
            >
              <PlayIcon className="h-3.5 w-3.5 shrink-0" />
              {!isMinimal && <span>{t('slidesPresent')}</span>}
            </button>
            <button
              ref={presentPopover.trigger}
              type="button"
              className="lobster-slides-present-arrow"
              title={t('slidesPresentMenu')}
              aria-label={t('slidesPresentMenu')}
              aria-haspopup="menu"
              aria-expanded={presentPopover.open}
              disabled={!hasSlides}
              onMouseDown={keepFocus}
              onClick={() => presentPopover.setOpen(open => !open)}
            >
              <span aria-hidden="true">▾</span>
            </button>
          </div>
          <ToolbarPopoverPanel popover={presentPopover} label={t('slidesPresentMenu')} width={PRESENT_MENU_WIDTH}>
            {presentPopover.open && (
              <>
                <button
                  type="button"
                  className="lobster-office-menu-item lobster-slides-popover-item"
                  onMouseDown={keepFocus}
                  onClick={() => {
                    presentPopover.setOpen(false);
                    onPresent(Math.max(0, session.currentIndex));
                  }}
                >
                  <PlayIcon className="h-3.5 w-3.5 shrink-0" />
                  <span>{t('slidesPresentFromCurrent')}</span>
                </button>
                <button
                  type="button"
                  className="lobster-office-menu-item lobster-slides-popover-item"
                  onMouseDown={keepFocus}
                  onClick={() => {
                    presentPopover.setOpen(false);
                    onPresent(0);
                  }}
                >
                  <PlayIcon className="h-3.5 w-3.5 shrink-0" />
                  <span>{t('slidesPresentFromStart')}</span>
                </button>
              </>
            )}
          </ToolbarPopoverPanel>

          {documentActions?.canShare && (
            <button
              type="button"
              className="lobster-slides-icon-btn"
              title={t('htmlShare')}
              aria-label={t('htmlShare')}
              onMouseDown={keepFocus}
              onClick={() => flushThen(documentActions.onShare)}
            >
              <ShareForwardIcon />
            </button>
          )}

          {documentActions?.canDownload && !isMinimal && (
            <button
              type="button"
              className="lobster-slides-icon-btn"
              title={t('artifactDownload')}
              aria-label={t('artifactDownload')}
              onMouseDown={keepFocus}
              onClick={() => flushThen(documentActions.onDownload)}
            >
              <DownloadTrayIcon />
            </button>
          )}

          {/* More menu */}
          <button
            ref={morePopover.trigger}
            type="button"
            className="lobster-slides-icon-btn"
            title={t('artifactActionsMenu')}
            aria-label={t('artifactActionsMenu')}
            aria-haspopup="menu"
            aria-expanded={morePopover.open}
            onMouseDown={keepFocus}
            onClick={() => morePopover.setOpen(open => !open)}
          >
            <EllipsisHorizontalIcon className="h-4 w-4" />
          </button>
          <ToolbarPopoverPanel popover={morePopover} label={t('artifactActionsMenu')} width={MORE_MENU_WIDTH}>
            {morePopover.open && (
              <>
                {!isFull && !readOnly && (
                  <>
                    <button
                      type="button"
                      className="lobster-office-menu-item lobster-slides-popover-item"
                      disabled={!editable || !session.canUndo}
                      onMouseDown={keepFocus}
                      onClick={() => {
                        morePopover.setOpen(false);
                        session.undo();
                      }}
                    >
                      <ArrowUturnLeftIcon className="h-3.5 w-3.5 shrink-0" />
                      <span>{t('officeUndo')}</span>
                    </button>
                    <button
                      type="button"
                      className="lobster-office-menu-item lobster-slides-popover-item"
                      disabled={!editable || !session.canRedo}
                      onMouseDown={keepFocus}
                      onClick={() => {
                        morePopover.setOpen(false);
                        session.redo();
                      }}
                    >
                      <ArrowUturnRightIcon className="h-3.5 w-3.5 shrink-0" />
                      <span>{t('officeRedo')}</span>
                    </button>
                    <span className="lobster-slides-menu-divider" role="separator" />
                  </>
                )}

                <button
                  type="button"
                  className="lobster-office-menu-item lobster-slides-popover-item"
                  onMouseDown={keepFocus}
                  onClick={() => {
                    morePopover.setOpen(false);
                    session.toggleSlideList();
                  }}
                >
                  <Squares2X2Icon className="h-3.5 w-3.5 shrink-0" />
                  <span>{thumbToggleLabel}</span>
                </button>
                <button
                  type="button"
                  className="lobster-office-menu-item lobster-slides-popover-item"
                  onMouseDown={keepFocus}
                  onClick={() => {
                    morePopover.setOpen(false);
                    session.toggleNotes(!session.notesOpen);
                  }}
                >
                  <ChatBubbleBottomCenterTextIcon className="h-3.5 w-3.5 shrink-0" />
                  <span>{session.notesOpen ? t('slidesHideNotes') : t('slidesShowNotes')}</span>
                </button>

                <span className="lobster-slides-menu-divider" role="separator" />

                {documentActions?.canDownload && isMinimal && (
                  <button
                    type="button"
                    className="lobster-office-menu-item lobster-slides-popover-item"
                    onMouseDown={keepFocus}
                    onClick={() => {
                      morePopover.setOpen(false);
                      flushThen(documentActions.onDownload);
                    }}
                  >
                    <DownloadTrayIcon />
                    <span>{t('artifactDownload')}</span>
                  </button>
                )}
                {documentActions?.canRefresh && (
                  <button
                    type="button"
                    className="lobster-office-menu-item lobster-slides-popover-item"
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
                    className="lobster-office-menu-item lobster-slides-popover-item"
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
                <button
                  type="button"
                  className="lobster-office-menu-item lobster-slides-popover-item"
                  onMouseDown={keepFocus}
                  onClick={() => {
                    morePopover.setOpen(false);
                    flushThen(() => { void openLocalPathWithToast(filePath); });
                  }}
                >
                  <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5 shrink-0" />
                  <span>{t('officeOpenExternal')}</span>
                </button>
              </>
            )}
          </ToolbarPopoverPanel>

          {documentActions?.canOpenFileList && documentActions.onOpenFileList && (
            <button
              ref={documentActions.fileListButtonRef}
              type="button"
              data-artifact-file-drawer-toggle="true"
              className={`lobster-slides-icon-btn${documentActions.isFileListDrawerOpen ? ' is-active' : ''}`}
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
    </OfficeToolbar>
  );
}
