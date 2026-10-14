import { LibraryAvailability } from '../../../shared/library/constants';
import type { LocalArtifactItem } from '../../../shared/library/types';
import { loadDetectedFileArtifact } from '../../services/artifactDetection';
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
 * Library previews use account-bound file access and cannot open the live editors' path-only
 * IPC. Read each new version while keeping the same preview mounted across library refreshes.
 */
export const getLibraryPreviewContentKey = (item: LocalArtifactItem): string | undefined => {
  const previewKey = getLibraryPreviewKey(item);
  if (!previewKey) return undefined;
  return [previewKey, item.fileMtimeMs ?? '', item.sizeBytes ?? ''].join('\0');
};

export const canShareLibraryArtifact = (item: LocalArtifactItem): boolean => (
  item.availability === LibraryAvailability.Available
  && isArtifactFileShareable(createLibraryArtifactCandidate(item))
);

export const loadLibraryArtifact = async (
  item: LocalArtifactItem,
  isCurrent: () => boolean,
): Promise<Artifact | null> => {
  if (!isCurrent()) return null;
  const result = await window.electron.library.getLocalAccess(item.itemId);
  if (!isCurrent()) return null;
  if (!result.success) throw new Error(result.error);
  const artifact = await loadDetectedFileArtifact({
    ...createLibraryArtifactCandidate(item),
    filePath: result.data.filePath,
    fileAccess: result.data.access,
  });
  return isCurrent() ? artifact : null;
};
