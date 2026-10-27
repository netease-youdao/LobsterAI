import fs from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { changedDeliveredFile, type DeliveryBaseline } from './remoteDeliveredFiles';

// Exercise native Windows path semantics on every CI host; filesystem identity remains independently checked.
vi.mock('path', async importOriginal => {
  const actual = await importOriginal<typeof import('path')>();
  return { default: actual.win32 };
});
afterEach(() => vi.restoreAllMocks());
const root = String.raw`C:\Work`;
const nested = String.raw`C:\Work\图片`;
const file = String.raw`C:\Work\图片\海狮 06.jpg`;
const baseline: DeliveryBaseline = { current: () => true, directories: [{ path: root, identity: '1:10', files: {} }] };
function filesystem() {
  vi.spyOn(fs.promises, 'realpath').mockImplementation(async target => String(target));
  return vi.spyOn(fs.promises, 'lstat').mockImplementation(async target => {
    const value = String(target);
    if (![root, nested, file].includes(value)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return { dev: 1, ino: value === root ? 10 : value === nested ? 11 : 12, size: 100, mtimeMs: 10, ctimeMs: 10,
      isFile: () => value === file, isDirectory: () => value !== file, isSymbolicLink: () => false } as fs.Stats;
  });
}
describe('nested delivery on Windows', () => {
  it('accepts an explicit nested file with Chinese characters, spaces and backslashes', async () => {
    const lstat = filesystem();
    expect(await changedDeliveredFile(baseline, file, 100, () => true, true)).toMatchObject({ filePath: file,
      directories: [{ path: root, identity: '1:10' }, { path: nested, identity: '1:11' }] });
    expect(lstat.mock.calls.length).toBeLessThanOrEqual(7);
    expect(await changedDeliveredFile(baseline, file, 100, () => true)).toBeNull();
  });
  it.each([String.raw`D:\Work\image.jpg`, String.raw`C:\Work-other\image.jpg`,
    String.raw`C:\Work\..\private\image.jpg`, String.raw`\\server\share\image.jpg`])('rejects paths outside the prepared root: %s', async target => {
    const lstat = filesystem();
    expect(await changedDeliveredFile(baseline, target, 100, () => true, true)).toBeNull();
    expect(lstat).not.toHaveBeenCalled();
  });
  it('rejects overly deep paths before issuing filesystem calls', async () => {
    const lstat = filesystem();
    const target = root + '\\' + Array(33).fill('child').join('\\') + '\\image.jpg';
    expect(await changedDeliveredFile(baseline, target, 100, () => true, true)).toBeNull();
    expect(lstat).not.toHaveBeenCalled();
  });
  it('fails closed on denied directory access', async () => {
    const lstat = filesystem();
    lstat.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    expect(await changedDeliveredFile(baseline, file, 100, () => true, true)).toBeNull();
  });
});
