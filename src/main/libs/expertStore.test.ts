import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { isRemoteExpertImageKey } from '../../shared/agent/avatar';
import { createExpertCatalogFixture } from '../../shared/agent/expertCatalogFixture';
import { ExpertStore } from './expertStore';

const TEST_ENDPOINT = 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/test/expert-store';
const PROD_ENDPOINT = TEST_ENDPOINT.replace('/test/', '/prod/');
const CATALOG_URL = 'https://ydhardwarecommon.nosdn.127.net/fixture.json';
const AVATAR_URL = 'https://ydhardwarecommon.nosdn.127.net/5b9dcdd34d648e2071c8998b2b09da22.webp';
const AVATAR_KEY = 'expert_url_v1_f63b0c786ed58b81bcfdb9b1b1c3ca2c9eac2ecedd2f7c20fca028c41371684d';
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'expert-store-test-'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

function remote(version = 'fixture.1', icons?: string[]) {
  const catalog = { ...createExpertCatalogFixture(), version };
  if (icons) {
    const template = catalog.experts[0];
    catalog.experts = icons.map((icon, i) => ({ ...template, id: i ? `fixture-${i}` : template.id, icon }));
  }
  const content = JSON.stringify(catalog);
  const manifest = { schemaVersion: 1, version, catalogUrl: CATALOG_URL, sha256: createHash('sha256').update(content).digest('hex') };
  return { catalog, content, manifest, response: JSON.stringify({ data: { value: manifest } }) };
}

describe('expert store delivery and cache', () => {
  test('indexes exact static CDN URLs, shares plaza loads and notifies only on effective changes', async () => {
    const samePathDifferentSpelling = AVATAR_URL.replace('/5b', '/%35b');
    const unsafe = [
      AVATAR_URL + '?token=abc', AVATAR_URL + '#fragment', AVATAR_URL.replace('.net/', '.net:443/'),
      AVATAR_URL.replace('.net/', '.net/../'), AVATAR_URL.replace('.net/', '.net/%2e%2e/'),
      AVATAR_URL.replace('.net/', '.net/f%2F'), AVATAR_URL.replace('.net/', '.net/f%5c'),
      AVATAR_URL.replace('.net/', '.net/%252e%252e/'), AVATAR_URL.replace('.net/', '.net/f%00'),
      AVATAR_URL.replace('.net/', '.net/bad%/'), AVATAR_URL.replace('https://', 'https://user@'),
      AVATAR_URL.replace('.net/', '.net.other/'), AVATAR_URL.replace('.webp', '.svg'),
    ];
    let data = remote('fixture.1', [' ' + AVATAR_URL + ' ', AVATAR_URL, samePathDifferentSpelling, ...unsafe]);
    let time = 0;
    const changed = vi.fn();
    const fetchText = vi.fn(async (url: string) => url === TEST_ENDPOINT ? data.response : data.content);
    const store = new ExpertStore({ getEndpoint: () => TEST_ENDPOINT, cacheDirectory: directory,
      fetchText, now: () => time, onRemoteAvatarKeysChanged: changed });
    expect(store.getRemoteAvatarKeys()).toBeUndefined();
    await store.getCatalog();
    const keys = store.getRemoteAvatarKeys()!;
    expect([...keys.keys()]).toEqual([AVATAR_URL, samePathDifferentSpelling]);
    expect(keys.get(AVATAR_URL)).toBe(AVATAR_KEY);
    expect(keys.get(samePathDifferentSpelling)).not.toBe(AVATAR_KEY);
    expect(isRemoteExpertImageKey(AVATAR_KEY)).toBe(true);
    expect(isRemoteExpertImageKey(AVATAR_KEY + 'x')).toBe(false);
    expect(fetchText).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenCalledTimes(1);
    time += 300001;
    data = remote('fixture.2', [samePathDifferentSpelling, AVATAR_URL]);
    expect(store.getRemoteAvatarKeys()).toBe(keys);
    await store.getCatalog();
    expect(store.getRemoteAvatarKeys()).toBe(keys);
    expect(changed).toHaveBeenCalledTimes(1);
    time += 300001;
    data = remote('fixture.2');
    await store.getCatalog();
    expect(store.getRemoteAvatarKeys()?.size).toBe(0);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  test('serves validated disk keys during revalidation and never exposes late keys in another environment', async () => {
    const data = remote('fixture.1', [AVATAR_URL]);
    let endpoint = TEST_ENDPOINT;
    const options = { getEndpoint: () => endpoint, cacheDirectory: directory };
    await new ExpertStore({ ...options, fetchText: async url => url === TEST_ENDPOINT ? data.response : data.content }).getCatalog();
    let finish!: (value: string) => void;
    const fetchText = vi.fn(async (url: string): Promise<string> => {
      if (url === TEST_ENDPOINT) return new Promise(resolve => { finish = resolve; });
      if (url === PROD_ENDPOINT) throw new Error('Offline');
      return remote('fixture.2').content;
    });
    const changed = vi.fn();
    const store = new ExpertStore({ ...options, fetchText, onRemoteAvatarKeysChanged: changed });
    expect(store.getRemoteAvatarKeys()).toBeUndefined();
    const testLoad = store.getCatalog();
    await vi.waitFor(() => expect(store.getRemoteAvatarKeys()?.get(AVATAR_URL)).toBe(AVATAR_KEY));
    expect(changed).toHaveBeenCalledTimes(1);
    endpoint = PROD_ENDPOINT;
    expect(store.getRemoteAvatarKeys()).toBeUndefined();
    await expect(store.getCatalog()).rejects.toThrow('Offline');
    finish(remote('fixture.2').response);
    await testLoad;
    expect(changed).toHaveBeenCalledTimes(1);
    expect(store.getRemoteAvatarKeys()).toBeUndefined();
    expect(fetchText.mock.calls.filter(([url]) => url === PROD_ENDPOINT)).toHaveLength(1);
    endpoint = TEST_ENDPOINT;
    expect(store.getRemoteAvatarKeys()?.size).toBe(0);
  });

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
