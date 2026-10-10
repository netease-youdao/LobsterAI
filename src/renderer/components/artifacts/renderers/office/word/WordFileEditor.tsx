import './wordEditor.css';

import React, { useMemo, useRef, useSyncExternalStore } from 'react';

import { i18nService } from '@/services/i18n';
import { acquireWordEditor, type WordEditorSession } from '@/services/office/word/wordEditorSession';
import { WordFontSource } from '@/services/office/word/wordFonts';

import { WordReadOnlyReason } from '../../../../../../shared/office/word/wordFile';
import { useEditorSelectionChat } from '../../../artifactSelectedText';
import {
type OfficeEditorLabels,   OfficeEditorLoader, OfficeEditorShell, useOfficeDocumentState, useOfficeEditorMount,
} from '../common/OfficeEditorShell';
import { useRegisterOfficePreviewZoomControls } from '../common/OfficePreviewActionsContext';
import { clampOfficeZoom, OfficeZoom } from '../common/OfficeZoomControls';
import { WordToolbar } from './WordToolbar';

const t = (key: string) => i18nService.t(key);
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

function ActiveWordEditor({ session, onAddToChat }: { session: WordEditorSession; onAddToChat?: AddToChat }): React.ReactElement {
  const { document } = session;
  const state = useOfficeDocumentState(document);
  const editorState = useSyncExternalStore(session.subscribeEditor, session.getEditorSnapshot);
  const fontReport = useSyncExternalStore(session.subscribeEditor, session.getFontReport);
  const substitutedFonts = fontReport.filter(entry => entry.source !== WordFontSource.Available);
  const fontDetails = substitutedFonts.map(entry => (entry.source === WordFontSource.Missing
    ? `${entry.family}: ${t('wordFontMissing')}` : `${entry.family} → ${entry.substitute}`)).join('\n');
  const host = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  useOfficeEditorMount(session, host);
  // Selected text goes to the task chat beside the editor, as in the other previews.
  const chat = useEditorSelectionChat({ frame, content: host, selectedText: () => session.selectionSummary()?.text, onAdd: onAddToChat });
  const zoomControls = useMemo(() => {
    const zoomBy = (step: number) => session.editor?.setZoom(clampOfficeZoom((session.editor?.getZoom() ?? 1) + step));
    return {
      zoomFactor: editorState?.zoom ?? 1,
      onZoomOut: () => zoomBy(-OfficeZoom.Step),
      onZoomIn: () => zoomBy(OfficeZoom.Step),
      onResetZoom: () => session.editor?.setZoomMode('auto'),
    };
  }, [session, editorState?.zoom]);
  useRegisterOfficePreviewZoomControls(zoomControls);

  // Undo/redo an agent edit as one step, like the toolbar buttons.
  const undoAgentEdits = (event: React.KeyboardEvent) => {
    const key = event.key.toLowerCase();
    const redo = (key === 'z' && event.shiftKey) || (key === 'y' && event.ctrlKey && !event.metaKey);
    if ((event.metaKey || event.ctrlKey) && !event.altKey && (key === 'z' || redo) && (redo ? session.redo() : session.undo())) {
      event.preventDefault(); event.stopPropagation();
    }
  };

  return (
    <OfficeEditorShell document={document} state={state} labels={WORD_LABELS} className="lobster-word-editor"
      onKeyDown={undoAgentEdits}
      toolbar={<WordToolbar session={session} />}
      footerStart={<span>{t('wordPage')} {editorState?.page.current ?? 1} / {editorState?.page.total ?? 1}</span>}
      footerEnd={(
        <span title={fontDetails || t('wordFontsOriginalHelp')}>
          {substitutedFonts.length ? t('wordFontsSubstituted').replace('{count}', String(substitutedFonts.length)) : t('wordFontsOriginal')}
        </span>
      )}>
      <div className="lobster-word-frame" ref={frame} onPointerUp={chat.handlePointerUp}>
        <div className="lobster-word-mount docx-editor__scroll-container" ref={host} />
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
      {session => <ActiveWordEditor session={session} onAddToChat={onAddToChat} />}
    </OfficeEditorLoader>
  );
}
