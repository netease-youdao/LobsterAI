import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test, vi } from 'vitest';

import { getOpenClawCompileCachePrefix, pruneStaleOpenClawCompileCaches } from './openclawCompileCache';

const roots: string[] = [];
function cacheDir(names: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-compile-cache-'));
  roots.push(root);
  const dir = path.join(root, '.compile-cache');
  for (const name of names) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, '8a1b2c3d'), 'cache');
  }
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('the prefix matches Node compile cache tags', () => {
  expect(getOpenClawCompileCachePrefix('v24.19.0', 'arm64')).toBe('v24.19.0-arm64-');
  expect(getOpenClawCompileCachePrefix()).toBe(`${process.version}-${process.arch}-`);
});

test('removes caches from other runtime versions and architectures, keeping every current-runtime tag', async () => {
  const dir = cacheDir([
    'v24.19.0-arm64-2d60bbc0-501', 'v24.19.0-arm64-5843ca6e-501',
    'v24.11.1-arm64-e4fd8016-501', 'v24.11.1-x64-e4fd8016-501', 'v24.19.0-x64-2d60bbc0-501',
    'v22.17.0-arm64-84968a5c', 'v24.1.0-arm64-cf738c9d-501',
  ]);
  fs.writeFileSync(path.join(dir, 'stray-file'), '');

  const removed = await pruneStaleOpenClawCompileCaches(dir, 'v24.19.0-arm64-');

  expect(removed.map(item => path.basename(item)).sort()).toEqual([
    'v22.17.0-arm64-84968a5c', 'v24.1.0-arm64-cf738c9d-501', 'v24.11.1-arm64-e4fd8016-501',
    'v24.11.1-x64-e4fd8016-501', 'v24.19.0-x64-2d60bbc0-501',
  ]);
  expect(fs.readdirSync(dir).sort()).toEqual(['stray-file', 'v24.19.0-arm64-2d60bbc0-501', 'v24.19.0-arm64-5843ca6e-501']);
});

test('a missing cache dir is a no-op and removal failures only warn', async () => {
  expect(await pruneStaleOpenClawCompileCaches(path.join(os.tmpdir(), 'lobster-absent-compile-cache'))).toEqual([]);
  const dir = cacheDir(['v22.17.0-arm64-84968a5c', 'v22.22.3-arm64-2b4477fa-501']);
  const busy = path.join(dir, 'v22.17.0-arm64-84968a5c');
  const rmdir = fs.promises.rmdir;
  vi.spyOn(fs.promises, 'rmdir').mockImplementation(async (target, ...args) => {
    if (target === busy) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    return rmdir(target, ...args);
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  expect(await pruneStaleOpenClawCompileCaches(dir, 'v24.19.0-arm64-')).toEqual([path.join(dir, 'v22.22.3-arm64-2b4477fa-501')]);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining(busy), expect.objectContaining({ code: 'EPERM' }));
  expect(fs.existsSync(busy)).toBe(true);
});
