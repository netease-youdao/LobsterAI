import { WordPanelAction, type WordPanelPresentation } from '@shared/office/word/constants';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { OfficePreviewDocumentActions } from '@/components/artifacts/renderers/office/common/OfficePreviewActionsContext';
import { i18nService } from '@/services/i18n';
import { consumeOfficeAutoFocus } from '@/services/office/officeFormats';
import { openLocalPathWithToast, showToast } from '@/utils/localFileActions';

import { observeWordPanelBounds } from './wordPanelBounds';

export function useWordPanel(filePath: string, actions?: OfficePreviewDocumentActions | null, onAddToChat?: (text: string) => void) {
  const bridge = window.electron.artifact.wordPanel;
  const element = useRef<HTMLDivElement>(null);
  const [token, setToken] = useState(() => crypto.randomUUID());
  const [failed, setFailed] = useState(false);
  const [snapshot, setSnapshot] = useState<string>();
  const autoFocus = useRef(false);
  const handlers = useRef({ actions, onAddToChat });
  handlers.current = { actions, onAddToChat };
  const canShare = !!actions?.canShare;
  const canDownload = !!actions?.canDownload;
  const canRefresh = !!actions?.canRefresh;
  const canReveal = !!actions?.canRevealInFolder;
  const canList = !!actions?.canOpenFileList;
  const canAdd = !!onAddToChat;
  const fileListOpen = !!actions?.isFileListDrawerOpen;

  useLayoutEffect(() => {
    const stop = bridge.onAction(event => {
      if (event.token !== token) return;
      const { actions: current, onAddToChat: add } = handlers.current;
      switch (event.action) {
        case WordPanelAction.Share: current?.onShare(); break;
        case WordPanelAction.Download: current?.onDownload(); break;
        case WordPanelAction.Refresh: current?.onRefresh(); break;
        case WordPanelAction.Reveal: current?.onRevealInFolder(); break;
        case WordPanelAction.FileList: current?.onOpenFileList?.(); break;
        case WordPanelAction.OpenExternal: void openLocalPathWithToast(filePath); break;
        case WordPanelAction.AddToChat: if (event.text) add?.(event.text); break;
        case WordPanelAction.Toast: if (event.text) showToast(event.text); break;
        case WordPanelAction.Failed: setFailed(true); break;
        case WordPanelAction.Snapshot: setSnapshot(event.text); break;
        case WordPanelAction.Shortcut:
          if (event.shortcut?.metaKey || event.shortcut?.ctrlKey) {
            document.dispatchEvent(new KeyboardEvent('keydown', { ...event.shortcut, bubbles: true, cancelable: true }));
          }
          break;
      }
    });
    return () => { stop(); bridge.hide(token); };
  }, [bridge, filePath, token]);

  useLayoutEffect(() => {
    if (failed) return undefined;
    let alive = true;
    const root = document.documentElement;
    autoFocus.current ||= consumeOfficeAutoFocus(filePath, new Set());
    const present = () => {
      const available: WordPanelAction[] = [];
      if (canShare) available.push(WordPanelAction.Share);
      if (canDownload) available.push(WordPanelAction.Download);
      if (canRefresh) available.push(WordPanelAction.Refresh);
      if (canReveal) available.push(WordPanelAction.Reveal);
      if (canList) available.push(WordPanelAction.FileList);
      if (canAdd) available.push(WordPanelAction.AddToChat);
      const panel: WordPanelPresentation = { token, filePath, language: i18nService.getLanguage(), theme: root.dataset.theme ?? '',
        dark: root.classList.contains('dark'), autoFocus: autoFocus.current, actions: available, fileListOpen };
      void bridge.present(panel).catch(() => { if (alive) setFailed(true); });
    };
    present();
    const stop = i18nService.subscribe(present);
    const theme = new MutationObserver(present);
    theme.observe(root, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    return () => { alive = false; theme.disconnect(); stop(); };
  }, [bridge, token, filePath, failed, canShare, canDownload, canRefresh, canReveal, canList, canAdd, fileListOpen]);

  useEffect(() => {
    if (failed || !element.current) return undefined;
    return observeWordPanelBounds(element.current, bounds => bridge.bounds(token, fileListOpen ? null : bounds));
  }, [bridge, token, failed, fileListOpen]);

  return { element, failed, snapshot, retry: () => { setToken(crypto.randomUUID()); setSnapshot(undefined); setFailed(false); } };
}
