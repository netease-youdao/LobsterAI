import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import JSZip from 'jszip';
import { afterEach, expect, test, vi } from 'vitest';

import { pptCatalogFixture, pptMaterial } from '../../../tests/fixtures/pptCreation';
import { PptAssetKind, PptCreation } from '../../shared/pptCreation/constants';
import { PptCreationStore, validatePptAsset } from './pptCreationStore';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function directory() { const result = await mkdtemp(path.join(os.tmpdir(), 'lobster-ppt-catalog-')); directories.push(result); return result; }
const response = (value: unknown) => ({ status: 200, bytes: Buffer.from(JSON.stringify({ code: 0, data: { value } })) });

test('deduplicates loads, retains valid cache on failure, and honors explicit disable', async () => {
  let now = 0;
  const download = vi.fn().mockResolvedValue(response(pptCatalogFixture()));
  const store = new PptCreationStore({ getEndpoint: () => 'test', cacheDirectory: await directory(), download, now: () => now });
  await Promise.all([store.getCatalog(), store.getCatalog()]); expect(download).toHaveBeenCalledTimes(1);
  now += PptCreation.RefreshMs; download.mockResolvedValue(response({ broken: true }));
  expect((await store.getCatalog()).version).toBe('test-v1');
  now += PptCreation.RefreshMs; download.mockResolvedValue(response(undefined));
  expect((await store.getCatalog()).enabled).toBe(false);
});
test('does not leak a test catalog to production, including after restart', async () => {
  let endpoint = 'test';
  const cacheDirectory = await directory();
  const download = vi.fn().mockResolvedValue(response(pptCatalogFixture()));
  const store = new PptCreationStore({ getEndpoint: () => endpoint, cacheDirectory, download });
  await store.getCatalog(); endpoint = 'prod'; download.mockRejectedValue(new Error('Offline'));
  await expect(store.getCatalog()).rejects.toThrow('Offline');
  await expect(new PptCreationStore({ getEndpoint: () => 'prod', cacheDirectory, download }).getCatalog()).rejects.toThrow('Offline');
  expect((await new PptCreationStore({ getEndpoint: () => 'test', cacheDirectory, download }).getCatalog()).version).toBe('test-v1');
});
test('only downloads current configured assets and verifies their content digest', async () => {
  const download = vi.fn().mockResolvedValueOnce(response(pptCatalogFixture())).mockResolvedValue({ status: 200, bytes: pptMaterial });
  const store = new PptCreationStore({ getEndpoint: () => 'test', cacheDirectory: await directory(), download });
  const request = { version: 'test-v1', exampleId: 'quarterly-report', assetId: 'quarterly-data' };
  await expect(store.getAsset({ ...request, version: 'old-version' })).rejects.toThrow('changed');
  await expect(store.getAsset({ ...request, assetId: 'unconfigured' })).rejects.toThrow('unavailable');
  expect(download).toHaveBeenCalledTimes(1);
  expect((await store.getAsset(request)).base64Data).toBe(pptMaterial.toString('base64'));
  download.mockResolvedValue({ status: 200, bytes: Buffer.from('changed content') });
  await expect(store.getAsset(request)).rejects.toThrow('checksum');
});
test('discards a material finishing after an environment switch', async () => {
  let endpoint = 'test';
  const download = vi.fn().mockResolvedValueOnce(response(pptCatalogFixture()));
  const store = new PptCreationStore({ getEndpoint: () => endpoint, cacheDirectory: await directory(), download });
  await store.getCatalog();
  download.mockImplementationOnce(async () => { endpoint = 'prod'; return { status: 200, bytes: pptMaterial }; });
  await expect(store.getAsset({ version: 'test-v1', exampleId: 'quarterly-report', assetId: 'quarterly-data' })).rejects.toThrow('environment');
});
test('validates the actual Office package rather than trusting its extension or MIME type', async () => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>'); zip.file('ppt/presentation.xml', '<presentation/>');
  const bytes = await zip.generateAsync({ type: 'nodebuffer' });
  await expect(validatePptAsset(bytes, PptAssetKind.Pptx)).resolves.toBeUndefined();
  await expect(validatePptAsset(bytes, PptAssetKind.Xlsx)).rejects.toThrow();
  zip.file('ppt/vbaProject.bin', 'active content');
  const macro = await zip.generateAsync({ type: 'nodebuffer' });
  await expect(validatePptAsset(macro, PptAssetKind.Pptx)).rejects.toThrow();
  await expect(validatePptAsset(Buffer.from('<html>'), PptAssetKind.Pdf)).rejects.toThrow();
  await expect(validatePptAsset(Buffer.from([0xff, 0xfe, 0]), PptAssetKind.Text)).rejects.toThrow();
});
test('accepts editable chart workbooks but rejects macros inside them and other embedded objects', async () => {
  const deck = new JSZip();
  deck.file('[Content_Types].xml', '<Types/>'); deck.file('ppt/presentation.xml', '<presentation/>');
  const workbook = new JSZip();
  workbook.file('[Content_Types].xml', '<Types/>'); workbook.file('xl/workbook.xml', '<workbook/>');
  const embedded = 'ppt/embeddings/chart.xlsx';
  deck.file(embedded, await workbook.generateAsync({ type: 'nodebuffer' }));
  await expect(validatePptAsset(await deck.generateAsync({ type: 'nodebuffer' }), PptAssetKind.Pptx)).resolves.toBeUndefined();
  workbook.file('xl/vbaProject.bin', 'macro');
  deck.file(embedded, await workbook.generateAsync({ type: 'nodebuffer' }));
  await expect(validatePptAsset(await deck.generateAsync({ type: 'nodebuffer' }), PptAssetKind.Pptx)).rejects.toThrow('active-content');
  deck.remove(embedded); deck.file('ppt/embeddings/oleObject.bin', 'object');
  await expect(validatePptAsset(await deck.generateAsync({ type: 'nodebuffer' }), PptAssetKind.Pptx)).rejects.toThrow('embedded');
});
