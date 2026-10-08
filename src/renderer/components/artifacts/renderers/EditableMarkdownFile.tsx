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
const SAVE_LABEL = {
  [MarkdownSaveState.Loading]: 'markdownFileLoading',
  [MarkdownSaveState.Saved]: 'markdownFileSaved',
  [MarkdownSaveState.Pending]: 'markdownFilePending',
  [MarkdownSaveState.Saving]: 'markdownFileSaving',
  [MarkdownSaveState.Error]: 'markdownFileSaveFailed',
  [MarkdownSaveState.Conflict]: 'markdownFileConflict',
};

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

  const conflict = state.status === MarkdownSaveState.Conflict;
  const failed = state.status === MarkdownSaveState.Error;
  const errorLabel = state.errorCode === MarkdownFileError.TooLarge ? 'markdownFileTooLarge'
    : state.errorCode === MarkdownFileError.InvalidEncoding ? 'markdownFileEncoding'
    : state.ready ? 'markdownFileSaveFailed' : 'markdownFileLoadFailed';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2 text-xs">
        <div role="status" aria-live="polite" className={`flex items-center gap-1.5 ${failed || conflict ? 'text-amber-600 dark:text-amber-400' : 'text-muted'}`}>
          {state.status === MarkdownSaveState.Saved && <CheckIcon className="h-3.5 w-3.5" />}
          {t(failed ? errorLabel : SAVE_LABEL[state.status])}
        </div>
        {state.ready && <span className="text-muted">{t('markdownEditorHint')}</span>}
      </div>
      {(!state.draftSafe || conflict || failed || state.restored) && (
        <div className="shrink-0 border-b border-border bg-surface-raised px-4 py-2 text-xs text-secondary" role="alert">
          {!state.draftSafe && <p>{t('markdownFileDraftFailed')}</p>}
          {state.restored && <p>{t('markdownFileDraftRestored')}</p>}
          {failed && (
            <div className="flex items-center justify-between gap-2">
              <span>{t(state.ready && state.draftSafe ? 'markdownFileDraftRetained' : errorLabel)}</span>
              <button type="button" className="shrink-0 text-primary" onClick={() => { void (state.ready ? document.flush() : document.refresh()); }}>{t('retry')}</button>
            </div>
          )}
          {conflict && (
            <>
              <p>{t('markdownFileConflictHelp')}</p>
              {conflictChoice === null ? (
                <div className="mt-2 flex flex-wrap gap-4">
                  <button type="button" className="text-primary" onClick={() => setConflictChoice(true)}>{t('markdownFileKeepMine')}</button>
                  <button type="button" className="text-primary" onClick={() => setConflictChoice(false)}>{t('markdownFileUseDisk')}</button>
                </div>
              ) : (
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <span>{t(conflictChoice ? 'markdownFileConfirmMine' : 'markdownFileConfirmDisk')}</span>
                  <button type="button" className="text-primary" onClick={() => { void document.resolveConflict(conflictChoice); setConflictChoice(null); }}>{t('confirm')}</button>
                  <button type="button" onClick={() => setConflictChoice(null)}>{t('cancel')}</button>
                </div>
              )}
            </>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden" onKeyDown={event => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          void document.flush();
        }
      }}>
        {state.ready ? (
          <Suspense fallback={<div className="p-6 text-sm text-muted">{t('markdownEditorLoading')}</div>}>
            <MarkdownEditor content={state.content} sourceView={sourceView} onChange={document.setContent} onBlur={() => { void document.flush(); }} resolveLocalFilePath={resolveLocalFilePath} />
          </Suspense>
        ) : renderPreview(state.ready ? state.content : artifact.content)}
      </div>
    </div>
  );
};

export default EditableMarkdownFile;
