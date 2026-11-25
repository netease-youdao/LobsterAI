import type { ArtifactFileRenamedEvent } from '@shared/artifactPreview/constants';
import { useEffect, useRef } from 'react';
import { useDispatch } from 'react-redux';

import { renameLocalArtifactFile } from '@/services/artifactWorkspace';
import { i18nService } from '@/services/i18n';
import { getMarkdownDocument, relocateMarkdownDocument } from '@/services/markdownDocument';
import { closeOpenOfficeEditor } from '@/services/office/officeFormats';
import { normalizeShellFilePath } from '@/services/shellAppsCache';
import { renameArtifactFile } from '@/store/slices/artifactSlice';
import { type Artifact, ArtifactTypeValue } from '@/types/artifact';

import { canRenameArtifactFile, splitArtifactFileNameExtension } from './artifactHeaderPath';

export interface CommitArtifactRenameParams {
  sessionId: string;
  artifact: Artifact;
  nextStem: string;
  dispatch: (action: ReturnType<typeof renameArtifactFile>) => unknown;
}

function applyFileRename(
  sessionId: string,
  type: Artifact['type'],
  change: ArtifactFileRenamedEvent,
  dispatch: CommitArtifactRenameParams['dispatch'],
): void {
  if (type === ArtifactTypeValue.Markdown) relocateMarkdownDocument(change.oldFilePath, change.newFilePath);
  dispatch(renameArtifactFile({ sessionId, ...change }));
}

/** Follow open tabs even while the file list or another preview is visible. */
export function useArtifactFileRenameSync(sessionId: string | undefined, tabs: { artifact: Artifact }[]): void {
  const dispatch = useDispatch();
  const watched = useRef(new Map<string, Artifact['type']>());
  useEffect(() => {
    if (!sessionId) return;
    const api = window.electron.artifact;
    const paths = watched.current;
    const unsubscribe = api.onFileRenamed(change => {
      const type = paths.get(change.oldFilePath);
      if (type) applyFileRename(sessionId, type, change, dispatch);
    });
    return () => {
      unsubscribe();
      for (const path of paths.keys()) void api.unwatchFile(path);
      paths.clear();
    };
  }, [dispatch, sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    const next = new Map<string, Artifact['type']>();
    for (const { artifact } of tabs) {
      if (artifact.filePath && canRenameArtifactFile(artifact)) {
        next.set(normalizeShellFilePath(artifact.filePath), artifact.type);
      }
    }
    const api = window.electron.artifact;
    for (const path of watched.current.keys()) {
      if (next.has(path)) continue;
      watched.current.delete(path);
      void api.unwatchFile(path);
    }
    for (const [path, type] of next) {
      if (!watched.current.has(path)) void api.watchFile(path);
      watched.current.set(path, type);
    }
  }, [sessionId, tabs]);
}

/**
 * Flushes pending Markdown/Office edits, renames the file on disk via IPC, and updates Redux.
 * Returns true if the file was renamed, false if unchanged or failed (with an error toast).
 */
export async function commitArtifactFileRename({
  sessionId,
  artifact,
  nextStem,
  dispatch,
}: CommitArtifactRenameParams): Promise<boolean> {
  const trimmed = nextStem.trim();
  const displayName = artifact.fileName || artifact.title;
  const { stem } = splitArtifactFileNameExtension(displayName);

  if (!trimmed || trimmed === stem || !artifact.filePath) {
    return false;
  }

  try {
    const oldFilePath = artifact.filePath;
    if (artifact.type === ArtifactTypeValue.Markdown) {
      await getMarkdownDocument(normalizeShellFilePath(oldFilePath)).flush();
    } else {
      await closeOpenOfficeEditor(oldFilePath);
    }

    const result = await renameLocalArtifactFile(oldFilePath, trimmed);
    if (!result.success) {
      window.dispatchEvent(new CustomEvent('app:showToast', {
        detail: result.error || i18nService.t('artifactRenameFileFailed'),
      }));
      return false;
    }

    applyFileRename(sessionId, artifact.type, {
      oldFilePath,
      newFilePath: result.filePath,
      newFileName: result.fileName,
    }, dispatch);
    return true;
  } catch (error) {
    window.dispatchEvent(new CustomEvent('app:showToast', {
      detail: error instanceof Error ? error.message : i18nService.t('artifactRenameFileFailed'),
    }));
    return false;
  }
}
