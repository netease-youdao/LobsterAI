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
