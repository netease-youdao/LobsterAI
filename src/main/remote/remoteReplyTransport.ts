import { createHash, type Hash } from 'crypto';

import type { RemoteReplyUpload as ReplyContentUpload } from '../../shared/remote/reply';
import { RemoteTaskDataError } from './remoteTaskSyncState';

interface ReplyUploadOptions {
  sessionId: string;
  deviceId: string;
  scope: string;
  uploads: ReplyContentUpload[];
  publicationId?: string;
  transport(): Record<string, string>;
  current(): boolean;
  api(path: string, method: string, body: unknown): Promise<any>;
}
interface ReplyValidation { content: number; chunks: number; size: number; digest: Hash; complete: boolean }
interface ReplyProgress { content: number; chunk: number; fingerprint: string; validation?: ReplyValidation }
const MAX_VALIDATED_CHUNKS_PER_SLICE = 8;
const publicationFingerprint = (uploads: ReplyContentUpload[]): string => createHash('sha256').update(JSON.stringify(uploads.map(content => [
  content.contentId, content.version, content.messageId, content.blockId, content.format, content.sizeBytes, content.sha256,
  content.chunks.map(chunk => [chunk.sha256, chunk.sizeBytes]),
]))).digest('hex');

/** Only immutable bytes are uploaded here. A later sync commit publishes their references. */
export class RemoteReplyTransport {
  private readonly chunks = new Map<string, number>();
  private readonly progress = new Map<string, ReplyProgress>();
  clear(): void { this.chunks.clear(); this.progress.clear(); }
  async upload(options: ReplyUploadOptions, maxRequests = Number.POSITIVE_INFINITY): Promise<boolean> {
    const progressKey = options.publicationId ? JSON.stringify([options.scope, options.sessionId, options.publicationId]) : null;
    let requests = 0, validatedChunks = 0;
    const finite = Number.isFinite(maxRequests);
    const fingerprint = publicationFingerprint(options.uploads);
    const cursor: ReplyProgress = progressKey ? this.progress.get(progressKey) || { content: 0, chunk: 0, fingerprint } : { content: 0, chunk: 0, fingerprint };
    if (cursor.fingerprint !== fingerprint) throw new RemoteTaskDataError('Immutable reply publication changed');
    if (progressKey && !this.progress.has(progressKey)) {
      if (this.progress.size >= 256) this.progress.delete(this.progress.keys().next().value!);
      this.progress.set(progressKey, cursor);
    }
    const assertCurrent = (): void => { if (!options.current()) throw new Error('Reply synchronization context changed'); };
    const base = `/sessions/${encodeURIComponent(options.sessionId)}/contents`;
    const complete = new Set<string>();
    for (; cursor.content < options.uploads.length; cursor.content++) {
      const content = options.uploads[cursor.content];
      assertCurrent();
      const key = `${content.contentId}:${content.version}`;
      if (complete.has(key)) continue;
      const validation = cursor.validation?.content === cursor.content ? cursor.validation
        : { content: cursor.content, chunks: 0, size: 0, digest: createHash('sha256'), complete: false };
      cursor.validation = validation;
      const validateChunk = (index: number): void => {
        const chunk = content.chunks[index];
        const bytes = Buffer.from(chunk.text, 'utf8');
        if (String(bytes.length) !== chunk.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== chunk.sha256) {
          throw new RemoteTaskDataError('Invalid local reply content chunk', true);
        }
        // Unknown HTTP outcomes replay the same chunk without hashing it twice into the manifest.
        if (validation.chunks === index) { validation.digest.update(bytes); validation.size += bytes.length; validation.chunks++; }
        validatedChunks++;
      };
      const validateManifest = (): void => {
        if (validation.complete) return;
        if (validation.chunks !== content.chunks.length || String(validation.size) !== content.sizeBytes
          || validation.digest.copy().digest('hex') !== content.sha256) throw new RemoteTaskDataError('Invalid local reply content manifest', true);
        validation.complete = true;
      };
      // Preserve legacy unlimited-call validation before the first request. Finite calls hash
      // each immutable chunk as it is visited, retaining only a small digest state across slices.
      if (!finite) { for (let index = 0; index < content.chunks.length; index++) validateChunk(index); validateManifest(); }
      for (; cursor.chunk < content.chunks.length; cursor.chunk++) {
        const chunk = content.chunks[cursor.chunk];
        assertCurrent();
        if (finite) {
          if (requests >= maxRequests || validatedChunks >= MAX_VALIDATED_CHUNKS_PER_SLICE) return false;
          validateChunk(cursor.chunk);
          if (validation.chunks === content.chunks.length) validateManifest();
        }
        const cacheKey = `${options.scope}:${options.sessionId}:${chunk.sha256}`;
        if ((this.chunks.get(cacheKey) || 0) <= Date.now()) {
          if (requests >= maxRequests) return false;
          requests++;
          const ack = await options.api(`${base}/chunks/${chunk.sha256}`, 'PUT', {
            deviceId: options.deviceId, ...options.transport(), text: chunk.text,
          });
          assertCurrent();
          if (ack.sha256 !== chunk.sha256 || String(ack.sizeBytes) !== chunk.sizeBytes) throw new RemoteTaskDataError('Reply chunk acknowledgement mismatch');
          if (this.chunks.size >= 1024) this.chunks.delete(this.chunks.keys().next().value!);
          this.chunks.set(cacheKey, Date.now() + 30_000);
        }
      }
      validateManifest();
      if (requests >= maxRequests) return false;
      requests++;
      const ack = await options.api(`${base}/${encodeURIComponent(content.contentId)}/versions/${encodeURIComponent(content.version)}`, 'PUT', {
        deviceId: options.deviceId, ...options.transport(), messageId: content.messageId, blockId: content.blockId,
        format: content.format, sizeBytes: content.sizeBytes, sha256: content.sha256,
        chunks: content.chunks.map(({ sha256, sizeBytes }) => ({ sha256, sizeBytes })),
      });
      assertCurrent();
      if (ack.contentId !== content.contentId || String(ack.version) !== content.version || String(ack.sizeBytes) !== content.sizeBytes
        || ack.sha256 !== content.sha256 || ack.format !== content.format) throw new RemoteTaskDataError('Reply manifest acknowledgement mismatch');
      complete.add(key); cursor.chunk = 0; delete cursor.validation;
    }
    // Completing a manifest uses this slice; the next call can publish its reference without another HTTP upload.
    return !Number.isFinite(maxRequests) || requests === 0;
  }
}
