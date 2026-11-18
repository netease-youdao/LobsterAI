import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test, vi } from 'vitest';

import { pruneOpenClawBrowserCaches } from './openclawBrowserCachePrune';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const SITE_DATA = ['Cookies', 'Login Data', 'Local Storage/leveldb/000003.log', 'IndexedDB/https_example.com_0.indexeddb.leveldb/CURRENT', 'Preferences'];
const CACHES = ['Cache/Cache_Data/data_0', 'Code Cache/js/index', 'GPUCache/data_1', 'Service Worker/CacheStorage/abc/index.txt', 'Service Worker/ScriptCache/index', 'Service Worker/Database/CURRENT'];

function fixture(cacheBytes = 64) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-browser-cache-'));
  roots.push(root);
  const homeDir = path.join(root, 'home');
  const stateDir = path.join(homeDir, 'Library', 'Application Support', 'LobsterAI', 'openclaw', 'state');
  const userDataDir = path.join(stateDir, 'browser', 'openclaw', 'user-data');
  const write = (file: string, bytes = 8) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(bytes));
  };
  for (const file of SITE_DATA) write(path.join(userDataDir, 'Default', file));
  for (const file of CACHES) write(path.join(userDataDir, 'Default', file), cacheBytes);
  write(path.join(userDataDir, 'Local State'));
  // Not a Chrome profile directory: never a candidate.
  write(path.join(userDataDir, 'Safe Browsing', 'Cache', 'kept'), cacheBytes);
  return { root, homeDir, stateDir, userDataDir, write };
}
const exists = (...parts: string[]) => fs.existsSync(path.join(...parts));

test('leaves caches below the threshold alone', async () => {
  const { stateDir, homeDir, userDataDir } = fixture(8);
  expect(await pruneOpenClawBrowserCaches(stateDir, { thresholdBytes: 1024, homeDir, platform: 'linux' })).toEqual([]);
  for (const file of CACHES) expect(exists(userDataDir, 'Default', file)).toBe(true);
});

test('removes oversized caches but never site data or non-profile directories', async () => {
  const { stateDir, homeDir, userDataDir, write } = fixture(256);
  write(path.join(userDataDir, 'Profile 1', 'Code Cache', 'js', 'index'), 256);

  const removed = await pruneOpenClawBrowserCaches(stateDir, { thresholdBytes: 1024, homeDir, platform: 'linux' });

  expect([...removed].sort()).toEqual([
    path.join(userDataDir, 'Default', 'Cache'), path.join(userDataDir, 'Default', 'Code Cache'),
    path.join(userDataDir, 'Default', 'GPUCache'), path.join(userDataDir, 'Default', 'Service Worker'),
    path.join(userDataDir, 'Profile 1', 'Code Cache'),
  ].sort());
  for (const file of SITE_DATA) expect(exists(userDataDir, 'Default', file)).toBe(true);
  expect(exists(userDataDir, 'Local State')).toBe(true);
  expect(exists(userDataDir, 'Safe Browsing', 'Cache', 'kept')).toBe(true);
  expect(fs.readdirSync(path.join(userDataDir, 'Default')).some(name => name.includes('lobsterai-stale'))).toBe(false);
});

test('also counts and removes the macOS ~/Library/Caches mirror of the profile', async () => {
  const { stateDir, homeDir, userDataDir, write } = fixture(8);
  const mirror = path.join(homeDir, 'Library', 'Caches', 'LobsterAI', 'openclaw', 'state', 'browser', 'openclaw', 'user-data', 'Default');
  write(path.join(mirror, 'Cache', 'Cache_Data', 'data_0'), 2048);
  write(path.join(mirror, 'Code Cache', 'js', 'index'), 8);

  const removed = await pruneOpenClawBrowserCaches(stateDir, { thresholdBytes: 1024, homeDir, platform: 'darwin' });

  expect(removed).toContain(path.join(mirror, 'Cache'));
  expect(removed).toContain(path.join(mirror, 'Code Cache'));
  expect(removed).toContain(path.join(userDataDir, 'Default', 'Service Worker'));
  expect(fs.readdirSync(mirror)).toEqual([]);
});

test.each([
  ['a live Chrome holds the POSIX lock', 'linux', true, true],
  ['the POSIX lock is stale', 'linux', true, false],
  ['Windows Chrome holds its lockfile', 'win32', false, false],
] as const)('respects the profile lock when %s', async (_name, platform, posixLock, pidAlive) => {
  const { stateDir, homeDir, userDataDir } = fixture(256);
  if (posixLock) fs.symlinkSync(`${os.hostname()}-424242`, path.join(userDataDir, 'SingletonLock'));
  else fs.writeFileSync(path.join(userDataDir, 'lockfile'), '');
  const isPidAlive = vi.fn(() => pidAlive);

  const removed = await pruneOpenClawBrowserCaches(stateDir, { thresholdBytes: 1024, homeDir, platform, isPidAlive });

  const inUse = platform === 'win32' || pidAlive;
  expect(removed.length > 0).toBe(!inUse);
  expect(exists(userDataDir, 'Default', 'Service Worker', 'CacheStorage', 'abc', 'index.txt')).toBe(inUse);
  if (posixLock) expect(isPidAlive).toHaveBeenCalledWith(424242);
});

test('finishes staged removals and keeps going when one cache cannot be staged', async () => {
  const { stateDir, homeDir, userDataDir, write } = fixture(256);
  write(path.join(userDataDir, 'Default', 'Cache.lobsterai-stale-0badc0de', 'data_0'));
  const rename = fs.promises.rename;
  vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
    if (String(from).endsWith(`${path.sep}GPUCache`)) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
    return rename(from, to);
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  const removed = await pruneOpenClawBrowserCaches(stateDir, { thresholdBytes: 1024, homeDir, platform: 'linux' });

  expect(removed).not.toContain(path.join(userDataDir, 'Default', 'GPUCache'));
  expect(removed).toContain(path.join(userDataDir, 'Default', 'Service Worker'));
  expect(exists(userDataDir, 'Default', 'GPUCache', 'data_1')).toBe(true);
  expect(exists(userDataDir, 'Default', 'Cache.lobsterai-stale-0badc0de')).toBe(false);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('GPUCache'), expect.objectContaining({ code: 'EBUSY' }));
});

test('a state dir without managed browser profiles is a no-op', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-browser-cache-'));
  roots.push(root);
  expect(await pruneOpenClawBrowserCaches(root)).toEqual([]);
});
