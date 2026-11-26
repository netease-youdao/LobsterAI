import { describe, expect, it } from 'vitest';

import { RemoteFileReason } from '../../shared/remote/files';
import { type ArtifactProjectionJob, hasRemoteArtifactSyncFailure, projectRemoteArtifacts } from './remoteArtifactProjection';

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
  it.each(['make_docx.js', 'RESULT.JSON', 'settings.yaml', 'build.py'])('hides persisted %s outputs without changing publication records', (name) => {
    const pending: ArtifactProjectionJob = {
      localArtifactId: 'local', name, messageId: 'message', reason: RemoteFileReason.Type, references: {},
    };
    const current = publishedJob(false);
    current.name = name;
    const pinned = publishedJob(true);
    pinned.references.message.latest.fileName = name;
    for (const job of [pending, current, pinned]) {
      const original = structuredClone(job);
      expect(projectRemoteArtifacts([job], 'message')).toEqual([{ localArtifactId: 'local', block: null }]);
      expect(projectRemoteArtifacts([job], 'other-message')).toEqual([]);
      expect(job).toEqual(original);
    }
  });

  it.each([
    { pinned: true, current: 'make_docx.js', snapshot: 'report.docx', visible: true },
    { pinned: true, current: 'report.docx', snapshot: 'make_docx.js', visible: false },
    { pinned: false, current: 'make_docx.js', snapshot: 'report.docx', visible: false },
    { pinned: false, current: 'report.docx', snapshot: 'make_docx.js', visible: true },
    { pinned: true, current: 'make_docx.js', snapshot: undefined, visible: false },
    { pinned: true, current: 'report.docx', snapshot: undefined, visible: true },
  ])('uses the displayed version name for card eligibility ($pinned/$current/$snapshot)', ({ pinned, current, snapshot, visible }) => {
    const job = publishedJob(pinned);
    job.name = current;
    job.references.message.latest.fileName = snapshot;
    const result = projectRemoteArtifacts([job], 'message');
    expect(result).toHaveLength(1);
    if (visible) expect(result[0].block?.name).toBe(pinned ? snapshot || current : current);
    else expect(result[0]).toEqual({ localArtifactId: 'local', block: null });
  });

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
    expect(projection.block?.referenceMode).toBe('latest');
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

describe('remote artifact sync health', () => {
  it.each([false, true])('does not treat a ready current reference as pending solely because its final snapshot is unavailable (pinned=%s)', pinned => {
    const job = publishedJob(pinned, RemoteFileReason.Final), original = structuredClone(job);
    expect(hasRemoteArtifactSyncFailure(job, false)).toBe(false);
    expect(hasRemoteArtifactSyncFailure(job, true)).toBe(true);
    expect(job).toEqual(original);
  });

  it.each([0, 123])('keeps an uncaptured local change visible despite an older ready reference (dirtyAt=%s)', dirtyAt => {
    const job = publishedJob(false, RemoteFileReason.Final);
    job.dirtyAt = dirtyAt;
    const original = structuredClone(job);
    expect(hasRemoteArtifactSyncFailure(job, false)).toBe(true);
    expect(job).toEqual(original);
  });

  it('requires a ready reference for the current message, not an older message', () => {
    const job = publishedJob(false, RemoteFileReason.Final);
    job.messageId = 'new-message';
    expect(hasRemoteArtifactSyncFailure(job, false)).toBe(true);
    job.messageId = undefined;
    expect(hasRemoteArtifactSyncFailure(job, false)).toBe(true);
    job.messageId = 'message'; job.artifactId = undefined;
    expect(hasRemoteArtifactSyncFailure(job, false)).toBe(true);
  });

  it.each([RemoteFileReason.Type, RemoteFileReason.Size, RemoteFileReason.Source, RemoteFileReason.Transfer])(
    'keeps a current %s failure visible even when an earlier version is readable', reason => {
      const job = publishedJob(false, reason);
      expect(hasRemoteArtifactSyncFailure(job, false)).toBe(true);
      job.references = {};
      expect(hasRemoteArtifactSyncFailure(job, false)).toBe(true);
    });

  it.each([
    { pinned: true, current: 'report.docx', snapshot: 'make_docx.js', degraded: false },
    { pinned: true, current: 'make_docx.js', snapshot: 'report.docx', degraded: true },
    { pinned: false, current: 'make_docx.js', snapshot: 'report.docx', degraded: false },
    { pinned: false, current: 'report.docx', snapshot: 'make_docx.js', degraded: true },
  ])('uses the displayed version when deciding whether a capture warning is user-visible ($pinned/$current/$snapshot)', sample => {
    const job = publishedJob(sample.pinned, RemoteFileReason.Type);
    job.name = sample.current; job.references.message.latest.fileName = sample.snapshot;
    const original = structuredClone(job);
    expect(hasRemoteArtifactSyncFailure(job, false)).toBe(sample.degraded);
    expect(hasRemoteArtifactSyncFailure(job, true)).toBe(true);
    expect(job).toEqual(original);
  });

  it('ignores a hidden unpublished output without discarding its failure evidence', () => {
    const job: ArtifactProjectionJob = {
      localArtifactId: 'script', name: 'make_docx.js', messageId: 'message', reason: RemoteFileReason.Final, references: {},
    };
    const original = structuredClone(job);
    expect(hasRemoteArtifactSyncFailure(job, false)).toBe(false);
    expect(hasRemoteArtifactSyncFailure(job, true)).toBe(true);
    expect(job).toEqual(original);
    job.name = 'report.docx';
    expect(hasRemoteArtifactSyncFailure(job, false)).toBe(true);
  });

  it('does not convert unknown failures into successful sync or pending work into a failure', () => {
    const job = publishedJob(false, undefined);
    expect(hasRemoteArtifactSyncFailure(job, false)).toBe(false);
    expect(hasRemoteArtifactSyncFailure(job, true)).toBe(false);
    job.reason = 'unknown-capture-error'; job.references = {};
    expect(hasRemoteArtifactSyncFailure(job, false)).toBe(true);
  });
});
