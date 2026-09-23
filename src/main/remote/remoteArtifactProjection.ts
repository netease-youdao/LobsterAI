import type { RemoteArtifactManifest } from '../../shared/remote/files';

export interface ArtifactProjectionJob {
  localArtifactId: string; artifactId?: string; name: string; sizeBytes?: string; messageId?: string; reason?: string;
  references: Record<string, { latest: NonNullable<RemoteArtifactManifest['latest']>; pinned: boolean }>;
}
export const remoteArtifactReasons = new Set(['FILE_TOO_LARGE', 'FILE_TYPE_NOT_ALLOWED', 'FILE_CONTENT_INVALID', 'ARTIFACT_COUNT_LIMIT', 'TASK_FILE_QUOTA_EXCEEDED',
  'ACCOUNT_FILE_QUOTA_EXCEEDED', 'ACCOUNT_FILE_COUNT_LIMIT', 'UPLOAD_DAILY_QUOTA_EXCEEDED', 'FILE_SOURCE_CHANGED', 'FILE_TRANSFER_BUSY',
  'NOS_PRIVATE_STORAGE_UNAVAILABLE', 'FINAL_SNAPSHOT_UNAVAILABLE', 'FILE_MISSING']);
export function projectRemoteArtifacts(jobs: ArtifactProjectionJob[], messageId: string): Array<{ localArtifactId: string; block: Record<string, unknown> }> {
  return jobs.flatMap((job): Array<{ localArtifactId: string; block: Record<string, unknown> }> => {
    const reference = job.references[messageId];
    if (!reference || !job.artifactId) return job.messageId === messageId && job.reason && remoteArtifactReasons.has(job.reason)
      ? [{ localArtifactId: job.localArtifactId, block: { type: 'artifact', artifactId: job.artifactId || job.localArtifactId,
        name: job.name, mimeType: 'application/octet-stream', sizeBytes: job.sizeBytes || null, availability: 'desktop_only', reason: job.reason } }] : [];
    // Local capture failures remain on the job; published references cannot carry a failure reason.
    return [{ localArtifactId: job.localArtifactId, block: { type: 'artifact', artifactId: job.artifactId,
      name: reference.pinned ? reference.latest.fileName || job.name : job.name, mimeType: reference.latest.mimeType,
      sizeBytes: reference.latest.sizeBytes, availability: 'ready', artifactVersion: reference.latest.artifactVersion,
      assetId: reference.latest.assetId, assetVersion: reference.latest.assetVersion, referenceMode: reference.pinned ? 'pinned' : 'latest' } }];
  });
}
