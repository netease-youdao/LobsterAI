import { isConversationArtifactFileName } from '../../shared/artifactPreview/displayPolicy';
import { type RemoteArtifactManifest, RemoteFileReason, RemoteFileState } from '../../shared/remote/files';

export interface ArtifactProjectionJob {
  localArtifactId: string; artifactId?: string; name: string; sizeBytes?: string; messageId?: string; reason?: string; dirtyAt?: number;
  references: Record<string, { latest: NonNullable<RemoteArtifactManifest['latest']>; pinned: boolean }>;
}
/** A null block retains this message's identity so the current library name cannot revive a hidden version. */
export interface RemoteArtifactProjection { localArtifactId: string; block: Record<string, unknown> | null }
export const remoteArtifactReasons = new Set(['FILE_TOO_LARGE', 'FILE_TYPE_NOT_ALLOWED', 'FILE_CONTENT_INVALID', 'ARTIFACT_COUNT_LIMIT', 'TASK_FILE_QUOTA_EXCEEDED',
  'ACCOUNT_FILE_QUOTA_EXCEEDED', 'ACCOUNT_FILE_COUNT_LIMIT', 'UPLOAD_DAILY_QUOTA_EXCEEDED', 'FILE_SOURCE_CHANGED', 'FILE_TRANSFER_BUSY',
  'NOS_PRIVATE_STORAGE_UNAVAILABLE', 'FINAL_SNAPSHOT_UNAVAILABLE', 'FILE_MISSING']);
export function projectRemoteArtifacts(jobs: ArtifactProjectionJob[], messageId: string): RemoteArtifactProjection[] {
  return jobs.flatMap((job): RemoteArtifactProjection[] => {
    const reference = job.references[messageId];
    const published = reference && job.artifactId;
    if (!published && !(job.messageId === messageId && job.reason && remoteArtifactReasons.has(job.reason))) return [];
    const name = published && reference.pinned ? reference.latest.fileName || job.name : job.name;
    if (!isConversationArtifactFileName(name)) return [{ localArtifactId: job.localArtifactId, block: null }];
    if (!published) return [{ localArtifactId: job.localArtifactId, block: { type: 'artifact', artifactId: job.artifactId || job.localArtifactId,
      name, mimeType: 'application/octet-stream', sizeBytes: job.sizeBytes || null, availability: 'desktop_only', reason: job.reason } }];
    // Local capture failures remain on the job; published references cannot carry a failure reason.
    return [{ localArtifactId: job.localArtifactId, block: { type: 'artifact', artifactId: job.artifactId,
      name, mimeType: reference.latest.mimeType,
      sizeBytes: reference.latest.sizeBytes, availability: 'ready', artifactVersion: reference.latest.artifactVersion,
      assetId: reference.latest.assetId, assetVersion: reference.latest.assetVersion, referenceMode: reference.pinned ? 'pinned' : 'latest' } }];
  });
}

/** Keep local capture evidence without treating an available current file as an unfinished upload. */
export function hasRemoteArtifactSyncFailure(job: ArtifactProjectionJob, pending: boolean): boolean {
  if (!job.reason) return false;
  if (pending || !job.messageId) return true;
  const projection = projectRemoteArtifacts([job], job.messageId)[0];
  if (projection?.block === null) return false;
  return job.reason !== RemoteFileReason.Final || job.dirtyAt !== undefined || projection?.block?.availability !== RemoteFileState.Ready;
}
