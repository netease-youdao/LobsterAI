import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { nativeImage } from 'electron';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { imageEditMessageMetadata } from '../../shared/imageEditing/messageSnapshot';
import { type ImageEditMessageSnapshot,ImageEditOperation } from '../../shared/imageEditing/types';
import { ImageEditingService } from './imageEditing';

vi.mock('electron', () => {
  const sized = (bytes: Buffer, width: number, height: number) => {
    const resized = Buffer.from(bytes.subarray(0, 33)); resized.writeUInt32BE(width, 16); resized.writeUInt32BE(height, 20);
    return createFromBuffer(resized);
  };
  // Fake PNGs may carry a white mask rectangle in a private chunk, decoded into a BGRA bitmap.
  const toBitmap = (bytes: Buffer) => {
    const width = bytes.readUInt32BE(16);
    const pixels = Buffer.alloc(width * bytes.readUInt32BE(20) * 4);
    if (bytes.toString('latin1', 37, 41) === 'mRKt') {
      const [x, y, w, h] = [0, 1, 2, 3].map(i => bytes.readUInt32BE(41 + i * 4));
      for (let row = y; row < y + h; row++) pixels.fill(255, (row * width + x) * 4, (row * width + x + w) * 4);
    }
    return pixels;
  };
  const createFromBuffer = (bytes: Buffer): unknown => ({
    getSize: () => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }), isEmpty: () => false, toPNG: () => bytes,
    resize: ({ width, height }: { width: number; height: number }) => {
      const resized = Buffer.from(bytes); resized.writeUInt32BE(width, 16); resized.writeUInt32BE(height, 20);
      return createFromBuffer(resized);
    },
    crop: ({ width, height }: { width: number; height: number }) => sized(bytes, width, height),
    toBitmap: () => toBitmap(bytes),
  });
  const createFromBitmap = (_bitmap: Buffer, { width, height }: { width: number; height: number }) => {
    const header = Buffer.alloc(33); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
    header.writeUInt32BE(13, 8); header.write('IHDR', 12);
    return sized(header, width, height);
  };
  return { nativeImage: { createFromBuffer, createFromBitmap } };
});

