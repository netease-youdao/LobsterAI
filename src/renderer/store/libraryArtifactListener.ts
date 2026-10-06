import { createListenerMiddleware } from '@reduxjs/toolkit';

import {
  isLibraryArtifactType,
  LibraryOrigin,
  LibraryRelationKind,
} from '../../shared/library/constants';
import type { LibraryArtifactCandidate } from '../../shared/library/types';
import type { Artifact } from '../types/artifact';
import { addArtifact, setSessionArtifacts } from './slices/artifactSlice';

export const libraryArtifactListener = createListenerMiddleware();

const toCandidate = (
  sessionId: string,
  artifact: Artifact,
): LibraryArtifactCandidate | null => {
  if (!artifact.filePath || !isLibraryArtifactType(artifact.type)) return null;
  return {
    sessionId,
    messageId: artifact.messageId,
    sessionArtifactId: artifact.id,
    filePath: artifact.filePath,
    detectedType: artifact.type,
    relationKind: artifact.source === 'tool'
      ? LibraryRelationKind.Modified
      : LibraryRelationKind.Referenced,
    relatedAt: Number.isSafeInteger(artifact.createdAt) && artifact.createdAt > 0
      ? artifact.createdAt
      : Date.now(),
    origin: LibraryOrigin.Conversation,
  };
};

const recordCandidates = async (
  candidates: Array<LibraryArtifactCandidate | null>,
): Promise<void> => {
  const validCandidates = candidates.filter(
    (candidate): candidate is LibraryArtifactCandidate => candidate !== null,
  );
  if (validCandidates.length === 0 || !window.electron?.library) return;
  for (let index = 0; index < validCandidates.length; index += 100) {
    const result = await window.electron.library.recordCandidates(
      validCandidates.slice(index, index + 100),
    );
    if (!result.success) {
      console.debug('[Library] Artifact indexing request was not accepted.');
      break;
    }
  }
};

libraryArtifactListener.startListening({
  actionCreator: addArtifact,
  effect: async action => {
    await recordCandidates([
      toCandidate(action.payload.sessionId, action.payload.artifact),
    ]);
  },
});

libraryArtifactListener.startListening({
  actionCreator: setSessionArtifacts,
  effect: async action => {
    const { sessionId, artifacts } = action.payload;
    await recordCandidates(artifacts.map(artifact => toCandidate(sessionId, artifact)));
  },
});
