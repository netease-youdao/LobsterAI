import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { ImageCreation } from '../../shared/imageCreation/constants';
import { ImageCreationStore } from './imageCreationStore';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
const catalog = (version = 'v1', enabled = true) => ({
  schemaVersion: 1, version, enabled, expertPresetId: 'image-creation-partner', examples: [{
    id: 'poster', title: { zh: '海报', en: 'Poster' }, description: { zh: '海报示例', en: 'Example poster' },
    prompt: { zh: '生成海报', en: 'Generate a poster' }, imageUrl: 'https://ydhardwarecommon.nosdn.127.net/poster.png',
    referenceImageUrl: 'https://ydhardwarecommon.nosdn.127.net/reference.png', modelName: 'Seedream',
  }],
});
const response = (value: unknown) => ({ status: 200, mimeType: 'application/json', bytes: Buffer.from(JSON.stringify({ code: 0, data: { value } })) });
const directory = async () => { const result = await mkdtemp(path.join(os.tmpdir(), 'lobster-image-examples-')); directories.push(result); return result; };

test('deduplicates requests, refreshes by TTL and applies remote disable', async () => {
  let now = 0;
  const download = vi.fn().mockResolvedValue(response(JSON.stringify(catalog())));
  const store = new ImageCreationStore({ getEndpoint: () => 'test', cacheDirectory: await directory(), download, now: () => now });
  const values = await Promise.all([store.getCatalog(), store.getCatalog()]);
  expect(values[0].enabled).toBe(true); expect(download).toHaveBeenCalledTimes(1);
  download.mockResolvedValue(response(catalog('v2', false))); now += ImageCreation.RefreshMs;
  expect((await store.getCatalog()).enabled).toBe(false);
});
test('retains last valid configuration after malformed refresh and across app restarts', async () => {
  let now = 0; const cacheDirectory = await directory();
  const download = vi.fn().mockResolvedValue(response(catalog()));
  const store = new ImageCreationStore({ getEndpoint: () => 'test', cacheDirectory, download, now: () => now });
  await store.getCatalog(); now += ImageCreation.RefreshMs;
  download.mockResolvedValue(response({ schemaVersion: 999 }));
  expect((await store.getCatalog()).version).toBe('v1');
  download.mockRejectedValue(new Error('Offline'));
  expect((await new ImageCreationStore({ getEndpoint: () => 'test', cacheDirectory, download }).getCatalog()).version).toBe('v1');
});
test('never serves test examples as a production fallback', async () => {
  let endpoint = 'test'; const download = vi.fn().mockResolvedValue(response(catalog()));
  const store = new ImageCreationStore({ getEndpoint: () => endpoint, cacheDirectory: await directory(), download });
  await store.getCatalog(); endpoint = 'prod'; download.mockRejectedValue(new Error('Offline'));
  await expect(store.getCatalog()).rejects.toThrow('Offline');
});
test('unconfigured environment hides the feature and clears a previous valid catalog', async () => {
  let now = 0; const download = vi.fn().mockResolvedValue(response(catalog()));
  const store = new ImageCreationStore({ getEndpoint: () => 'test', cacheDirectory: await directory(), download, now: () => now });
  await store.getCatalog(); now += ImageCreation.RefreshMs;
  download.mockResolvedValue(response(undefined));
  expect((await store.getCatalog()).enabled).toBe(false);
});
test('downloads only the selected configured reference and checks the media type', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const download = vi.fn().mockResolvedValueOnce(response(catalog()))
    .mockResolvedValueOnce({ status: 200, mimeType: 'application/octet-stream', bytes: png });
  const store = new ImageCreationStore({ getEndpoint: () => 'test', cacheDirectory: await directory(), download });
  await expect(store.getReference('unknown')).rejects.toThrow('unavailable');
  expect((await store.getReference('poster')).name).toBe('poster-reference.png');
  expect(download.mock.calls[1]).toEqual(['https://ydhardwarecommon.nosdn.127.net/reference.png', ImageCreation.MaxReferenceBytes]);
  download.mockResolvedValue({ status: 200, mimeType: 'image/png', bytes: Buffer.from('<script>') });
  await expect(store.getReference('poster')).rejects.toThrow('Invalid');
});

test('recognizes a WebP reference with the generic NOS content type', async () => {
  const webp = Buffer.alloc(30);
  webp.write('RIFF'); webp.writeUInt32LE(22, 4); webp.write('WEBP', 8);
  webp.write('VP8X', 12); webp.writeUInt32LE(10, 16);
  webp.writeUIntLE(1199, 24, 3); webp.writeUIntLE(1599, 27, 3);
  const download = vi.fn().mockResolvedValueOnce(response(catalog()))
    .mockResolvedValue({ status: 200, mimeType: 'application/octet-stream', bytes: webp });
  const store = new ImageCreationStore({ getEndpoint: () => 'test', cacheDirectory: await directory(), download });
  const reference = await store.getReference('poster');
  expect(reference.name).toBe('poster-reference.webp');
  expect(reference.mimeType).toBe('image/webp');
  webp.writeUIntLE(10_000, 24, 3); webp.writeUIntLE(10_000, 27, 3);
  await expect(store.getReference('poster')).rejects.toThrow('dimensions');
});
