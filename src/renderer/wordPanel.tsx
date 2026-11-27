import './index.css';

import { WordPanelAction, type WordPanelPresentation, WordPanelSessionAction } from '@shared/office/word/constants';
import React, { useLayoutEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { OfficePreviewActionsContext } from './components/artifacts/renderers/office/common/OfficePreviewActionsContext';
import { DocxPreview } from './components/artifacts/renderers/office/word/DocxPreview';
import WordFileEditor from './components/artifacts/renderers/office/word/WordFileEditor';
import { i18nService } from './services/i18n';
import { installOfficeAgentBridges, requestOfficeAutoFocus } from './services/office/officeFormats';
import { closeOpenWordEditor, refreshOpenWordEditor } from './services/office/word/wordEditorSession';
import { prepareWordLayout } from './services/office/word/wordFonts';

const guest = window.wordPanelGuest!;
const ignore = () => {};

function WordDocument({ panel }: { panel: WordPanelPresentation }): React.ReactElement {
  const { token, filePath } = panel;
  const context = useMemo(() => {
    const send = (action: WordPanelAction) => () => guest.action({ token, action });
    return { setZoomControls: ignore, setSaveStatus: ignore, documentActions: {
      canShare: panel.actions.includes(WordPanelAction.Share), onShare: send(WordPanelAction.Share),
      canDownload: panel.actions.includes(WordPanelAction.Download), onDownload: send(WordPanelAction.Download),
      canRefresh: panel.actions.includes(WordPanelAction.Refresh), onRefresh: send(WordPanelAction.Refresh),
      canRevealInFolder: panel.actions.includes(WordPanelAction.Reveal), onRevealInFolder: send(WordPanelAction.Reveal),
      canOpenFileList: panel.actions.includes(WordPanelAction.FileList), onOpenFileList: send(WordPanelAction.FileList),
      isFileListDrawerOpen: panel.fileListOpen,
    } };
  }, [panel, token]);
  useLayoutEffect(() => { guest.presented(token); }, [token]);
  return <OfficePreviewActionsContext.Provider value={context}>
    <WordFileEditor filePath={filePath} preview={<DocxPreview artifact={{ filePath, content: '' }} />}
      onAddToChat={panel.actions.includes(WordPanelAction.AddToChat)
        ? text => guest.action({ token, action: WordPanelAction.AddToChat, text }) : undefined} />
  </OfficePreviewActionsContext.Provider>;
}

function WordPanelApp(): React.ReactElement | null {
  const [panel, setPanel] = useState<WordPanelPresentation | null>(null);
  useLayoutEffect(() => {
    let active: WordPanelPresentation | null = null;
    const stopAgent = installOfficeAgentBridges();
    const stopSession = guest.onSession((action, filePath) => action === WordPanelSessionAction.Close
      ? closeOpenWordEditor(filePath) : refreshOpenWordEditor(filePath));
    const stopPresent = guest.onPresent(next => {
      if (next) {
        i18nService.setLanguage(next.language, { persist: false });
        const root = document.documentElement;
        root.lang = next.language;
        root.dataset.theme = next.theme;
        root.classList.toggle('dark', next.dark);
        root.classList.toggle('light', !next.dark);
        if (next.autoFocus && next.token !== active?.token) requestOfficeAutoFocus(next.filePath);
      }
      active = next;
      setPanel(next);
    });
    const toast = (event: Event) => {
      const text = (event as CustomEvent<string>).detail;
      if (active && typeof text === 'string') guest.action({ token: active.token, action: WordPanelAction.Toast, text });
    };
    // Word consumes its own editing shortcuts first. App shortcuts still work while the caret is in Word.
    const shortcut = (event: KeyboardEvent) => {
      if (!active || event.defaultPrevented || event.repeat || event.isComposing || !(event.metaKey || event.ctrlKey)) return;
      const { key, code, metaKey, ctrlKey, shiftKey, altKey } = event;
      guest.action({ token: active.token, action: WordPanelAction.Shortcut, shortcut: { key, code, metaKey, ctrlKey, shiftKey, altKey } });
    };
    window.addEventListener('app:showToast', toast);
    window.addEventListener('keydown', shortcut);
    guest.ready();
    void prepareWordLayout().catch(error => console.warn('[WordPanel] Layout prewarm failed:', error));
    return () => {
      stopAgent(); stopSession(); stopPresent();
      window.removeEventListener('app:showToast', toast);
      window.removeEventListener('keydown', shortcut);
    };
  }, []);
  return panel ? <WordDocument key={panel.token} panel={panel} /> : null;
}

createRoot(document.getElementById('root')!).render(<WordPanelApp />);
