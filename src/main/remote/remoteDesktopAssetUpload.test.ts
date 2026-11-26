import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type DesktopMessageAssetJob, type DesktopMessageAssetUploadDependencies,uploadDesktopMessageAsset } from './remoteDesktopAssetUpload';

let folder: string;
beforeEach(async () => { folder = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-input-upload-')); });
afterEach(async () => { await fs.rm(folder, { recursive: true, force: true }); });
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const ok = (data: unknown): Response => new Response(JSON.stringify({ code: 0, data }), { status: 200 });
async function fixture(): Promise<{ job: DesktopMessageAssetJob; deps: DesktopMessageAssetUploadDependencies; calls: string[]; parts: Map<number, Uint8Array>; setCurrent(value: boolean): void }> {
  const bytes = Buffer.from('abcdefg'); const file = path.join(folder, 'report.txt'); await fs.writeFile(file, bytes);
  const job: DesktopMessageAssetJob = { owner: { userId: '7', scopeKey: 'personal' }, deviceId: 'pc', sessionId: 'session', messageId: 'message', path: file, fileName: 'report.txt', mimeType: 'application/octet-stream', intent: 'file', uploadRequestId: randomUUID() };
  const calls: string[] = []; const parts = new Map<number, Uint8Array>(); let current = true;
  const asset = { assetId: 'asset', version: '1', status: 'uploading', sha256: sha(bytes), sizeBytes: '7', fileName: 'report.txt', mimeType: 'application/octet-stream', partBytes: '3', partCount: 3, completedParts: [] as number[] };
  const deps: DesktopMessageAssetUploadDependencies = {
    current: () => current,
    persist: patch => { Object.assign(job, patch); },
    request: async (url, init) => {
      calls.push(url);
      if (url.endsWith('/input-assets')) { const body = JSON.parse(String(init.body)); expect(body.source).toBe('desktop_message'); expect(body.sessionId).toBe('session'); expect(body.messageId).toBe('message'); expect(body.sha256).toBe(asset.sha256); return ok({ ...asset, completedParts: [...parts.keys()] }); }
      if (url.includes('/parts/')) {
        expect(init.method).toBe('PUT'); expect(init.body).toBeInstanceOf(ArrayBuffer);
        const partNo = Number(url.split('/').pop()), part = new Uint8Array(init.body as ArrayBuffer);
        const headers = new Headers(init.headers);
        expect(headers.has('Content-Length')).toBe(false);
        expect(headers.get('Content-Type')).toBe('application/octet-stream');
        expect(headers.get('X-Content-SHA256')).toBe(sha(part));
        expect(Buffer.from(part)).toEqual(bytes.subarray((partNo - 1) * 3, partNo * 3));
        parts.set(partNo, part);
        return ok({ assetId: 'asset', partNo, status: 'ready', sha256: sha(part) });
      }
      expect(parts.size).toBe(3); return ok({ ...asset, status: 'ready' });
    },
  };
  return { job, deps, calls, parts, setCurrent: value => { current = value; } };
}
describe('desktop message private asset uploads', () => {
  it('uploads exact bounded ArrayBuffer parts without manual Content-Length and returns safe metadata', async () => {
    const f = await fixture(); const asset = await uploadDesktopMessageAsset(f.job, f.deps);
    expect(f.calls).toEqual(['/api/remote/v1/devices/pc/input-assets', '/api/remote/v1/input-assets/asset/parts/1', '/api/remote/v1/input-assets/asset/parts/2', '/api/remote/v1/input-assets/asset/parts/3', '/api/remote/v1/input-assets/asset/complete']);
    expect(asset).toMatchObject({ assetId: 'asset', version: '1', intent: 'file', fileName: 'report.txt', sizeBytes: '7' });
    expect('path' in asset).toBe(false); expect(f.job.assetId).toBe('asset');
    expect([...f.parts.values()].map(part => part.byteLength)).toEqual([3, 3, 1]);
    expect(Buffer.concat([...f.parts.values()])).toEqual(Buffer.from('abcdefg'));
  });
  it('reuses uploadRequestId and skips acknowledged parts after a lost response', async () => {
    const f = await fixture(); const original = f.deps.request; let failOnce = true;
    f.deps.request = async (url, init) => { const value = await original(url, init); if (url.endsWith('/parts/2') && failOnce) { failOnce = false; throw new Error('connection lost'); } return value; };
    await expect(uploadDesktopMessageAsset(f.job, f.deps)).rejects.toThrow('connection lost');
    const requestId = f.job.uploadRequestId; f.calls.length = 0;
    await uploadDesktopMessageAsset(f.job, f.deps);
    expect(f.job.uploadRequestId).toBe(requestId); expect(f.calls).not.toContain('/api/remote/v1/input-assets/asset/parts/1'); expect(f.calls).not.toContain('/api/remote/v1/input-assets/asset/parts/2');
  });
  it('yields after one part and resumes the same upload using authoritative completed parts', async () => {
    const f = await fixture(), requestId = f.job.uploadRequestId;
    expect(await uploadDesktopMessageAsset(f.job, f.deps, { partBudget: 1 })).toBeNull();
    expect([...f.parts.keys()]).toEqual([1]);
    expect(f.calls.some(url => url.endsWith('/complete'))).toBe(false);
    const restored = JSON.parse(JSON.stringify(f.job));
    expect(await uploadDesktopMessageAsset(restored, f.deps, { partBudget: 1 })).toBeNull();
    expect([...f.parts.keys()]).toEqual([1, 2]);
    expect(await uploadDesktopMessageAsset(f.job, f.deps, { partBudget: 1 })).toMatchObject({ assetId: 'asset' });
    expect([...f.parts.keys()]).toEqual([1, 2, 3]);
    expect(f.job.uploadRequestId).toBe(requestId);
    expect(f.calls.filter(url => url.includes('/parts/'))).toHaveLength(3);
  });
  it('keeps the original request identity when a time-sliced part succeeds but its reply is lost', async () => {
    const f = await fixture(), original = f.deps.request, requestId = f.job.uploadRequestId;
    let lost = false;
    f.deps.request = async (url, init) => {
      const response = await original(url, init);
      if (url.endsWith('/parts/1') && !lost) { lost = true; throw new Error('lost reply'); }
      return response;
    };
    await expect(uploadDesktopMessageAsset(f.job, f.deps, { partBudget: 1 })).rejects.toThrow('lost reply');
    expect(await uploadDesktopMessageAsset(f.job, f.deps, { partBudget: 1 })).toBeNull();
    expect([...f.parts.keys()]).toEqual([1, 2]);
    expect(f.calls.filter(url => url.endsWith('/parts/1'))).toHaveLength(1);
    expect(f.job.uploadRequestId).toBe(requestId);
  });
  it('stops before persisting or making requests after account/session authorization changes', async () => {
    const f = await fixture(); f.setCurrent(false);
    await expect(uploadDesktopMessageAsset(f.job, f.deps)).rejects.toMatchObject({ reason: 'ACCESS_DENIED' });
    expect(f.calls).toEqual([]); expect(f.job.assetId).toBeUndefined();
  });
  it('rejects a changed original rather than uploading it with the old manifest', async () => {
    const f = await fixture(); f.job.sha256 = sha(Buffer.from('original'));
    await expect(uploadDesktopMessageAsset(f.job, f.deps)).rejects.toMatchObject({ reason: 'ASSET_FILE_CHANGED' }); expect(f.calls).toEqual([]);
  });
  it('does not complete or publish after authorization is revoked during an upload', async () => {
    const f = await fixture(); const original = f.deps.request;
    f.deps.request = async (url, init) => { const response = await original(url, init); if (url.endsWith('/parts/1')) f.setCurrent(false); return response; };
    await expect(uploadDesktopMessageAsset(f.job, f.deps)).rejects.toMatchObject({ reason: 'ACCESS_DENIED' }); expect(f.calls).not.toContain('/api/remote/v1/input-assets/asset/complete');
  });
});
