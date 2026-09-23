import { createHash } from 'crypto';
import { createReadStream, promises as fs } from 'fs';

import type { RemoteOwner } from '../../shared/remote/constants';
import type { RemoteInputAsset } from '../../shared/remote/input';
import { RemoteFileRequestError } from './remoteFileRetry';
import { requestRemoteFilePart } from './remoteFileTransferLog';

export interface DesktopMessageAssetJob {
  owner: RemoteOwner;
  deviceId: string;
  sessionId: string;
  messageId: string;
  path: string;
  fileName: string;
  mimeType: string;
  intent: 'file' | 'image';
  uploadRequestId: string;
  assetId?: string | null;
  sha256?: string;
  sizeBytes?: string;
  fileIdentity?: { dev: string | number; ino: string | number; mtimeMs: number; sizeBytes: string };
}
export interface DesktopMessageAssetUploadDependencies {
  /** Full fixed remote API path. The bridge adds JWT and the device credential. */
  request(path: string, init: RequestInit): Promise<Response>;
  current(): boolean;
  /** Called only after a new part has a validated receipt, never for an idempotent status query. */
  progress?(): void;
  /** Synchronous transaction in the same owner scope. Never overwrite immutable source fields. */
  persist(patch: Partial<DesktopMessageAssetJob> & { availability?: 'uploading' }): void;
}
export class DesktopMessageAssetUploadError extends Error {
  constructor(readonly reason: 'ASSET_FILE_CHANGED' | 'ASSET_MISSING' | 'ASSET_UPLOAD_FAILED' | 'ASSET_EXPIRED' | 'ACCESS_DENIED') {
    super(reason); this.name = 'DesktopMessageAssetUploadError';
  }
}
const maximumBytes = 100 * 1024 * 1024;
const safeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(value);
const fail = (reason: ConstructorParameters<typeof DesktopMessageAssetUploadError>[0]): never => { throw new DesktopMessageAssetUploadError(reason); };

