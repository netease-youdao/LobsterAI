import { afterEach, describe, expect, it, vi } from 'vitest';

import { requestRemoteFilePart } from './remoteFileTransferLog';

const artifactPart = '/artifact-uploads/asset-id/parts/0';
const spies = (): { debug: ReturnType<typeof vi.spyOn>; warn: ReturnType<typeof vi.spyOn> } => ({
  debug: vi.spyOn(console, 'debug').mockImplementation(() => undefined),
  warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
});
afterEach(() => vi.restoreAllMocks());

describe('remote file part diagnostics', () => {
  it.each([artifactPart, '/api/remote/v1/input-assets/asset-id/parts/2'])('preserves the response and logs metadata without reading its body (%s)', async pathname => {
    const logs = spies();
    const result = new Response('private response', { status: 200 });
    const read = vi.spyOn(result, 'text');
    const send = vi.fn(async () => result);
    expect(await requestRemoteFilePart(pathname, { method: 'PUT', body: new ArrayBuffer(5),
      headers: { Authorization: 'Bearer private-token' } }, send)).toBe(result);
    expect(send).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled(); expect(result.bodyUsed).toBe(false);
    expect(logs.debug).toHaveBeenLastCalledWith('[RemoteFileSync] Part request completed', {
      kind: pathname.includes('input-assets') ? 'input-assets' : 'artifact-uploads', assetId: 'asset-id',
      partNo: pathname.includes('input-assets') ? 2 : 0, method: 'PUT', requestBytes: 5, elapsedMs: expect.any(Number), status: 200,
    });
    expect(logs.warn).not.toHaveBeenCalled();
    expect(JSON.stringify(logs.debug.mock.calls)).not.toContain('private');
  });

  it('preserves an unsuccessful HTTP response without consuming or logging its contents', async () => {
    const logs = spies(), result = new Response('secret server response', { status: 503 });
    expect(await requestRemoteFilePart(artifactPart, { method: 'PUT' }, async () => result)).toBe(result);
    expect(result.bodyUsed).toBe(false);
    expect(logs.warn).toHaveBeenCalledWith('[RemoteFileSync] Part request failed', expect.objectContaining({ status: 503, requestBytes: null }));
    expect(JSON.stringify(logs.warn.mock.calls)).not.toContain('secret');
  });

  it('unwraps an authentication transport error while redacting messages, headers, body, URL and filename', async () => {
    const logs = spies();
    const originalError = new Error('net::ERR_INVALID_ARGUMENT');
    const error = Object.assign(new Error('secret token at https://private.example/path/document.md'), {
      name: 'AuthSessionRequestError', originalError: new Error('private cause', { cause: originalError }),
    });
    await expect(requestRemoteFilePart(artifactPart, { method: 'PUT', headers: { 'Content-Length': '4', Authorization: 'Bearer secret' },
      body: new ArrayBuffer(4) }, async () => { throw error; })).rejects.toBe(error);
    expect(logs.warn).toHaveBeenCalledWith('[RemoteFileSync] Part request failed', expect.objectContaining({
      status: null, errorName: 'Error', errorCode: 'net::ERR_INVALID_ARGUMENT', requestBytes: 4,
    }));
    const printed = JSON.stringify([...logs.debug.mock.calls, ...logs.warn.mock.calls]);
    for (const secret of ['private', 'secret', 'document.md', 'Content-Length', 'Authorization', 'https://']) expect(printed).not.toContain(secret);
  });

  it('retains only known names and codes, with an exact Chromium error match', async () => {
    const logs = spies();
    const error = { name: 'secret filename', code: 'secret-token', message: 'net::ERR_FAILED https://secret.example' };
    await expect(requestRemoteFilePart(artifactPart, { method: 'PUT' }, async () => { throw error; })).rejects.toBe(error);
    expect(logs.warn).toHaveBeenCalledWith('[RemoteFileSync] Part request failed', expect.objectContaining({ errorName: 'Error', errorCode: null }));
    expect(JSON.stringify(logs.warn.mock.calls)).not.toContain('secret');
    const known = Object.assign(new TypeError('secret'), { code: 'ECONNRESET' });
    await expect(requestRemoteFilePart(artifactPart, { method: 'PUT' }, async () => { throw known; })).rejects.toBe(known);
    expect(logs.warn).toHaveBeenLastCalledWith('[RemoteFileSync] Part request failed', expect.objectContaining({ errorName: 'TypeError', errorCode: 'ECONNRESET' }));
  });

  it('bounds nested or circular error inspection', async () => {
    const logs = spies();
    const error: Record<string, unknown> = { name: 'Error' }; error.cause = error;
    await expect(requestRemoteFilePart(artifactPart, { method: 'PUT' }, async () => { throw error; })).rejects.toBe(error);
    expect(logs.warn).toHaveBeenCalledTimes(1);
    let deep: Error = new Error('net::ERR_FAILED');
    for (let i = 0; i < 4; i++) deep = new Error('private wrapper', { cause: deep });
    await expect(requestRemoteFilePart(artifactPart, { method: 'PUT' }, async () => { throw deep; })).rejects.toBe(deep);
    expect(logs.warn).toHaveBeenLastCalledWith('[RemoteFileSync] Part request failed', expect.objectContaining({ errorCode: null }));
  });

  it.each([
    ['POST', artifactPart], ['PUT', '/input-assets'], ['PUT', '/input-assets/private-file.md/parts/0'],
    ['PUT', '/input-assets/id/parts/0?token=secret'], ['PUT', '/api/remote/v2/input-assets/id/parts/0'],
    ['PUT', 'https://secret.example/input-assets/id/parts/0'],
  ])('passes through unmatched requests without logging (%s %s)', async (method, pathname) => {
    const logs = spies(), result = new Response();
    const send = vi.fn(async () => result);
    expect(await requestRemoteFilePart(pathname, { method }, send)).toBe(result);
    expect(send).toHaveBeenCalledTimes(1); expect(logs.debug).not.toHaveBeenCalled(); expect(logs.warn).not.toHaveBeenCalled();
  });
});
