import './slidesEditor.css';

import {
  ChatBubbleBottomCenterTextIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  DocumentDuplicateIcon,
  PlusIcon,
  Squares2X2Icon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';
import { OfficeSaveState } from '@/services/office/core/officeDocument';
import { SlidesRefusal } from '@/services/office/slides/slidesDeck';
import { acquireSlidesEditor, type SlidesChatReference, type SlidesEditorSession } from '@/services/office/slides/slidesEditorSession';
import { SlidesThumbLayout } from '@/services/office/slides/slidesLayout';

import { SlidesReadOnlyReason } from '../../../../../../shared/office/slides/slidesFile';
import { useEditorSelectionChat } from '../../../artifactSelectedText';
import {
  type OfficeEditorLabels, OfficeEditorLoader, OfficeEditorShell, useOfficeDocumentState, useOfficeEditorMount,
} from '../common/OfficeEditorShell';
import {
  useOfficePreviewActions,
  useRegisterOfficeOwnsDocumentToolbar,
  useRegisterOfficePreviewZoomControls,
} from '../common/OfficePreviewActionsContext';
import { OfficeZoom } from '../common/OfficeZoomControls';
import { SlidesFormatBar } from './SlidesFormatBar';
import { SlidesPresentationModal } from './SlidesPresentationModal';
import { SlidesToolbar } from './SlidesToolbar';

const t = (key: string) => i18nService.t(key);
const keepFocus = (event: React.MouseEvent) => event.preventDefault();
const SLIDES_LABELS: OfficeEditorLabels<SlidesReadOnlyReason> = {
  editor: 'slidesEditor',
  loading: 'slidesLoading',
  tooLarge: 'slidesTooLarge',
  unsupported: 'slidesUnsupported',
  accessFailed: 'slidesAccessFailed',
  inUse: 'slidesInUse',
  readOnly: 'slidesReadOnly',
  readOnlyReasons: {
    [SlidesReadOnlyReason.Protection]: 'slidesReadOnlyProtection',
    [SlidesReadOnlyReason.Signature]: 'slidesReadOnlySignature',
    [SlidesReadOnlyReason.Macros]: 'slidesReadOnlyMacros',
  },
};
const REFUSAL_LABEL: Record<SlidesRefusal, string> = {
  [SlidesRefusal.Invalid]: 'slidesRefused',
  [SlidesRefusal.Animated]: 'slidesRefusedAnimated',
  [SlidesRefusal.CopyUnsupported]: 'slidesRefusedCopy',
  [SlidesRefusal.NoNotesMaster]: 'slidesRefusedNotes',
};
/** How long the notice stays after an edit was refused. */
const REFUSAL_NOTICE_MS = 6000;
const SLOW_SAVE_NOTICE_MS = 800;
const SLIDE_MENU_WIDTH = 172;
const SLIDE_MENU_ESTIMATED_HEIGHT = 112;

type AddToChat = (reference: SlidesChatReference) => void;

interface SlideContextMenuState {
  index: number;
  left: number;
  top: number;
}

function ActiveSlidesEditor({
  session,
  filePath,
  onAddToChat,
}: {
  session: SlidesEditorSession;
  filePath: string;
  onAddToChat?: AddToChat;
}): React.ReactElement {
  const { document } = session;
  const state = useOfficeDocumentState(document);
  useSyncExternalStore(session.subscribe, session.getVersion);

  // Claim the host ArtifactDocumentToolbar so PPT renders one unified top bar.
  useRegisterOfficeOwnsDocumentToolbar(true);
  const previewActions = useOfficePreviewActions();

  const host = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const slideMenuRef = useRef<HTMLDivElement>(null);
  useOfficeEditorMount(session, host);

  // "Add to chat" beside a selected shape reaches the task chat; the latest callback is used.
  const addToChat = useRef(onAddToChat);
  addToChat.current = onAddToChat;
  const chatAvailable = Boolean(onAddToChat);
  useEffect(() => {
    session.setChatHandler(chatAvailable ? reference => addToChat.current?.(reference) : undefined);
    return () => session.setChatHandler(undefined);
  }, [session, chatAvailable]);

  // Text selected while typing goes to the chat too, as in the other editors.
  const chat = useEditorSelectionChat({
    frame, content: host, selectedText: () => window.getSelection()?.toString(),
    onAdd: onAddToChat ? text => {
      const reference = session.chatReference();
      if (reference) onAddToChat({ ...reference, text });
    } : undefined,
  });

  const [now, setNow] = useState(() => Date.now());
  const [showSlowSaving, setShowSlowSaving] = useState(false);
  const [presentingStartIndex, setPresentingStartIndex] = useState<number | null>(null);
  const [slideMenu, setSlideMenu] = useState<SlideContextMenuState | null>(null);

  const readOnly = state.readOnlyReasons.length > 0;
  useEffect(() => {
    if (readOnly || state.status !== OfficeSaveState.Saving) {
      setShowSlowSaving(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setShowSlowSaving(true), SLOW_SAVE_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [readOnly, state.status]);

  const refusedAt = session.lastRefusal;
  useEffect(() => {
    if (!refusedAt) return undefined;
    setNow(Date.now());
    const timer = setTimeout(() => setNow(Date.now()), REFUSAL_NOTICE_MS + 50);
    return () => clearTimeout(timer);
  }, [refusedAt]);

  // Per-slide hover / right-click context menu on thumbnails.
  useEffect(() => {
    session.setSlideMenuHandler((slideIndex, anchor) => {
      const left = Math.max(8, Math.min(anchor.x - SLIDE_MENU_WIDTH + 24, window.innerWidth - SLIDE_MENU_WIDTH - 8));
      const fitsBelow = anchor.y + SLIDE_MENU_ESTIMATED_HEIGHT + 8 <= window.innerHeight;
      const top = fitsBelow
        ? Math.max(8, anchor.y)
        : Math.max(8, anchor.y - SLIDE_MENU_ESTIMATED_HEIGHT - 12);
      setSlideMenu({ index: slideIndex, left, top });
    });
    return () => {
      session.setSlideMenuHandler(undefined);
      session.setSlideMenuOpen(false);
    };
  }, [session]);

  useEffect(() => {
    session.setSlideMenuOpen(Boolean(slideMenu));
    if (!slideMenu) return undefined;
    const onOutside = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && slideMenuRef.current?.contains(target)) return;
      setSlideMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setSlideMenu(null);
    };
    window.document.addEventListener('mousedown', onOutside, true);
    window.document.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.document.removeEventListener('mousedown', onOutside, true);
      window.document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [session, slideMenu]);

  const zoom = session.zoom;
  const zoomControls = useMemo(() => ({
    zoomFactor: zoom,
    onZoomOut: () => session.setZoom(zoom - OfficeZoom.Step),
    onZoomIn: () => session.setZoom(zoom + OfficeZoom.Step),
    onResetZoom: () => session.fitToWindow(),
  }), [session, zoom]);
  useRegisterOfficePreviewZoomControls(zoomControls);

  const handleStartPresentation = useCallback((startIndex: number) => {
    if (session.slideCount <= 0) return;
    session.prepareForPresentation();
    setSlideMenu(null);
    setPresentingStartIndex(Math.max(0, Math.min(session.slideCount - 1, startIndex)));
  }, [session]);

  const handleExitPresentation = useCallback((lastIndex: number) => {
    setPresentingStartIndex(null);
    if (lastIndex >= 0 && lastIndex < session.slideCount) {
      session.selectSlide(lastIndex);
    }
  }, [session]);

  const index = session.currentIndex;
  const slideCount = session.slideCount;
  const isBottomLayout = session.thumbLayout === SlidesThumbLayout.Bottom;
  const canNavigate = !session.editingText && slideCount > 1 && index >= 0;
  const toolbarDisabled = state.needsResolution || !state.ready;

  return (
    <OfficeEditorShell
      document={document}
      state={state}
      labels={SLIDES_LABELS}
      className="lobster-slides-editor"
      keepToolbarWhenReadOnly
      hideFooter
      notices={!readOnly && refusedAt > 0 && now - refusedAt < REFUSAL_NOTICE_MS && (
        <div className="lobster-office-notice" role="status">
          <p>{t(REFUSAL_LABEL[session.lastRefusalCode] ?? 'slidesRefused')}</p>
        </div>
      )}
      toolbar={(
        <SlidesToolbar
          session={session}
          disabled={toolbarDisabled}
          readOnly={readOnly}
          showSlowSaving={showSlowSaving}
          filePath={filePath}
          documentActions={previewActions?.documentActions}
          onPresent={handleStartPresentation}
        />
      )}
    >
      <div className="lobster-slides-frame" ref={frame} onPointerUp={chat.handlePointerUp}>
        <div className="lobster-slides-mount" ref={host} />
        {chat.button}

        {/* Stage overlay: floating contextual format pill + hover prev/next arrows */}
        {createPortal(
          <>
            <SlidesFormatBar session={session} disabled={toolbarDisabled || readOnly} />
            {canNavigate && index > 0 && (
              <button
                type="button"
                className="lobster-slides-stage-arrow lobster-slides-stage-arrow-prev"
                title={t('slidesPrevious')}
                aria-label={t('slidesPrevious')}
                onMouseDown={keepFocus}
                onPointerUp={event => event.stopPropagation()}
                onClick={() => session.selectSlide(index - 1)}
              >
                <ChevronLeftIcon className="h-4 w-4" />
              </button>
            )}
            {canNavigate && index < slideCount - 1 && (
              <button
                type="button"
                className="lobster-slides-stage-arrow lobster-slides-stage-arrow-next"
                title={t('slidesNext')}
                aria-label={t('slidesNext')}
                onMouseDown={keepFocus}
                onPointerUp={event => event.stopPropagation()}
                onClick={() => session.selectSlide(index + 1)}
              >
                <ChevronRightIcon className="h-4 w-4" />
              </button>
            )}
          </>,
          session.stageOverlaySlot,
        )}

        {/* Compact controls strip positioned between stage/notes and the bottom thumbnail filmstrip */}
        {createPortal(
          <div className="lobster-slides-controls-bar" onPointerUp={event => event.stopPropagation()}>
            <div className="lobster-slides-controls-start">
              {index >= 0 && (
                <div className="lobster-slides-nav">
                  <button
                    type="button"
                    className="lobster-slides-bar-icon-btn"
                    title={t('slidesPrevious')}
                    aria-label={t('slidesPrevious')}
                    disabled={index === 0}
                    onMouseDown={keepFocus}
                    onClick={() => session.selectSlide(index - 1)}
                  >
                    <ChevronLeftIcon className="h-3.5 w-3.5" />
                  </button>
                  <span className="lobster-slides-nav-position">
                    {index + 1} / {slideCount}
                  </span>
                  <button
                    type="button"
                    className="lobster-slides-bar-icon-btn"
                    title={t('slidesNext')}
                    aria-label={t('slidesNext')}
                    disabled={index >= slideCount - 1}
                    onMouseDown={keepFocus}
                    onClick={() => session.selectSlide(index + 1)}
                  >
                    <ChevronRightIcon className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>

            <div className="lobster-slides-controls-end">
              <button
                type="button"
                className={`lobster-slides-notes-toggle${session.notesOpen ? ' is-open' : ''}${session.notesPreview ? ' has-notes' : ''}`}
                title={session.notesOpen ? t('slidesHideNotes') : t('slidesShowNotes')}
                aria-label={session.notesOpen ? t('slidesHideNotes') : t('slidesShowNotes')}
                aria-expanded={session.notesOpen}
                onMouseDown={keepFocus}
                onClick={() => session.toggleNotes(!session.notesOpen)}
              >
                <ChatBubbleBottomCenterTextIcon className="h-3.5 w-3.5 shrink-0" />
                <span className="lobster-slides-notes-toggle-text">
                  {session.notesPreview && !session.notesOpen ? session.notesPreview : t('slidesNotesShort')}
                </span>
                {session.notesOpen
                  ? <ChevronDownIcon className="h-3 w-3 shrink-0 opacity-70" />
                  : <ChevronUpIcon className="h-3 w-3 shrink-0 opacity-70" />}
              </button>

              {isBottomLayout && (
                <button
                  type="button"
                  className={`lobster-slides-bar-icon-btn${session.thumbnailsShown ? ' is-active' : ''}`}
                  title={session.thumbnailsShown ? t('slidesHideThumbnails') : t('slidesShowThumbnails')}
                  aria-label={session.thumbnailsShown ? t('slidesHideThumbnails') : t('slidesShowThumbnails')}
                  aria-pressed={session.thumbnailsShown}
                  onMouseDown={keepFocus}
                  onClick={() => session.toggleSlideList()}
                >
                  <Squares2X2Icon className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>,
          session.controlsSlot,
        )}
      </div>

      {/* Per-slide thumbnail context menu */}
      {slideMenu && !readOnly && createPortal(
        <div
          ref={slideMenuRef}
          className="lobster-office-popover lobster-slides-context-menu"
          role="menu"
          aria-label={t('slidesSlideActions')}
          style={{ left: slideMenu.left, top: slideMenu.top, width: SLIDE_MENU_WIDTH }}
        >
          <button
            type="button"
            role="menuitem"
            className="lobster-office-menu-item lobster-slides-popover-item"
            onMouseDown={keepFocus}
            onClick={() => {
              const target = slideMenu.index;
              setSlideMenu(null);
              session.addSlide(target);
            }}
          >
            <PlusIcon className="h-3.5 w-3.5 shrink-0" />
            <span>{t('slidesNewSlideAfter')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="lobster-office-menu-item lobster-slides-popover-item"
            onMouseDown={keepFocus}
            onClick={() => {
              const target = slideMenu.index;
              setSlideMenu(null);
              session.duplicateSlide(target);
            }}
          >
            <DocumentDuplicateIcon className="h-3.5 w-3.5 shrink-0" />
            <span>{t('slidesDuplicateSlide')}</span>
          </button>
          <span className="lobster-slides-menu-divider" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="lobster-office-menu-item lobster-slides-popover-item is-danger"
            disabled={slideCount <= 1}
            onMouseDown={keepFocus}
            onClick={() => {
              const target = slideMenu.index;
              setSlideMenu(null);
              session.deleteSlide(target);
            }}
          >
            <TrashIcon className="h-3.5 w-3.5 shrink-0" />
            <span>{t('slidesDeleteSlide')}</span>
          </button>
        </div>,
        window.document.body,
      )}

      {/* Fullscreen slideshow presentation modal */}
      {presentingStartIndex !== null && (
        <SlidesPresentationModal
          session={session}
          initialIndex={presentingStartIndex}
          onExit={handleExitPresentation}
        />
      )}
    </OfficeEditorShell>
  );
}

export default function SlidesFileEditor({ filePath, preview, onAddToChat }: {
  filePath: string; preview: React.ReactNode; onAddToChat?: AddToChat;
}): React.ReactElement {
  return (
    <OfficeEditorLoader filePath={filePath} acquire={acquireSlidesEditor} labels={SLIDES_LABELS} preview={preview}>
      {session => <ActiveSlidesEditor session={session} filePath={filePath} onAddToChat={onAddToChat} />}
    </OfficeEditorLoader>
  );
}