function fixture(width = 640, height = 480, mark?: { x: number; y: number; width: number; height: number }) {
  const data = Buffer.alloc(33); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data);
  data.writeUInt32BE(13, 8); data.write('IHDR', 12);
  data.writeUInt32BE(width, 16); data.writeUInt32BE(height, 20);
  if (!mark) return data;
  const chunk = Buffer.alloc(28); chunk.writeUInt32BE(16, 0); chunk.write('mRKt', 4, 'latin1');
  [mark.x, mark.y, mark.width, mark.height].forEach((value, i) => chunk.writeUInt32BE(value, 8 + i * 4));
  return Buffer.concat([data, chunk]);
}
const marked = (width = 640, height = 480) => fixture(width, height, { x: 300, y: 200, width: 40, height: 30 });
const dataUrl = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`;

describe('immutable image versions and edit staging', () => {
  let directory: string;
  let original: string;
  const values = new Map<string, string>();
  const publish = vi.fn();
  const messages = new Map<string, { type: string; metadata: Record<string, unknown> }>();
  const saveMessageMetadata = vi.fn((_sessionId: string, messageId: string, metadata: Record<string, unknown>) => {
    messages.get(messageId)!.metadata = metadata;
  });
  const service = () => new ImageEditingService({ directory: path.join(directory, 'private'),
    getCwd: id => id === 'session' ? directory : undefined,
    get: key => values.has(key) ? JSON.parse(values.get(key)!) : undefined,
    set: (key, value) => { values.set(key, JSON.stringify(value)); }, changed: vi.fn(), publish,
    getMessage: (_sessionId, messageId) => messages.get(messageId) ?? null, saveMessageMetadata });
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lobster-image-edit-test-'));
    original = path.join(directory, 'original.png'); await fs.writeFile(original, fixture()); values.clear(); publish.mockClear();
    messages.clear(); saveMessageMetadata.mockClear();
  });
  afterEach(async () => {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('lobster-image-edit-test-')) throw new Error('Unexpected fixture path');
    await fs.rm(directory, { recursive: true, force: true });
  });
  test('concurrent opens share one immutable source and leave the user file untouched', async () => {
    const edit = service();
    const input = { sessionId: 'session', title: 'original.png', filePath: original };
    const [a, b] = await Promise.all([edit.open(input), edit.open(input)]);
    expect(a.version.id).toBe(b.version.id);
    expect(edit.list({ sessionId: 'session', rootId: a.version.id })).toHaveLength(1);
    expect(a.version.filePath).not.toBe(original);
    await fs.writeFile(original, fixture(800, 600));
    expect((await edit.read({ sessionId: 'session', versionId: a.version.id })).dataUrl).toBe(a.dataUrl);
  });
  test('a queued edit freezes a saved output, and lineage survives service recreation', async () => {
    const edit = service(); const opened = await edit.open({ sessionId: 'session', title: 'original.png', filePath: original });
    const resized = await edit.save({ sessionId: 'session', sourceId: opened.version.id,
      operation: ImageEditOperation.Resize, dataUrl: `data:image/png;base64,${fixture(320, 240).toString('base64')}` });
    expect(publish).toHaveBeenCalledWith(resized);
    const request = await edit.stage({ sessionId: 'session', sourceId: resized.id, operation: ImageEditOperation.RemoveBackground });
    await fs.writeFile(resized.filePath, fixture(960, 720));
    expect((await fs.readFile(request.source.filePath)).readUInt32BE(16)).toBe(320);
    expect(service().resolve('session', request.id)).toEqual(request);
    expect(service().list({ sessionId: 'session', rootId: opened.version.id }).map(v => v.parentId)).toEqual([undefined, opened.version.id]);
  });
  test('rejects cross-session versions, invalid regions, and models that cannot edit before generation', async () => {
    const edit = service(); const opened = await edit.open({ sessionId: 'session', title: 'original.png', filePath: original });
    await expect(edit.stage({ sessionId: 'other', sourceId: opened.version.id, operation: ImageEditOperation.RemoveBackground })).rejects.toThrow();
    await expect(edit.stage({ sessionId: 'session', sourceId: opened.version.id, operation: ImageEditOperation.Comment,
      regions: [{ id: 'bad', x: 0.8, y: 0.2, width: 0.5, height: 0.2, text: 'change' }] })).rejects.toThrow();
    const request = await edit.stage({ sessionId: 'session', sourceId: opened.version.id, operation: ImageEditOperation.RemoveBackground });
    expect(() => edit.generation(request, { capabilities: 'text-to-image', parameterSpec: { images: { maxItems: 1 } } })).toThrow();
    const params = edit.generation(request, { capabilities: 'image editing', parameterSpec: { images: { maxItems: 2 } } });
    expect(params.params.images).toEqual([request.source.filePath]); expect(params.params.n).toBe(1);
  });
  test('sent metadata and image bytes survive later drafts, output replacement and service recreation', async () => {
    const edit = service();
    const { version } = await edit.open({ sessionId: 'session', title: 'original.png', filePath: original });
    const saved = await edit.save({ sessionId: 'session', sourceId: version.id, operation: ImageEditOperation.Resize,
      dataUrl: `data:image/png;base64,${fixture(320, 240).toString('base64')}` });
    const request = await edit.stage({ sessionId: 'session', sourceId: saved.id, operation: ImageEditOperation.Comment,
      regions: [{ id: 'r1', x: 0.2, y: 0.4, width: 0.5, height: 0.5, text: 'Add a dog' }] });
    messages.set('sent', { type: 'user', metadata: imageEditMessageMetadata([{ imageEdit: request }]) });
    request.regions[0].text = 'Later draft';
    request.regions[0].x = 0.1;
    await fs.writeFile(saved.filePath, fixture(960, 720));
    const restored = service();
    expect(restored.history({ sessionId: 'session', messageId: 'sent' })[0]).toMatchObject({
      sourceVersionNumber: 2, source: { width: 320, height: 240 },
      regions: [{ x: 0.2, text: 'Add a dog' }],
    });
    expect((await restored.readSnapshot({ sessionId: 'session', requestId: request.id })).image)
      .toEqual({ bytes: fixture(320, 240), mime: 'image/png' });
    await expect(restored.readSnapshot({ sessionId: 'other', requestId: request.id })).rejects.toThrow();
  });
  test('historical messages recover only the request with their exact frozen attachment path', async () => {
    const edit = service();
    const { version } = await edit.open({ sessionId: 'session', title: 'original.png', filePath: original });
    const input = { sessionId: 'session', sourceId: version.id, operation: ImageEditOperation.Comment,
      regions: [{ id: 'r1', x: 0.2, y: 0.4, width: 0.5, height: 0.5, text: 'Add a cat' }] };
    const first = await edit.stage(input);
    const second = await edit.stage({ ...input, regions: [{ ...input.regions[0], text: 'Add a dog' }] });
    // Simulate pre-snapshot requests, which did not record a display version number.
    const state = JSON.parse(values.get('image-editing:session')!);
    for (const request of state.requests) delete request.sourceVersionNumber;
    values.set('image-editing:session', JSON.stringify(state));
    messages.set('old', { type: 'user', metadata: {
      imageAttachmentPreviews: [{ localPath: first.source.filePath, name: version.title }], turnUsage: { totalTokens: 30 },
    } });
    const snapshots = service().history({ sessionId: 'session', messageId: 'old' });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ requestId: first.id, sourceVersionNumber: 1, regions: [{ text: 'Add a cat' }] });
    expect(snapshots[0].requestId).not.toBe(second.id);
    expect(messages.get('old')?.metadata).toMatchObject({ turnUsage: { totalTokens: 30 }, imageEdits: snapshots });
    expect(service().history({ sessionId: 'session', messageId: 'old' })).toEqual(snapshots);
    expect(saveMessageMetadata).toHaveBeenCalledTimes(1);
    for (const [messageId, type, previews] of [
      ['same-title', 'user', [{ localPath: original, name: version.title }]],
      ['no-path', 'user', [{ name: version.title }]],
      ['assistant', 'assistant', [{ localPath: first.source.filePath }]],
    ] as const) {
      messages.set(messageId, { type, metadata: { imageAttachmentPreviews: previews } });
      expect(service().history({ sessionId: 'session', messageId })).toEqual([]);
    }
    expect((messages.get('old')?.metadata.imageEdits as ImageEditMessageSnapshot[])[0].source.id).toBe(version.id);
  });
  test('erase generation and sent previews share the exact frozen mask despite later edits', async () => {
    const edit = service();
    const { version } = await edit.open({ sessionId: 'session', title: 'original.png', filePath: original });
    const mask = marked();
    const request = await edit.stage({ sessionId: 'session', sourceId: version.id, operation: ImageEditOperation.Erase, guideDataUrl: dataUrl(mask) });
    // A close-up of this small image would cover most of it, so the full frozen files are sent.
    expect(request.eraseCrop).toEqual({ x: 0, y: 0, width: 640, height: 480, sourcePath: request.source.filePath, maskPath: request.guidePath });
    const generation = edit.generation(request, { capabilities: 'image editing', parameterSpec: { images: { maxItems: 2 } } }, 'Remove the yellow flower');
    expect(generation.params.images).toEqual([request.source.filePath, request.guidePath]);
    expect(generation.prompt).toContain('WHITE marks the objects/area to remove; BLACK must be preserved');
    expect(generation.prompt).not.toContain('yellow flower');
    expect(() => edit.generation(request, { capabilities: 'image editing', parameterSpec: { images: { maxItems: 1 } } })).toThrow();
    messages.set('erase', { type: 'user', metadata: imageEditMessageMetadata([{ imageEdit: request }]) });
    await edit.stage({ sessionId: 'session', sourceId: version.id, operation: ImageEditOperation.Erase,
      guideDataUrl: dataUrl(fixture(640, 480, { x: 10, y: 10, width: 5, height: 5 })) });
    const snapshot = service().history({ sessionId: 'session', messageId: 'erase' })[0];
    expect(snapshot.requestId).toBe(request.id);
    const full = await service().readSnapshot({ sessionId: 'session', requestId: snapshot.requestId });
    expect(full.mask).toEqual({ bytes: mask, mime: 'image/png' });
    expect(full.image).toEqual({ bytes: fixture(), mime: 'image/png' });
    const preview = await service().readSnapshot({ sessionId: 'session', requestId: snapshot.requestId, preview: true });
    for (const value of [preview.image, preview.mask!]) {
      const bytes = Buffer.from(value.bytes);
      expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([512, 384]);
    }
    await expect(edit.readSnapshot({ sessionId: 'other', requestId: request.id })).rejects.toThrow();
    await expect(edit.stage({ sessionId: 'session', sourceId: version.id, operation: ImageEditOperation.Erase,
      guideDataUrl: `data:image/png;base64,${fixture(400, 400).toString('base64')}` })).rejects.toThrow();
    await expect(edit.stage({ sessionId: 'session', sourceId: version.id, operation: ImageEditOperation.Erase,
      guideDataUrl: dataUrl(fixture()) })).rejects.toThrow();
  });
  test('erase sends a close-up of a small mark and blends the result back into a full-size version', async () => {
    const large = path.join(directory, 'large.png'); await fs.writeFile(large, fixture(2496, 1664));
    const edit = service();
    const { version } = await edit.open({ sessionId: 'session', title: 'large.png', filePath: large });
    const request = await edit.stage({ sessionId: 'session', sourceId: version.id, operation: ImageEditOperation.Erase,
      guideDataUrl: dataUrl(fixture(2496, 1664, { x: 2252, y: 1403, width: 95, height: 75 })) });
    expect(request.eraseCrop).toMatchObject({ x: 1984, y: 1152, width: 512, height: 512 });
    for (const file of [request.eraseCrop!.sourcePath, request.eraseCrop!.maskPath]) {
      expect(path.dirname(file)).toBe(path.dirname(request.guidePath!));
      const bytes = await fs.readFile(file);
      expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([512, 512]);
    }
    const generation = edit.generation(request, { capabilities: 'image editing', parameterSpec: { images: { maxItems: 2 } } }, 'Remove the yellow flower');
    expect(generation.params).toMatchObject({ images: [request.eraseCrop!.sourcePath, request.eraseCrop!.maskPath], size: '2048x2048' });
    expect(generation.prompt).not.toContain('yellow flower');

    const raw = path.join(await edit.downloadDirectory(request), 'raw.png'); await fs.writeFile(raw, fixture(2048, 2048));
    const asset = { type: 'image' as const, url: 'https://example.test/raw.png', originalUrl: 'https://example.test/raw.png',
      mimeType: 'image/png', filename: 'raw.png', filePath: raw, localPath: raw, outputIndex: 0 };
    const [saved] = await edit.finalize(request, 'task-1', [asset]);
    expect(saved.filePath).toBe(path.join(directory, `image-erase-${request.id}-0.png`));
    expect(saved.url).toBe(pathToFileURL(saved.filePath).href);
    const bytes = await fs.readFile(saved.filePath);
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([2496, 1664]);
    expect(edit.list({ sessionId: 'session', rootId: version.id }).at(-1)).toMatchObject({
      operation: ImageEditOperation.Erase, parentId: version.id, filePath: saved.filePath, width: 2496, height: 1664,
    });
    expect((await edit.finalize(request, 'task-1', [asset]))[0].filePath).toBe(saved.filePath);
  });
  test('markup previews recover the submitted drawing and instruction independently of later edits', async () => {
    const edit = service();
    const { version } = await edit.open({ sessionId: 'session', title: 'original.png', filePath: original });
    const guide = Buffer.concat([fixture(), Buffer.from([2])]);
    const guideDataUrl = `data:image/png;base64,${guide.toString('base64')}`;
    const request = await edit.stage({ sessionId: 'session', sourceId: version.id, operation: ImageEditOperation.Markup,
      guideDataUrl, instruction: 'Add a Christmas tree here' });
    const generation = edit.generation(request, { capabilities: 'image editing', parameterSpec: { images: { maxItems: 2 } } });
    expect(generation.params.images).toEqual([request.source.filePath, request.guidePath]);
    expect(generation.prompt).toContain('The SECOND image is an annotated guide.');
    expect(generation.prompt).toContain('Add a Christmas tree here');
    // Recover a historical message using the exact original attachment, without a newer drawing.
    messages.set('markup', { type: 'user', metadata: { imageAttachmentPreviews: [{ localPath: request.source.filePath }] } });
    await edit.stage({ sessionId: 'session', sourceId: version.id, operation: ImageEditOperation.Markup,
      guideDataUrl: `data:image/png;base64,${fixture().toString('base64')}`, instruction: 'Later edit' });
    const snapshot = service().history({ sessionId: 'session', messageId: 'markup' })[0];
    expect(snapshot).toMatchObject({ requestId: request.id, operation: ImageEditOperation.Markup, instruction: 'Add a Christmas tree here' });
    // Full-size reads stay off the native codec; decoding and re-encoding large PNGs stalls the main process.
    const decode = vi.spyOn(nativeImage, 'createFromBuffer');
    const full = await service().readSnapshot({ sessionId: 'session', requestId: snapshot.requestId });
    expect(decode).not.toHaveBeenCalled();
    decode.mockRestore();
    expect(full).toEqual({ image: { bytes: fixture(), mime: 'image/png' }, markup: { bytes: guide, mime: 'image/png' } });
    const preview = await service().readSnapshot({ sessionId: 'session', requestId: snapshot.requestId, preview: true });
    const bytes = Buffer.from(preview.markup!.bytes);
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([512, 384]);
    expect(bytes[bytes.length - 1]).toBe(2);
    expect(preview.mask).toBeUndefined();
  });
  test.each([ImageEditOperation.Erase, ImageEditOperation.Markup])('missing or mismatched historical %s guides explicitly fall back to the original', async operation => {
    const edit = service();
    const { version } = await edit.open({ sessionId: 'session', title: 'original.png', filePath: original });
    const request = await edit.stage({ sessionId: 'session', sourceId: version.id, operation, guideDataUrl: dataUrl(marked()) });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await fs.writeFile(request.guidePath!, fixture(400, 400));
      expect(await edit.readSnapshot({ sessionId: 'session', requestId: request.id })).toEqual({
        image: { bytes: fixture(), mime: 'image/png' },
      });
      await fs.unlink(request.guidePath!);
      expect(await edit.readSnapshot({ sessionId: 'session', requestId: request.id })).toEqual({
        image: { bytes: fixture(), mime: 'image/png' },
      });
      expect(warn).toHaveBeenCalledTimes(2);
    } finally { warn.mockRestore(); }
  });
});
