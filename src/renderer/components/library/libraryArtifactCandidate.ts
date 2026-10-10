import { LibraryArtifactType, LibraryAvailability } from '../../../shared/library/constants';
import type { LocalArtifactItem } from '../../../shared/library/types';
import { officeFormatForPath } from '../../services/office/officeFormats';
import type { Artifact } from '../../types/artifact';
import { isArtifactFileShareable } from '../artifacts/artifactFileSharePolicy';

export const createLibraryArtifactCandidate = (item: LocalArtifactItem): Artifact => ({
  id: `library-${item.itemId}`,
  messageId: item.latestSession.lastMessageId ?? `library-${item.itemId}`,
  sessionId: item.latestSession.sessionId,
  type: item.artifactType,
  title: item.title,
  content: '',
  fileName: item.title,
  filePath: item.filePath,
  source: 'file',
  createdAt: item.createdAt,
});

/**
 * What decides the file a library preview shows and the renderer it gets. Library refreshes
 * replace the item for any change, such as favoriting it or a save of the file it shows; only a
 * different key opens the preview anew. Undefined while the file cannot be shown.
 */
export const getLibraryPreviewKey = (item: LocalArtifactItem): string | undefined => (
  item.availability === LibraryAvailability.Available
    ? [item.itemId, item.filePath, item.artifactType, item.title].join('\0')
    : undefined
);

/**
 * Markdown and the Office formats this window edits open in editors that follow their file
 * themselves: they reload changes made elsewhere and write their own edits.
 */
const opensInSelfSyncingEditor = (item: LocalArtifactItem): boolean => {
  if (item.artifactType === LibraryArtifactType.Markdown) return Boolean(window.electron?.artifact?.markdown);
  return item.artifactType === LibraryArtifactType.Document && Boolean(officeFormatForPath(item.title || item.filePath));
};

/**
 * When a library preview reads its file again: for each version of the file the index records,
 * except in an editor that follows the file itself, where a re-read would only repeat its work
 * after every save.
 */
export const getLibraryPreviewContentKey = (item: LocalArtifactItem): string | undefined => {
  const previewKey = getLibraryPreviewKey(item);
  if (!previewKey || opensInSelfSyncingEditor(item)) return previewKey;
  return [previewKey, item.fileMtimeMs ?? '', item.sizeBytes ?? ''].join('\0');
};

export const canShareLibraryArtifact = (item: LocalArtifactItem): boolean => (
  item.availability === LibraryAvailability.Available
  && isArtifactFileShareable(createLibraryArtifactCandidate(item))
);
