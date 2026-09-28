import './slidesEditor.css';

import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { i18nService } from '@/services/i18n';
import { SlidesRefusal } from '@/services/office/slides/slidesDeck';
import { acquireSlidesEditor, type SlidesChatReference, type SlidesEditorSession } from '@/services/office/slides/slidesEditorSession';

import { SlidesReadOnlyReason } from '../../../../../../shared/office/slides/slidesFile';
import { useEditorSelectionChat } from '../../../artifactSelectedText';
import {
  type OfficeEditorLabels, OfficeEditorLoader, OfficeEditorShell, useOfficeDocumentState, useOfficeEditorMount,
} from '../common/OfficeEditorShell';
import { useRegisterOfficePreviewZoomControls } from '../common/OfficePreviewActionsContext';
import { OfficeZoom } from '../common/OfficeZoomControls';
import { SlidesToolbar } from './SlidesToolbar';

const t = (key: string) => i18nService.t(key);
const SLIDES_LABELS: OfficeEditorLabels<SlidesReadOnlyReason> = {
  editor: 'slidesEditor',
  loading: 'slidesLoading',
  tooLarge: 'slidesTooLarge',
  unsupported: 'slidesUnsupported',
  accessFailed: 'slidesAccessFailed',
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

type AddToChat = (reference: SlidesChatReference) => void;

function ActiveSlidesEditor({ session, onAddToChat }: { session: SlidesEditorSession; onAddToChat?: AddToChat }): React.ReactElement {
  const { document } = session;
  const state = useOfficeDocumentState(document);
  useSyncExternalStore(session.subscribe, session.getVersion);
  const host = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
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
  const refusedAt = session.lastRefusal;
  useEffect(() => {
    if (!refusedAt) return undefined;
    setNow(Date.now());
    const timer = setTimeout(() => setNow(Date.now()), REFUSAL_NOTICE_MS + 50);
    return () => clearTimeout(timer);
  }, [refusedAt]);
  const zoom = session.zoom;
  const zoomControls = useMemo(() => ({
    zoomFactor: zoom,
    onZoomOut: () => session.setZoom(zoom - OfficeZoom.Step),
    onZoomIn: () => session.setZoom(zoom + OfficeZoom.Step),
    onResetZoom: () => session.fitToWindow(),
  }), [session, zoom]);
  useRegisterOfficePreviewZoomControls(zoomControls);
  const readOnly = state.readOnlyReasons.length > 0;
  const position = session.currentIndex >= 0
    ? t('slidesPosition').replace('{current}', String(session.currentIndex + 1)).replace('{total}', String(session.slideCount))
    : '';

  return (
    <OfficeEditorShell document={document} state={state} labels={SLIDES_LABELS} className="lobster-slides-editor"
      notices={!readOnly && refusedAt > 0 && now - refusedAt < REFUSAL_NOTICE_MS && (
        <div className="lobster-office-notice" role="status">
          <p>{t(REFUSAL_LABEL[session.lastRefusalCode] ?? 'slidesRefused')}</p>
        </div>
      )}
      toolbar={<SlidesToolbar session={session} disabled={state.needsResolution || !state.ready} />}
      footerStart={<span>{position}</span>}
      footerEnd={readOnly ? undefined : <span>{t('slidesEditHint')}</span>}>
      <div className="lobster-slides-frame" ref={frame} onPointerUp={chat.handlePointerUp}>
        <div className="lobster-slides-mount" ref={host} />
        {chat.button}
      </div>
    </OfficeEditorShell>
  );
}

export default function SlidesFileEditor({ filePath, preview, onAddToChat }: {
  filePath: string; preview: React.ReactNode; onAddToChat?: AddToChat;
}): React.ReactElement {
  return (
    <OfficeEditorLoader filePath={filePath} acquire={acquireSlidesEditor} labels={SLIDES_LABELS} preview={preview}>
      {session => <ActiveSlidesEditor session={session} onAddToChat={onAddToChat} />}
    </OfficeEditorLoader>
  );
}
