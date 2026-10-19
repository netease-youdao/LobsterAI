import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createExpertCatalogFixture } from '../../shared/agent/expertCatalogFixture';
import { ExpertStore } from './expertStore';

const TEST_ENDPOINT = 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/test/expert-store';
const PROD_ENDPOINT = TEST_ENDPOINT.replace('/test/', '/prod/');
const CATALOG_URL = 'https://ydhardwarecommon.nosdn.127.net/fixture.json';
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'expert-store-test-'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

function remote(version = 'fixture.1') {
  const catalog = { ...createExpertCatalogFixture(), version };
  const content = JSON.stringify(catalog);
  const manifest = { schemaVersion: 1, version, catalogUrl: CATALOG_URL, sha256: createHash('sha256').update(content).digest('hex') };
  return { catalog, content, manifest, response: JSON.stringify({ data: { value: manifest } }) };
}

describe('expert store delivery and cache', () => {
  test('deduplicates requests, accepts Overmind string values and persists an offline cache', async () => {
    const data = remote();
    const fetchText = vi.fn(async (url: string) => url === TEST_ENDPOINT ? JSON.stringify({ data: { value: JSON.stringify(data.manifest) } }) : data.content);
    const store = new ExpertStore({ getEndpoint: () => TEST_ENDPOINT, cacheDirectory: directory, fetchText });
    const results = await Promise.all([store.getCatalog(), store.getCatalog()]);
    expect(results).toEqual([data.catalog, data.catalog]);
    await store.getCatalog();
    expect(fetchText).toHaveBeenCalledTimes(2);
    const offline = new ExpertStore({ getEndpoint: () => TEST_ENDPOINT, cacheDirectory: directory, fetchText: async () => { throw new Error('Offline'); } });
    expect(await offline.getCatalog()).toEqual(data.catalog);
  });

  test('refreshes and rolls back versions without re-downloading unchanged content', async () => {
    let data = remote();
    let time = 0;
    const fetchText = vi.fn(async (url: string) => url === TEST_ENDPOINT ? data.response : data.content);
    const store = new ExpertStore({ getEndpoint: () => TEST_ENDPOINT, cacheDirectory: directory, fetchText, now: () => time });
    await store.getCatalog();
    time += 300001;
    await store.getCatalog();
    expect(fetchText.mock.calls.filter(([url]) => url === CATALOG_URL)).toHaveLength(1);
    data = remote('fixture.2');
    time += 300001;
    expect((await store.getCatalog()).version).toBe('fixture.2');
    data = remote('fixture.1');
    time += 300001;
    expect((await store.getCatalog()).version).toBe('fixture.1');
  });

  test('rejects integrity/version failures while retaining the last valid catalog', async () => {
    let data = remote();
    let time = 0;
    const store = new ExpertStore({ getEndpoint: () => TEST_ENDPOINT, cacheDirectory: directory,
      fetchText: async url => url === TEST_ENDPOINT ? data.response : data.content, now: () => time });
    await store.getCatalog();
    data = remote('fixture.2');
    data.content += ' ';
    time += 300001;
    expect((await store.getCatalog()).version).toBe('fixture.1');
    data = remote('fixture.2');
    data.response = JSON.stringify({ data: { value: { ...data.manifest, version: 'wrong' } } });
    time += 300001;
    expect((await store.getCatalog()).version).toBe('fixture.1');
  });

  test('test mode never supplies cached content to prod, including after restart', async () => {
    let endpoint = TEST_ENDPOINT;
    const data = remote();
    const fetchText = vi.fn(async (url: string) => {
      if (url === PROD_ENDPOINT) throw new Error('Prod unavailable');
      return url === TEST_ENDPOINT ? data.response : data.content;
    });
    const store = new ExpertStore({ getEndpoint: () => endpoint, cacheDirectory: directory, fetchText });
    await store.getCatalog();
    endpoint = PROD_ENDPOINT;
    await expect(store.getCatalog()).rejects.toThrow('Prod unavailable');
    await expect(new ExpertStore({ getEndpoint: () => PROD_ENDPOINT, cacheDirectory: directory, fetchText }).getCatalog()).rejects.toThrow('Prod unavailable');
  });

  test('a corrupt cache cannot provide content when offline; a subsequent retry recovers', async () => {
    const data = remote();
    const options = { getEndpoint: () => TEST_ENDPOINT, cacheDirectory: directory };
    await new ExpertStore({ ...options, fetchText: async url => url === TEST_ENDPOINT ? data.response : data.content }).getCatalog();
    const [filename] = await readdir(directory);
    await writeFile(path.join(directory, filename), '{broken');
    const fetchText = vi.fn().mockRejectedValue(new Error('Offline'));
    const store = new ExpertStore({ ...options, fetchText });
    await expect(store.getCatalog()).rejects.toThrow('Offline');
    fetchText.mockImplementation(async (url: string) => url === TEST_ENDPOINT ? data.response : data.content);
    expect(await store.getCatalog()).toEqual(data.catalog);
  });
});
