import './wordEditor.css';

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { i18nService } from '@/services/i18n';
import { OfficeSaveState } from '@/services/office/core/officeDocument';
import { acquireWordEditor, WORD_DEFAULT_ZOOM_MODE, type WordEditorSession } from '@/services/office/word/wordEditorSession';
import { visibleSubstitutedWordFonts, WordFontSource } from '@/services/office/word/wordFonts';

import { WordReadOnlyReason } from '../../../../../../shared/office/word/wordFile';
import { useEditorSelectionChat } from '../../../artifactSelectedText';
import {
  type OfficeEditorLabels, OfficeEditorLoader, OfficeEditorShell, useOfficeDocumentState, useOfficeEditorMount,
} from '../common/OfficeEditorShell';
import {
  useOfficePreviewActions,
  useRegisterOfficeOwnsDocumentToolbar,
  useRegisterOfficePreviewZoomControls,
} from '../common/OfficePreviewActionsContext';
import { clampOfficeZoom, OfficeZoom, OfficeZoomControls } from '../common/OfficeZoomControls';
import { WordFindBar } from './WordFindBar';
import { WordHeaderBar } from './WordHeaderBar';
import { WordImageOverlay } from './WordImageOverlay';
import { wordImageTransferHandlers } from './WordInsertControls';
import { WordToolbar } from './WordToolbar';

const t = (key: string) => i18nService.t(key);
const SLOW_SAVE_NOTICE_MS = 800;
const WORD_LABELS: OfficeEditorLabels<WordReadOnlyReason> = {
  editor: 'wordEditor',
  loading: 'wordLoading',
  tooLarge: 'wordTooLarge',
  unsupported: 'wordUnsupported',
  accessFailed: 'wordAccessFailed',
  inUse: 'wordInUse',
  readOnly: 'wordReadOnly',
  readOnlyReasons: {
    [WordReadOnlyReason.Comments]: 'wordReadOnlyComments',
    [WordReadOnlyReason.Revisions]: 'wordReadOnlyRevisions',
    [WordReadOnlyReason.Protection]: 'wordReadOnlyProtection',
    [WordReadOnlyReason.Embedded]: 'wordReadOnlyEmbedded',
    [WordReadOnlyReason.Signature]: 'wordReadOnlySignature',
    [WordReadOnlyReason.Macros]: 'wordReadOnlyMacros',
    [WordReadOnlyReason.ExternalContent]: 'wordReadOnlyExternal',
  },
};

type AddToChat = (text: string) => void;