/** One durable job, no independent retry timer. The bridge owns scheduling and completed projection. */
export function uploadDesktopMessageAsset(job: DesktopMessageAssetJob, deps: DesktopMessageAssetUploadDependencies): Promise<RemoteInputAsset>;
export function uploadDesktopMessageAsset(job: DesktopMessageAssetJob, deps: DesktopMessageAssetUploadDependencies, options: { partBudget: number }): Promise<RemoteInputAsset | null>;
export async function uploadDesktopMessageAsset(job: DesktopMessageAssetJob, deps: DesktopMessageAssetUploadDependencies,
  options?: { partBudget: number }): Promise<RemoteInputAsset | null> {
  const budget = options ? Math.max(1, Math.floor(options.partBudget) || 1) : Number.POSITIVE_INFINITY;
  const check = (): void => { if (!deps.current()) fail('ACCESS_DENIED'); };
  check();
  if (!safeId(job.deviceId) || !safeId(job.sessionId) || !safeId(job.messageId)
      || !/^[a-f0-9-]{36}$/iu.test(job.uploadRequestId) || !job.fileName || /[/\\\u0000-\u001f]/u.test(job.fileName) || job.fileName.length > 255) fail('ASSET_UPLOAD_FAILED');
  const initial = await fs.stat(job.path).catch(() => fail('ASSET_MISSING')); check();
  if (!initial.isFile() || initial.size < 1 || initial.size > maximumBytes) fail('ASSET_UPLOAD_FAILED');
  if (job.fileIdentity && (String(initial.dev) !== String(job.fileIdentity.dev) || String(initial.ino) !== String(job.fileIdentity.ino) || initial.mtimeMs !== job.fileIdentity.mtimeMs || String(initial.size) !== job.fileIdentity.sizeBytes)) fail('ASSET_FILE_CHANGED');
  const unchanged = async (): Promise<void> => {
    check(); const value = await fs.stat(job.path).catch(() => fail('ASSET_MISSING')); check();
    if (!value.isFile() || value.dev !== initial.dev || value.ino !== initial.ino || value.size !== initial.size || value.mtimeMs !== initial.mtimeMs) fail('ASSET_FILE_CHANGED');
  };
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(job.path, { highWaterMark: 64 * 1024 })) { check(); hash.update(chunk); }
  await unchanged();
  const sha256 = hash.digest('hex'), sizeBytes = String(initial.size);
  if (job.sha256 && job.sha256 !== sha256 || job.sizeBytes && job.sizeBytes !== sizeBytes) fail('ASSET_FILE_CHANGED');
  check(); deps.persist({ sha256, sizeBytes, availability: 'uploading' });
  const request = async (path: string, init: RequestInit): Promise<Record<string, unknown>> => {
    check();
    const response = await requestRemoteFilePart(path, init, () => deps.request(path, { ...init, redirect: 'error', signal: AbortSignal.timeout(120_000) }))
      .catch((error: unknown) => { throw new RemoteFileRequestError(error instanceof Error ? error.message : 'ASSET_UPLOAD_FAILED'); });
    check();
    let envelope: { code?: number; data?: Record<string, unknown> };
    try { envelope = await response.json() as typeof envelope; } catch {
      if (!response.ok) throw new RemoteFileRequestError('ASSET_UPLOAD_FAILED', response.status, response.headers.get('Retry-After'));
      return fail('ASSET_UPLOAD_FAILED');
    }
    check();
    if (response.status === 401 || response.status === 403) fail('ACCESS_DENIED');
    if (response.status === 410 || envelope.code === 47062) fail('ASSET_EXPIRED');
    if (!response.ok || envelope.code !== 0 || !envelope.data) throw new RemoteFileRequestError('ASSET_UPLOAD_FAILED', response.status, response.headers.get('Retry-After'), typeof envelope.data?.reason === 'string' ? envelope.data.reason : undefined);
    return envelope.data;
  };
  const jsonPost = (path: string, body: unknown): Promise<Record<string, unknown>> => request(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  let asset = await jsonPost(`/api/remote/v1/devices/${encodeURIComponent(job.deviceId)}/input-assets`, {
    uploadRequestId: job.uploadRequestId, source: 'desktop_message', sessionId: job.sessionId, messageId: job.messageId,
    fileName: job.fileName, mimeType: job.mimeType, sizeBytes, sha256,
  });
  if (!safeId(asset.assetId) || asset.version !== '1' || asset.sha256 !== sha256 || asset.sizeBytes !== sizeBytes
      || job.assetId && job.assetId !== asset.assetId) fail('ASSET_UPLOAD_FAILED');
  const assetId = asset.assetId as string;
  check(); deps.persist({ assetId });
  if (asset.status !== 'ready') {
    const partBytes = Number(asset.partBytes), partCount = Number(asset.partCount);
    if (!Number.isInteger(partBytes) || partBytes < 1 || partBytes > 8 * 1024 * 1024
        || partCount !== Math.ceil(initial.size / partBytes) || !Array.isArray(asset.completedParts)) fail('ASSET_UPLOAD_FAILED');
    if ((asset.completedParts as unknown[]).some(value => !Number.isInteger(value) || Number(value) < 1 || Number(value) > partCount)) fail('ASSET_UPLOAD_FAILED');
    const completed = new Set(asset.completedParts as number[]);
    let sent = 0;
    const handle = await fs.open(job.path, 'r');
    try {
      check();
      for (let partNo = 1; partNo <= partCount; partNo++) {
        await unchanged();
        if (completed.has(partNo)) continue;
        if (sent >= budget) return null;
        const position = (partNo - 1) * partBytes, length = Math.min(partBytes, initial.size - position);
        const bytes = new Uint8Array(length);
        let filled = 0;
        while (filled < length) {
          check(); const result = await handle.read(bytes, filled, length - filled, position + filled); check();
          if (!result.bytesRead) fail('ASSET_FILE_CHANGED'); filled += result.bytesRead;
        }
        await unchanged();
        const partHash = createHash('sha256').update(bytes).digest('hex');
        // Electron computes Content-Length from these fixed bytes; setting it manually rejects net.fetch.
        const receipt = await request(`/api/remote/v1/input-assets/${encodeURIComponent(assetId)}/parts/${partNo}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Content-SHA256': partHash }, body: bytes.buffer,
        });
        if (receipt.assetId !== assetId || receipt.partNo !== partNo || receipt.sha256 !== partHash || receipt.status !== 'ready') fail('ASSET_UPLOAD_FAILED');
        sent++; deps.progress?.();
      }
    } finally { await handle.close(); }
    await unchanged();
    asset = await jsonPost(`/api/remote/v1/input-assets/${encodeURIComponent(assetId)}/complete`, { sha256 });
  }
  await unchanged();
  if (asset.status !== 'ready' || asset.assetId !== assetId || asset.version !== '1' || asset.sha256 !== sha256
      || asset.sizeBytes !== sizeBytes || asset.fileName !== job.fileName || typeof asset.mimeType !== 'string') fail('ASSET_UPLOAD_FAILED');
  return { assetId, version: '1', fileName: job.fileName, mimeType: asset.mimeType as string, sizeBytes, sha256, intent: job.intent };
}
