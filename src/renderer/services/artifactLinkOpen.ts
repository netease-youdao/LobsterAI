import { type Artifact, ArtifactTypeValue, PREVIEWABLE_ARTIFACT_TYPES } from '../types/artifact';
import {
  getArtifactTypeFromExtension,
  getLocalServicePortIdentityKey,
  isLocalServiceUrl,
  normalizeFilePathForDedup,
  toAbsoluteArtifactPath,
} from './artifactParser';

export const LocalFileLinkTargetKind = {
  /** The session already has an artifact (a card) for the file. */
  Existing: 'existing',
  /** No artifact covers the file yet; load it from disk before showing it. */
  Load: 'load',
} as const;

export type LocalFileLinkTarget =
  | { kind: typeof LocalFileLinkTargetKind.Existing; artifact: Artifact }
  | { kind: typeof LocalFileLinkTargetKind.Load; artifact: Artifact };

const LINKED_FILE_ARTIFACT_ID_PREFIX = 'artifact-linked-file-';

const getPathBaseName = (filePath: string): string => {
  const normalized = filePath.replace(/[\\/]+$/, '');
  const lastSeparator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return lastSeparator >= 0 ? normalized.slice(lastSeparator + 1) : normalized;
};

/**
 * What opening a local file link inside the app should show: the session's
 * artifact for that file when a card already covers it, or a new artifact
 * to load from disk. Only file types a card could preview qualify; for
 * anything else (folders, archives, source files) this returns null and the
 * link keeps opening in the system default application.
 *
 * A new artifact belongs to no message, so it never turns into a card.
 */
export function resolveLocalFileLinkTarget(
  filePath: string,
  sessionArtifacts: Artifact[],
  context: { sessionId: string; cwd?: string },
): LocalFileLinkTarget | null {
  const absolutePath = toAbsoluteArtifactPath(filePath.trim(), context.cwd);
  const fileName = getPathBaseName(absolutePath);
  const extensionIndex = fileName.lastIndexOf('.');
  const type = extensionIndex > 0 ? getArtifactTypeFromExtension(fileName.slice(extensionIndex)) : null;
  if (!type || !PREVIEWABLE_ARTIFACT_TYPES.has(type)) return null;

  const pathKey = normalizeFilePathForDedup(absolutePath);
  const existing = sessionArtifacts.find(artifact =>
    artifact.filePath && normalizeFilePathForDedup(artifact.filePath) === pathKey
  );
  if (existing) return { kind: LocalFileLinkTargetKind.Existing, artifact: existing };

  return {
    kind: LocalFileLinkTargetKind.Load,
    artifact: {
      id: `${LINKED_FILE_ARTIFACT_ID_PREFIX}${pathKey}`,
      messageId: '',
      sessionId: context.sessionId,
      type,
      title: fileName,
      content: '',
      fileName,
      filePath: absolutePath,
      source: 'file',
      createdAt: Date.now(),
    },
  };
}

/** The session's local service card for a link to the same local port, if any. */
export function findLocalServiceArtifactForUrl(url: string, sessionArtifacts: Artifact[]): Artifact | null {
  if (!isLocalServiceUrl(url)) return null;
  const portKey = getLocalServicePortIdentityKey(url);
  return sessionArtifacts.find(artifact =>
    artifact.type === ArtifactTypeValue.LocalService
      && getLocalServicePortIdentityKey(artifact.url || artifact.content) === portKey
  ) ?? null;
}