function ActiveWordEditor({
  session,
  filePath,
  onAddToChat,
}: {
  session: WordEditorSession;
  filePath: string;
  onAddToChat?: AddToChat;
}): React.ReactElement {
  const { document } = session;
  const state = useOfficeDocumentState(document);
  const editorState = useSyncExternalStore(session.subscribeEditor, session.getEditorSnapshot);
  const fontReport = useSyncExternalStore(session.subscribeEditor, session.getFontReport);

  // Claim the host ArtifactDocumentToolbar so Word renders one unified top bar without an empty row.
  useRegisterOfficeOwnsDocumentToolbar(true);
  const previewActions = useOfficePreviewActions();

  const [isFormatBarOpen, setIsFormatBarOpen] = useState(true);
  const [showSlowSaving, setShowSlowSaving] = useState(false);
  const [isFindOpen, setIsFindOpen] = useState(false);
  const [findFocusRequestId, setFindFocusRequestId] = useState(0);
  const [displayPage, setDisplayPage] = useState(1);

  const readOnly = state.readOnlyReasons.length > 0;
  useEffect(() => {
    if (readOnly || state.status !== OfficeSaveState.Saving) {
      setShowSlowSaving(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setShowSlowSaving(true), SLOW_SAVE_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [readOnly, state.status]);

  const substitutedFonts = visibleSubstitutedWordFonts(fontReport);
  const fontDetails = substitutedFonts.map(entry => (entry.source === WordFontSource.Missing
    ? `${entry.family}: ${t('wordFontMissing')}` : `${entry.family} → ${entry.substitute}`)).join('\n');
  const host = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  useOfficeEditorMount(session, host);

  const syncViewportPage = useCallback(() => {
    const nextPage = session.editor?.getCurrentPage('viewport');
    if (typeof nextPage === 'number' && nextPage > 0) {
      setDisplayPage(prev => (prev === nextPage ? prev : nextPage));
    }
  }, [session]);

  const caretPage = editorState?.page.current;
  useEffect(() => {
    if (typeof caretPage === 'number' && caretPage > 0) {
      setDisplayPage(prev => (prev === caretPage ? prev : caretPage));
    }
  }, [caretPage]);

  // Selected text goes to the task chat beside the editor, as in the other previews.
  const chat = useEditorSelectionChat({
    frame,
    content: host,
    selectedText: () => session.selectionSummary()?.text || window.getSelection()?.toString() || undefined,
    onAdd: onAddToChat,
  });
  const imageTransfer = useMemo(() => wordImageTransferHandlers(session), [session]);
  const zoomControls = useMemo(() => {
    const zoomBy = (step: number) => session.editor?.setZoom(clampOfficeZoom((session.editor?.getZoom() ?? 1) + step));
    return {
      zoomFactor: editorState?.zoom ?? 1,
      onZoomOut: () => zoomBy(-OfficeZoom.Step),
      onZoomIn: () => zoomBy(OfficeZoom.Step),
      onResetZoom: () => session.editor?.setZoomMode(WORD_DEFAULT_ZOOM_MODE),
    };
  }, [session, editorState?.zoom]);
  useRegisterOfficePreviewZoomControls(zoomControls);

  const handleToggleFind = useCallback(() => {
    setIsFindOpen(open => {
      const next = !open;
      if (next) setFindFocusRequestId(id => id + 1);
      return next;
    });
  }, []);

  // Shortcuts: Cmd/Ctrl+F opens in-document find; Cmd/Ctrl+Z/Y undoes grouped edits.
  const handleEditorKeyDown = (event: React.KeyboardEvent) => {
    const key = event.key.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && !event.altKey && key === 'f') {
      event.preventDefault();
      event.stopPropagation();
      setIsFindOpen(true);
      setFindFocusRequestId(id => id + 1);
      return;
    }
    if (readOnly) return;
    const redo = (key === 'z' && event.shiftKey) || (key === 'y' && event.ctrlKey && !event.metaKey);
    if ((event.metaKey || event.ctrlKey) && !event.altKey && (key === 'z' || redo) && (redo ? session.redo() : session.undo())) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const totalPages = editorState?.page.total ?? 1;
  const currentPage = Math.max(1, Math.min(displayPage, totalPages));

  return (
    <OfficeEditorShell
      document={document}
      state={state}
      labels={WORD_LABELS}
      className="lobster-word-editor"
      keepToolbarWhenReadOnly
      onKeyDown={handleEditorKeyDown}
      toolbar={(
        <div className="lobster-word-chrome">
          <WordHeaderBar
            session={session}
            isFormatBarOpen={isFormatBarOpen}
            onToggleFormatBar={() => setIsFormatBarOpen(open => !open)}
            readOnly={readOnly}
            showSlowSaving={showSlowSaving}
            filePath={filePath}
            isFindOpen={isFindOpen}
            onToggleFind={handleToggleFind}
            zoomControls={zoomControls}
            documentActions={previewActions?.documentActions}
          />
          {isFormatBarOpen && !readOnly && <WordToolbar session={session} />}
        </div>
      )}
      footerStart={<span>{t('wordPage')} {currentPage} / {totalPages}</span>}
      footerEnd={(
        <div className="lobster-word-footer-end">
          {substitutedFonts.length > 0 && (
            <span className="lobster-word-font-badge" title={fontDetails}>
              {t('wordFontsSubstituted').replace('{count}', String(substitutedFonts.length))}
            </span>
          )}
          <div className="lobster-word-footer-zoom">
            <OfficeZoomControls
              zoomFactor={zoomControls.zoomFactor}
              onZoomOut={zoomControls.onZoomOut}
              onZoomIn={zoomControls.onZoomIn}
              onResetZoom={zoomControls.onResetZoom}
            />
          </div>
        </div>
      )}
    >
      <div className="lobster-word-frame" ref={frame} onPointerUp={chat.handlePointerUp} {...(readOnly ? {} : imageTransfer)}>
        <div
          className="lobster-word-mount docx-editor__scroll-container"
          ref={host}
          onScroll={syncViewportPage}
        />
        {!readOnly && <WordImageOverlay session={session} mount={host} />}
        {isFindOpen && (
          <WordFindBar
            session={session}
            focusRequestId={findFocusRequestId}
            onClose={() => setIsFindOpen(false)}
          />
        )}
        {chat.button}
      </div>
    </OfficeEditorShell>
  );
}

export default function WordFileEditor({ filePath, preview, onAddToChat }: {
  filePath: string; preview: React.ReactNode; onAddToChat?: AddToChat;
}): React.ReactElement {
  return (
    <OfficeEditorLoader filePath={filePath} acquire={acquireWordEditor} labels={WORD_LABELS} preview={preview}>
      {session => <ActiveWordEditor session={session} filePath={filePath} onAddToChat={onAddToChat} />}
    </OfficeEditorLoader>
  );
}
