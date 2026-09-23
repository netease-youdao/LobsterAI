import { describe, expect, it } from 'vitest';

import { RemoteFileReason } from '../../shared/remote/files';
import { type ArtifactProjectionJob, projectRemoteArtifacts } from './remoteArtifactProjection';

function publishedJob(pinned: boolean, reason?: string): ArtifactProjectionJob {
  return {
    localArtifactId: 'local', artifactId: 'artifact', name: 'current.md', messageId: 'message', reason,
    references: {
      message: {
        pinned,
        latest: {
          artifactVersion: '2', assetId: 'asset', assetVersion: '1', fileName: 'snapshot.md',
          mimeType: 'text/markdown', sizeBytes: '123', sha256: 'a'.repeat(64),
        },
      },
    },
  };
}

describe('remote artifact projection', () => {
  it.each([false, true])('omits local failures from published references (pinned=%s)', (pinned) => {
    for (const reason of [RemoteFileReason.Final, RemoteFileReason.Transfer, '/private/capture-failed', undefined]) {
      const job = publishedJob(pinned, reason);
      const original = structuredClone(job);

      expect(projectRemoteArtifacts([job], 'message')).toEqual([{
        localArtifactId: 'local',
        block: {
          type: 'artifact', artifactId: 'artifact', name: pinned ? 'snapshot.md' : 'current.md',
          mimeType: 'text/markdown', sizeBytes: '123', availability: 'ready', artifactVersion: '2',
          assetId: 'asset', assetVersion: '1', referenceMode: pinned ? 'pinned' : 'latest',
        },
      }]);
      expect(job).toEqual(original);
    }
  });

  it('keeps a final snapshot failure local when only the current version is available', () => {
    const job = publishedJob(false, RemoteFileReason.Final);
    const [projection] = projectRemoteArtifacts([job], 'message');

    expect(projection.block).not.toHaveProperty('reason');
    expect(projection.block.referenceMode).toBe('latest');
    expect(job.reason).toBe(RemoteFileReason.Final);
    expect(job.references.message.pinned).toBe(false);
  });

  it.each([undefined, 'artifact'])('retains a safe reason for an unpublished placeholder (artifactId=%s)', (artifactId) => {
    const job: ArtifactProjectionJob = {
      localArtifactId: 'local', artifactId, name: 'report.md', sizeBytes: '123',
      messageId: 'message', reason: RemoteFileReason.Final, references: {},
    };
    const original = structuredClone(job);

    expect(projectRemoteArtifacts([job], 'message')).toEqual([{
      localArtifactId: 'local',
      block: {
        type: 'artifact', artifactId: artifactId || 'local', name: 'report.md',
        mimeType: 'application/octet-stream', sizeBytes: '123', availability: 'desktop_only',
        reason: RemoteFileReason.Final,
      },
    }]);
    expect(projectRemoteArtifacts([job], 'other-message')).toEqual([]);
    expect(job).toEqual(original);
  });

  it('does not expose unknown local failure details in a placeholder', () => {
    const job: ArtifactProjectionJob = {
      localArtifactId: 'local', name: 'report.md', messageId: 'message',
      reason: '/private/capture-failed', references: {},
    };
    expect(projectRemoteArtifacts([job], 'message')).toEqual([]);
  });
});
