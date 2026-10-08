import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { MAX_REVIEW_SOURCE_BYTES, ReviewSourceReason, type ReviewSourceRequest, type ReviewSourceResponse,ReviewSourceStatus } from '../../shared/artifactPreview/reviewSource';
import { artifactContentRevision } from '../../shared/artifactPreview/workspace';
import { buildWorkspaceChangesArtifact } from '../../shared/artifactPreview/workspaceChanges';
import { parseWorkspaceDiff, type WorkspaceDiffFile } from '../../shared/artifactPreview/workspaceDiff';
import { readEnvironmentSnapshot } from './environmentSnapshot';

const exec = promisify(execFile);
const MAX_CACHE_BYTES = 16_000_000;
const MAX_CACHE_FILES = 32;
const unavailable = (input: ReviewSourceRequest, reason: typeof ReviewSourceReason[keyof typeof ReviewSourceReason]): ReviewSourceResponse => ({ ...input, status: ReviewSourceStatus.Unavailable, reason });
class SourceUnavailable extends Error {
  constructor(readonly reason: typeof ReviewSourceReason[keyof typeof ReviewSourceReason]) { super(reason); }
}
const decode = (bytes: Buffer): string => {
  if (bytes.includes(0)) throw new SourceUnavailable(ReviewSourceReason.Binary);
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new SourceUnavailable(ReviewSourceReason.Unsupported); }
};

export async function readWorktreeFile(root: string, name: string): Promise<string> {
  root = path.resolve(root);
  const absolute = path.resolve(root, name);
  if (!absolute.startsWith(root + path.sep)) throw new SourceUnavailable(ReviewSourceReason.Unsupported);
  // Validate parent components as well as O_NOFOLLOW on the final component.
  // A replaced directory symlink must not turn a repo-relative lookup into an arbitrary read.
  const parent = await realpath(path.dirname(absolute));
  if (parent !== root && !parent.startsWith(root + path.sep)) throw new SourceUnavailable(ReviewSourceReason.Unsupported);
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) return decode(await readlink(absolute, { encoding: 'buffer' }));
  if (!info.isFile()) throw new SourceUnavailable(ReviewSourceReason.Unsupported);
  if (info.size > MAX_REVIEW_SOURCE_BYTES) throw new SourceUnavailable(ReviewSourceReason.TooLarge);
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.ino !== info.ino || before.dev !== info.dev) throw new SourceUnavailable(ReviewSourceReason.RevisionMismatch);
    const bytes = Buffer.alloc(MAX_REVIEW_SOURCE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > MAX_REVIEW_SOURCE_BYTES) throw new SourceUnavailable(ReviewSourceReason.TooLarge);
    const after = await handle.stat();
    const current = await lstat(absolute);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || current.ino !== before.ino || current.dev !== before.dev || current.isSymbolicLink()
      || await realpath(path.dirname(absolute)) !== parent) throw new SourceUnavailable(ReviewSourceReason.RevisionMismatch);
    return decode(bytes.subarray(0, length));
  } finally { await handle.close(); }
}

export async function readGitFile(root: string, baseRevision: string, name: string): Promise<string> {
  const object = `${baseRevision}:${name}`;
  const opts = { cwd: root, timeout: 10_000, maxBuffer: MAX_REVIEW_SOURCE_BYTES + 1, windowsHide: true };
  const { stdout: size } = await exec('git', ['cat-file', '-s', object], opts);
  if (Number(size.trim()) > MAX_REVIEW_SOURCE_BYTES) throw new SourceUnavailable(ReviewSourceReason.TooLarge);
  const { stdout } = await exec('git', ['cat-file', 'blob', object], { ...opts, encoding: 'buffer' });
  return decode(stdout);
}

export function matchesPatch(file: WorkspaceDiffFile, oldSource: string, newSource: string): boolean {
  const before = oldSource.split('\n'); const after = newSource.split('\n');
  const equal = (actual: string | undefined, expected: string) => actual !== undefined && actual.replace(/\r$/, '') === expected.replace(/\r$/, '');
  return file.hunks.every(hunk => hunk.lines.every(line =>
    (line.oldNumber === null || equal(before[line.oldNumber - 1], line.content))
    && (line.newNumber === null || equal(after[line.newNumber - 1], line.content))));
}

/** Only complete, version-matched source reaches the syntax worker. No source is persisted. */
export class WorkspaceReviewSourceStore {
  private readonly cache = new Map<string, { value: ReviewSourceResponse; bytes: number }>();
  private cacheBytes = 0;
  private readonly pending = new Map<string, Promise<ReviewSourceResponse>>();
  private readonly snapshots = new Map<string, ReturnType<typeof readEnvironmentSnapshot>>();
  private activeLoads = 0;
  private readonly loadQueue: Array<() => void> = [];
  constructor(private readonly getCwd: (sessionId: string) => string | undefined,
    private readonly snapshot = readEnvironmentSnapshot) {}

