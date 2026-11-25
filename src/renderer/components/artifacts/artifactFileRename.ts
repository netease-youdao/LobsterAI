import { renameLocalArtifactFile } from '@/services/artifactWorkspace';
import { i18nService } from '@/services/i18n';
import { getMarkdownDocument } from '@/services/markdownDocument';
import { closeOpenOfficeEditor } from '@/services/office/officeFormats';
import { normalizeShellFilePath } from '@/services/shellAppsCache';
import { renameArtifactFile } from '@/store/slices/artifactSlice';
import { type Artifact, ArtifactTypeValue } from '@/types/artifact';

import { splitArtifactFileNameExtension } from './artifactHeaderPath';

export interface CommitArtifactRenameParams {
  sessionId: string;
  artifact: Artifact;
  nextStem: string;
  dispatch: (action: ReturnType<typeof renameArtifactFile>) => unknown;
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

    dispatch(renameArtifactFile({
      sessionId,
      oldFilePath,
      newFilePath: result.filePath,
      newFileName: result.fileName,
    }));
    return true;
  } catch (error) {
    window.dispatchEvent(new CustomEvent('app:showToast', {
      detail: error instanceof Error ? error.message : i18nService.t('artifactRenameFileFailed'),
    }));
    return false;
  }
}
