import React, { lazy, Suspense, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useDispatch } from 'react-redux';

import { i18nService } from '@/services/i18n';
import { getMarkdownDocument, MarkdownSaveState } from '@/services/markdownDocument';
import { normalizeShellFilePath } from '@/services/shellAppsCache';
import { syncMarkdownFileContent } from '@/store/slices/artifactSlice';
import type { Artifact } from '@/types/artifact';

import { MarkdownFileError } from '../../../../shared/artifactPreview/markdownEditing';

const MarkdownEditor = lazy(() => import('./MarkdownEditor'));
const t = (key: string) => i18nService.t(key);

/** Only an abnormally slow save is announced; normal autosave stays completely silent. */
const SLOW_SAVE_NOTICE_MS = 800;

interface EditableMarkdownFileProps {
  artifact: Artifact;
  sourceView?: boolean;
  renderPreview: (content: string) => React.ReactNode;
  resolveLocalFilePath?: (href: string, text: string) => string | null;
}

const EditableMarkdownFile: React.FC<EditableMarkdownFileProps> = ({ artifact, sourceView = false, renderPreview, resolveLocalFilePath }) => {
  const dispatch = useDispatch();
  const filePath = normalizeShellFilePath(artifact.filePath!);
  const document = useMemo(() => getMarkdownDocument(filePath), [filePath]);
  const state = useSyncExternalStore(document.subscribe, document.getSnapshot);
  const [conflictChoice, setConflictChoice] = useState<boolean | null>(null);
  const [showSlowSaving, setShowSlowSaving] = useState(false);
  const syncSavedContent = useCallback((content: string) => {
    dispatch(syncMarkdownFileContent({ sessionId: artifact.sessionId, filePath, content, contentVersion: Date.now() }));
  }, [dispatch, artifact.sessionId, filePath]);

  useEffect(() => {
    void document.refresh();
    // Atomic file replacement can invalidate fs.watch's inode. Poll only the open
    // Markdown document, and let its version check protect unsaved edits.
    const interval = window.setInterval(() => { void document.refresh(); }, 2000);
    const focus = () => { void document.refresh(); };
    window.addEventListener('focus', focus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', focus);
      // Complete synchronization even if the user switches to Source or closes
      // the preview before the final write replies.
      void document.flush().then(() => {
        const finalState = document.getSnapshot();
        if (finalState.ready && finalState.status === MarkdownSaveState.Saved) {
          syncSavedContent(finalState.content);
        }
      });
    };
  }, [document, syncSavedContent]);

  useEffect(() => { void document.refresh(); }, [document, artifact.contentVersion]);

  useEffect(() => {
    if (state.ready && state.status === MarkdownSaveState.Saved && artifact.content !== state.content) {
      syncSavedContent(state.content);
    }
  }, [artifact.content, syncSavedContent, state.content, state.ready, state.status]);

  useEffect(() => {
    if (!state.ready || state.status !== MarkdownSaveState.Saving) {
      setShowSlowSaving(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setShowSlowSaving(true), SLOW_SAVE_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [state.ready, state.status]);

  const conflict = state.status === MarkdownSaveState.Conflict;
  const failed = state.status === MarkdownSaveState.Error;
  const loadFailed = failed && !state.ready;
  const errorLabel = state.errorCode === MarkdownFileError.TooLarge ? 'markdownFileTooLarge'
    : state.errorCode === MarkdownFileError.InvalidEncoding ? 'markdownFileEncoding'
    : state.ready ? 'markdownFileSaveFailed' : 'markdownFileLoadFailed';

  return (
    <div className="flex h-full min-h-0 flex-col">
      {(!state.draftSafe || conflict || failed || state.restored) && (
        <div className="shrink-0 space-y-1 border-b border-border bg-surface-raised px-4 py-2 text-xs text-secondary" role="alert">
          {!state.draftSafe && <p>{t('markdownFileDraftFailed')}</p>}
          {state.restored && <p>{t('markdownFileDraftRestored')}</p>}
          {failed && (
            <div className="flex items-center justify-between gap-2">
              <span>
                <span className="font-medium text-amber-600 dark:text-amber-400">{t(errorLabel)}</span>
                {state.ready && state.draftSafe && <span className="ml-1.5">{t('markdownFileDraftRetained')}</span>}
              </span>
              <button type="button" className="shrink-0 text-primary" onClick={() => { void (state.ready ? document.flush() : document.refresh()); }}>{t('retry')}</button>
            </div>
          )}
          {conflict && (
            <>
              <p>
                <span className="font-medium text-amber-600 dark:text-amber-400">{t('markdownFileConflict')}</span>
                <span className="ml-1.5">{t('markdownFileConflictHelp')}</span>
              </p>
              {conflictChoice === null ? (
                <div className="flex flex-wrap gap-4 pt-1">
                  <button type="button" className="text-primary" onClick={() => setConflictChoice(true)}>{t('markdownFileKeepMine')}</button>
                  <button type="button" className="text-primary" onClick={() => setConflictChoice(false)}>{t('markdownFileUseDisk')}</button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-3 pt-1">
                  <span>{t(conflictChoice ? 'markdownFileConfirmMine' : 'markdownFileConfirmDisk')}</span>
                  <button type="button" className="text-primary" onClick={() => { void document.resolveConflict(conflictChoice); setConflictChoice(null); }}>{t('confirm')}</button>
                  <button type="button" onClick={() => setConflictChoice(null)}>{t('cancel')}</button>
                </div>
              )}
            </>
          )}
        </div>
      )}
      <div className="relative min-h-0 flex-1 overflow-hidden" onKeyDown={event => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          void document.flush();
        }
      }}>
        {loadFailed ? renderPreview(artifact.content) : (
          // Until the file is read, the editor shows the last known content read-only,
          // so opening a document never swaps one layout for another.
          <Suspense fallback={null}>
            <MarkdownEditor
              content={state.ready ? state.content : artifact.content}
              readOnly={!state.ready}
              sourceView={sourceView}
              onChange={document.setContent}
              onBlur={() => { void document.flush(); }}
              resolveLocalFilePath={resolveLocalFilePath}
            />
          </Suspense>
        )}
        {showSlowSaving && (
          <div
            role="status"
            aria-live="polite"
            className="pointer-events-none absolute right-4 top-2 flex items-center gap-1 rounded-full bg-background/90 px-2.5 py-0.5 text-xs text-muted shadow-sm ring-1 ring-border"
          >
            {t('markdownFileSaving')}
          </div>
        )}
      </div>
    </div>
  );
};

export default EditableMarkdownFile;