  async read(input: ReviewSourceRequest): Promise<ReviewSourceResponse> {
    if (!input || [input.sessionId, input.artifactId, input.revision, input.fileId].some(value => typeof value !== 'string' || !value || value.length > 4096)) throw new Error('Invalid review source request');
    const cwd = this.getCwd(input.sessionId);
    if (!cwd || input.artifactId !== `environment-changes:${input.sessionId}`) return unavailable(input, ReviewSourceReason.NotFound);
    const key = JSON.stringify([cwd, input.sessionId, input.artifactId, input.revision, input.fileId]);
    const cached = this.cache.get(key);
    if (cached) { this.cache.delete(key); this.cache.set(key, cached); return cached.value; }
    const pending = this.pending.get(key);
    if (pending) return pending;
    if (this.pending.size >= 32) return unavailable(input, ReviewSourceReason.TooLarge);
    const task = this.loadBounded(input, cwd).then(value => {
      if (value.status === ReviewSourceStatus.Ready && this.getCwd(input.sessionId) === cwd) {
        const bytes = Buffer.byteLength(value.oldSource) + Buffer.byteLength(value.newSource);
        this.cache.set(key, { value, bytes }); this.cacheBytes += bytes;
        while (this.cache.size > MAX_CACHE_FILES || this.cacheBytes > MAX_CACHE_BYTES) {
          const oldest = this.cache.keys().next().value!;
          this.cacheBytes -= this.cache.get(oldest)!.bytes; this.cache.delete(oldest);
        }
      }
      return value;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }

  private readSnapshot(cwd: string): ReturnType<typeof readEnvironmentSnapshot> {
    const current = this.snapshots.get(cwd);
    if (current) return current;
    const request = this.snapshot(cwd).finally(() => this.snapshots.delete(cwd));
    this.snapshots.set(cwd, request);
    return request;
  }

  private async loadBounded(input: ReviewSourceRequest, cwd: string): Promise<ReviewSourceResponse> {
    if (this.activeLoads >= 6) await new Promise<void>(resolve => this.loadQueue.push(resolve));
    else this.activeLoads += 1;
    try { return await this.load(input, cwd); }
    finally { const next = this.loadQueue.shift(); if (next) next(); else this.activeLoads -= 1; }
  }

  private async load(input: ReviewSourceRequest, cwd: string): Promise<ReviewSourceResponse> {
    try {
      const snapshot = await this.readSnapshot(cwd);
      const version = () => artifactContentRevision(buildWorkspaceChangesArtifact(input.sessionId, '', snapshot));
      if (snapshot.truncated) return unavailable(input, ReviewSourceReason.TooLarge);
      if (!snapshot.isGitRepository) return unavailable(input, ReviewSourceReason.NotFound);
      if (version() !== input.revision) return unavailable(input, ReviewSourceReason.RevisionMismatch);
      const file = parseWorkspaceDiff(snapshot.diff).files.find(file => file.id === input.fileId);
      if (!file || !snapshot.changedFiles.some(item => item.path === file.path)) return unavailable(input, ReviewSourceReason.NotFound);
      if (file.binary) return unavailable(input, ReviewSourceReason.Binary);
      const oldPath = file.oldPath ?? file.path; const newPath = file.path;
      const root = await realpath(snapshot.cwd);
      const [oldSource, newSource] = await Promise.all([
        file.status === 'added' || !snapshot.baseRevision ? '' : readGitFile(root, snapshot.baseRevision, oldPath),
        file.status === 'deleted' ? '' : readWorktreeFile(root, newPath),
      ]);
      if (!matchesPatch(file, oldSource, newSource)) return unavailable(input, ReviewSourceReason.RevisionMismatch);
      // Verification must start after this file's complete read. Another file's
      // in-flight snapshot may have captured the workspace before that read.
      const current = await this.snapshot(cwd);
      if (this.getCwd(input.sessionId) !== cwd || artifactContentRevision(buildWorkspaceChangesArtifact(input.sessionId, '', current)) !== input.revision) return unavailable(input, ReviewSourceReason.RevisionMismatch);
      return { ...input, status: ReviewSourceStatus.Ready, path: file.path, oldPath, newPath, oldSource, newSource };
    } catch (error) {
      return unavailable(input, error instanceof SourceUnavailable ? error.reason : ReviewSourceReason.NotFound);
    }
  }
}
