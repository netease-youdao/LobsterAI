import { LibraryAvailability } from '../../../shared/library/constants';
import type { LocalArtifactItem } from '../../../shared/library/types';
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
