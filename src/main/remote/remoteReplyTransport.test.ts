import { createHash } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RemoteReplyUpload as ReplyContentUpload } from '../../shared/remote/reply';
import { RemoteReplyTransport } from './remoteReplyTransport';

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const text = '中文🙂 stream';
const chunk = { text, sizeBytes: String(Buffer.byteLength(text)), sha256: hash(text) };
const content: ReplyContentUpload = { contentId: 'body', version: '2', messageId: 'message', blockId: 'block', format: 'text',
  sizeBytes: chunk.sizeBytes, sha256: chunk.sha256, chunks: [chunk] };
const setup = () => {
  const api = vi.fn(async (path: string, _method: string, body: any) => path.includes('/chunks/')
    ? { sha256: hash(body.text), sizeBytes: String(Buffer.byteLength(body.text)) }
    : { contentId: content.contentId, version: content.version, sizeBytes: body.sizeBytes, sha256: body.sha256, format: body.format });
  return { sessionId: 'session', deviceId: 'device', scope: 'owner/environment', uploads: [content],
    transport: () => ({ mode: 'online', connectionGeneration: '3' }), current: () => true, api };
};
const largeContent = (count: number): ReplyContentUpload => {
  const texts = Array.from({ length: count }, (_, index) => `${index}:`.padEnd(32768, 'a'));
  const chunks = texts.map(value => ({ text: value, sizeBytes: String(Buffer.byteLength(value)), sha256: hash(value) }));
  return { ...content, chunks, sizeBytes: String(count * 32768), sha256: hash(texts.join('')) };
};
afterEach(() => { vi.restoreAllMocks(); });
describe('reply body upload', () => {
  it('validates a large reply once across finite slices without retaining its body in the cursor', async () => {
    const options = { ...setup(), publicationId: 'large-reply', uploads: [largeContent(128)] };
    const transport = new RemoteReplyTransport(), buffers = vi.spyOn(Buffer, 'from');
    let finished = false;
    for (let attempt = 0; attempt < 131 && !finished; attempt++) finished = await transport.upload(options, 1);
    expect(finished).toBe(true); expect(options.api).toHaveBeenCalledTimes(129);
    const texts = new Set(options.uploads[0].chunks.map(item => item.text));
    expect(buffers.mock.calls.filter(([value]) => typeof value === 'string' && texts.has(value))).toHaveLength(128);
  });
  it('rejects changed not-yet-uploaded bytes before publishing a manifest', async () => {
    const options = { ...setup(), publicationId: 'immutable-reply', uploads: [largeContent(2)] };
    const transport = new RemoteReplyTransport();
    expect(await transport.upload(options, 1)).toBe(false);
    options.uploads[0].chunks[1].text = 'changed';
    await expect(transport.upload(options, 1)).rejects.toThrow('Invalid local reply content chunk');
    expect(options.api).toHaveBeenCalledTimes(1);
  });
  it('binds finite cursors to the immutable manifest and chunk identities', async () => {
    const options = { ...setup(), publicationId: 'immutable-reply', uploads: [largeContent(2)] };
    const transport = new RemoteReplyTransport();
    await transport.upload(options, 1);
    options.uploads = [largeContent(3)];
    await expect(transport.upload(options, 1)).rejects.toThrow('Immutable reply publication changed');
    expect(options.api).toHaveBeenCalledTimes(1);
  });
  it('replays an uncertain manifest without rehashing all acknowledged chunks', async () => {
    const options = { ...setup(), publicationId: 'uncertain-manifest', uploads: [largeContent(2)] };
    const transport = new RemoteReplyTransport(), buffers = vi.spyOn(Buffer, 'from');
    await transport.upload(options, 1); await transport.upload(options, 1);
    options.api.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(transport.upload(options, 1)).rejects.toThrow('fetch failed');
    expect(await transport.upload(options, 1)).toBe(false);
    expect(options.api.mock.calls[2]).toEqual(options.api.mock.calls[3]);
    expect(await transport.upload(options, 1)).toBe(true);
    const texts = new Set(options.uploads[0].chunks.map(item => item.text));
    expect(buffers.mock.calls.filter(([value]) => typeof value === 'string' && texts.has(value))).toHaveLength(2);
  });
  it('bounds local hashing per slice even when all chunks are recently cached', async () => {
    const options = { ...setup(), uploads: [largeContent(16)] }, transport = new RemoteReplyTransport();
    await transport.upload(options); options.api.mockClear();
    const buffers = vi.spyOn(Buffer, 'from');
    expect(await transport.upload({ ...options, publicationId: 'cached-reply' }, 1)).toBe(false);
    const texts = new Set(options.uploads[0].chunks.map(item => item.text));
    expect(buffers.mock.calls.filter(([value]) => typeof value === 'string' && texts.has(value))).toHaveLength(8);
    expect(options.api).not.toHaveBeenCalled();
  });
  it('uploads verified bytes before an immutable manifest, and reuses recent chunks', async () => {
    const options = setup(); const transport = new RemoteReplyTransport();
    await transport.upload(options);
    expect(options.api.mock.calls.map(call => call[0])).toEqual([
      `/sessions/session/contents/chunks/${chunk.sha256}`, '/sessions/session/contents/body/versions/2',
    ]);
    expect(options.api.mock.calls[1][2].chunks).toEqual([{ sha256: chunk.sha256, sizeBytes: chunk.sizeBytes }]);
    expect(options.api.mock.calls[1][2]).not.toHaveProperty('text');
    await transport.upload(options);
    expect(options.api).toHaveBeenCalledTimes(3);
    await transport.upload({ ...options, scope: 'other-owner/environment' });
    expect(options.api).toHaveBeenCalledTimes(5);
  });
  it('never publishes a manifest after a chunk ACK mismatch', async () => {
    const options = setup(); options.api.mockResolvedValueOnce({ sha256: 'wrong', sizeBytes: chunk.sizeBytes });
    await expect(new RemoteReplyTransport().upload(options)).rejects.toThrow('acknowledgement mismatch');
    expect(options.api).toHaveBeenCalledTimes(1);
  });
  it('stops immediately if identity changes during upload', async () => {
    const options = setup(); let active = true;
    options.current = () => active;
    options.api.mockImplementationOnce(async () => { active = false; return { sha256: chunk.sha256, sizeBytes: chunk.sizeBytes }; });
    await expect(new RemoteReplyTransport().upload(options)).rejects.toThrow('context changed');
    expect(options.api).toHaveBeenCalledTimes(1);
  });
  it('rejects inconsistent cached content before network access', async () => {
    const options = setup(); options.uploads = [{ ...content, sha256: 'incorrect' }];
    await expect(new RemoteReplyTransport().upload(options)).rejects.toThrow('Invalid local reply content manifest');
    expect(options.api).not.toHaveBeenCalled();
  });
  it('rejects a forged manifest receipt', async () => {
    const options = setup();
    options.api.mockResolvedValueOnce({ sha256: chunk.sha256, sizeBytes: chunk.sizeBytes });
    options.api.mockResolvedValueOnce({ contentId: 'other', version: '2', sizeBytes: chunk.sizeBytes, sha256: chunk.sha256 });
    await expect(new RemoteReplyTransport().upload(options)).rejects.toThrow('manifest acknowledgement mismatch');
  });
  it('yields after each request and keeps independent publication cursors', async () => {
    const options = { ...setup(), publicationId: 'original-batch' }, transport = new RemoteReplyTransport();
    expect(await transport.upload(options, 1)).toBe(false);
    expect(options.api).toHaveBeenCalledTimes(1);
    expect(await transport.upload({ ...options, sessionId: 'other-task' }, 1)).toBe(false);
    expect(options.api).toHaveBeenCalledTimes(2);
    expect(await transport.upload(options, 1)).toBe(false);
    expect(options.api).toHaveBeenCalledTimes(3);
    expect(await transport.upload(options, 1)).toBe(true);
    expect(options.api).toHaveBeenCalledTimes(3);
    expect(options.api.mock.calls[2][0]).toBe('/sessions/session/contents/body/versions/2');
  });
  it('replays an unknown chunk outcome using the original hash before advancing', async () => {
    const options = { ...setup(), publicationId: 'fixed-import:0' }, transport = new RemoteReplyTransport();
    options.api.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(transport.upload(options, 1)).rejects.toThrow('fetch failed');
    expect(await transport.upload(options, 1)).toBe(false);
    expect(options.api.mock.calls[0]).toEqual(options.api.mock.calls[1]);
    expect(await transport.upload(options, 1)).toBe(false);
    expect(await transport.upload(options, 1)).toBe(true);
  });
  it('revalidates a publication after transport state is cleared', async () => {
    const options = { ...setup(), publicationId: 'fixed-import:0' }, transport = new RemoteReplyTransport();
    await transport.upload(options, 1); await transport.upload(options, 1);
    expect(await transport.upload(options, 1)).toBe(true);
    transport.clear();
    expect(await transport.upload(options, 1)).toBe(false);
    expect(options.api.mock.calls.at(-1)?.[0]).toBe(`/sessions/session/contents/chunks/${chunk.sha256}`);
  });
});
