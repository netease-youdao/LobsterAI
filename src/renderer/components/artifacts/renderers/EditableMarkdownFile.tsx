import { CheckIcon } from '@heroicons/react/24/outline';
import React, { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useDispatch } from 'react-redux';

import { i18nService } from '@/services/i18n';
import { getMarkdownDocument, MarkdownSaveState } from '@/services/markdownDocument';
import { normalizeShellFilePath } from '@/services/shellAppsCache';
import { addArtifact } from '@/store/slices/artifactSlice';
import type { Artifact } from '@/types/artifact';

import { MarkdownFileError } from '../../../../shared/artifactPreview/markdownEditing';

const MarkdownEditor = lazy(() => import('./MarkdownEditor'));
const t = (key: string) => i18nService.t(key);

/** Only a slow save is worth announcing; fast autosaves stay silent. */
const SLOW_SAVE_NOTICE_MS = 800;
const SAVED_NOTICE_MS = 1600;

const SaveNotice = { None: 'none', Hint: 'hint', Saving: 'saving', Saved: 'saved' } as const;
type SaveNotice = typeof SaveNotice[keyof typeof SaveNotice];

interface EditableMarkdownFileProps {
  artifact: Artifact;
  sourceView?: boolean;
  renderPreview: (content: string) => React.ReactNode;
  resolveLocalFilePath?: (href: string, text: string) => string | null;
}

const EditableMarkdownFile: React.FC<EditableMarkdownFileProps> = ({ artifact, sourceView = false, renderPreview, resolveLocalFilePath }) => {
  const dispatch = useDispatch();
  const document = useMemo(() => getMarkdownDocument(normalizeShellFilePath(artifact.filePath!)), [artifact.filePath]);
  const state = useSyncExternalStore(document.subscribe, document.getSnapshot);
  const [conflictChoice, setConflictChoice] = useState<boolean | null>(null);
  const [engaged, setEngaged] = useState(false);
  const [notice, setNotice] = useState<SaveNotice>(SaveNotice.None);
  const artifactRef = useRef(artifact);
  artifactRef.current = artifact;

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
      const closingArtifact = artifactRef.current;
      void document.flush().then(() => {
        const finalState = document.getSnapshot();
        if (finalState.ready && finalState.status === MarkdownSaveState.Saved) {
          dispatch(addArtifact({
            sessionId: closingArtifact.sessionId,
            artifact: { ...closingArtifact, content: finalState.content, contentVersion: Date.now() },
          }));
        }
      });
    };
  }, [dispatch, document]);

  useEffect(() => { void document.refresh(); }, [document, artifact.contentVersion]);

  useEffect(() => {
    if (state.ready && state.status === MarkdownSaveState.Saved && artifact.content !== state.content) {
      dispatch(addArtifact({
        sessionId: artifact.sessionId,
        artifact: { ...artifact, content: state.content, contentVersion: Date.now() },
      }));
    }
  }, [artifact, dispatch, state.content, state.ready, state.status]);

  // Autosave stays quiet: a hint until the reader first clicks into the text,
  // a notice only for a slow save, and a brief confirmation after an edit lands.
  const previousStatus = useRef(state.status);
  useEffect(() => {
    const previous = previousStatus.current;
    previousStatus.current = state.status;
    if (!state.ready) {
      setNotice(SaveNotice.None);
      return undefined;
    }
    if (!engaged) {
      setNotice(state.status === MarkdownSaveState.Saved ? SaveNotice.Hint : SaveNotice.None);
      return undefined;
    }
    if (state.status === MarkdownSaveState.Saving) {
      const timer = window.setTimeout(() => setNotice(SaveNotice.Saving), SLOW_SAVE_NOTICE_MS);
      return () => window.clearTimeout(timer);
    }
    if (state.status === MarkdownSaveState.Saved
      && (previous === MarkdownSaveState.Saving || previous === MarkdownSaveState.Pending)) {
      setNotice(SaveNotice.Saved);
      const timer = window.setTimeout(() => setNotice(SaveNotice.None), SAVED_NOTICE_MS);
      return () => window.clearTimeout(timer);
    }
    setNotice(SaveNotice.None);
    return undefined;
  }, [engaged, state.ready, state.status]);

  // Keep the last message while the notice fades out, so it does not collapse first.
  const shownNotice = useRef<SaveNotice>(SaveNotice.None);
  if (notice !== SaveNotice.None) shownNotice.current = notice;

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
              onFocus={() => setEngaged(true)}
              onBlur={() => { void document.flush(); }}
              resolveLocalFilePath={resolveLocalFilePath}
            />
          </Suspense>
        )}
        <div
          role="status"
          aria-live="polite"
          className={`pointer-events-none absolute right-4 top-2 flex items-center gap-1 rounded-full bg-background/90 px-2.5 py-0.5 text-xs text-muted shadow-sm ring-1 ring-border transition-opacity duration-300 ${notice === SaveNotice.None ? 'opacity-0' : 'opacity-100'}`}
        >
          {shownNotice.current === SaveNotice.Saved && <CheckIcon className="h-3.5 w-3.5" />}
          {shownNotice.current === SaveNotice.Hint && t('markdownEditorHint')}
          {shownNotice.current === SaveNotice.Saving && t('markdownFileSaving')}
          {shownNotice.current === SaveNotice.Saved && t('markdownFileSaved')}
        </div>
      </div>
    </div>
  );
};

export default EditableMarkdownFile;
