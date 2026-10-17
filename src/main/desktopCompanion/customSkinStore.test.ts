import { createHash } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CompanionCustomSkin } from '../../shared/desktopCompanion/customSkin';
import { deleteCustomCompanionSkin, loadCustomCompanionSkin, saveCustomCompanionSkin, validateCompanionPng } from './customSkinStore';

const mock = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), stat: vi.fn(), mkdir: vi.fn(), decode: vi.fn(), unlink: vi.fn() }));
vi.mock('fs', () => ({ default: { readFileSync: mock.read, writeFileSync: mock.write, lstatSync: mock.stat, mkdirSync: mock.mkdir, unlinkSync: mock.unlink } }));
vi.mock('electron', () => ({ app: { getPath: () => 'F:/test-user-data' }, nativeImage: { createFromBuffer: mock.decode } }));
function png(width = 512, height = 512) {
  const buffer = Buffer.alloc(40);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer);
  buffer.write('IHDR', 12);
  buffer.writeUInt32BE(width, 16); buffer.writeUInt32BE(height, 20);
  return buffer;
}
const data = (buffer: Buffer) => `data:image/png;base64,${buffer.toString('base64')}`;
beforeEach(() => {
  vi.resetAllMocks();
  mock.stat.mockReturnValue({ isFile: () => true, isDirectory: () => true, isSymbolicLink: () => false, size: 40 });
  mock.read.mockReturnValue(png());
  mock.decode.mockReturnValue({ isEmpty: () => false, getSize: () => ({ width: 512, height: 512 }), toPNG: () => png(), toBitmap: () => Buffer.from([0, 0, 0, 0, 255, 255, 255, 255]) });
});
describe('custom companion local image store', () => {
  it('deletes only validated skin files and tolerates already missing files', () => {
    const id = `custom-${'a'.repeat(64)}`;
    expect(() => deleteCustomCompanionSkin('../other.png')).toThrow();
    expect(mock.unlink).not.toHaveBeenCalled();
    deleteCustomCompanionSkin(id);
    expect(mock.unlink).toHaveBeenCalledWith(expect.stringContaining(`${id}.png`));
    mock.stat.mockReturnValue({ isDirectory: () => true, isFile: () => true, isSymbolicLink: () => true });
    expect(() => deleteCustomCompanionSkin(id)).toThrow();
    expect(mock.unlink).toHaveBeenCalledTimes(1);
    mock.stat.mockImplementation(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); });
    expect(() => deleteCustomCompanionSkin(id)).not.toThrow();
  });
  it('accepts opaque PNGs as well as transparent icons', () => {
    mock.decode.mockReturnValue({ isEmpty: () => false, getSize: () => ({ width: 512, height: 512 }), toPNG: () => png(), toBitmap: () => Buffer.alloc(512 * 512 * 4, 255) });
    expect(saveCustomCompanionSkin(data(png())).id).toMatch(/^custom-/);
    expect(mock.write).toHaveBeenCalledTimes(1);
  });
  it('decodes and canonicalizes before writing a hash-named file', () => {
    const asset = saveCustomCompanionSkin(data(png()));
    expect(asset.id).toBe(`custom-${createHash('sha256').update(png()).digest('hex')}`);
    expect(mock.write).toHaveBeenCalledWith(expect.stringContaining(`${asset.id}.png`), png(), { flag: 'wx', mode: 0o600 });
    expect(loadCustomCompanionSkin(asset.id)).toEqual(asset);
  });
  it('rejects unsupported data URLs, oversized bytes and pixel headers before decode', () => {
    for (const invalid of ['https://example.com/a.png', 'data:image/svg+xml;base64,PHN2Zz4=', data(png(100000, 512)), data(Buffer.alloc(CompanionCustomSkin.MaxSavedBytes + 1))]) {
      expect(() => saveCustomCompanionSkin(invalid)).toThrow();
    }
    expect(mock.decode).not.toHaveBeenCalled(); expect(mock.write).not.toHaveBeenCalled();
  });
  it('rejects malformed/empty native images without replacing assets', () => {
    mock.decode.mockReturnValue({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) });
    expect(() => saveCustomCompanionSkin(data(png()))).toThrow();
    expect(mock.write).not.toHaveBeenCalled();
  });
  it('rejects symlinks and digest mismatches on restore', () => {
    const id = `custom-${createHash('sha256').update(png()).digest('hex')}`;
    mock.stat.mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => true });
    expect(loadCustomCompanionSkin(id)).toBeUndefined();
    expect(() => saveCustomCompanionSkin(data(png()))).toThrow();
    expect(mock.write).not.toHaveBeenCalled();
    mock.stat.mockReturnValue({ isFile: () => true, isDirectory: () => true, isSymbolicLink: () => false, size: 40 });
    expect(loadCustomCompanionSkin(`custom-${'f'.repeat(64)}`)).toBeUndefined();
  });
  it('does not accept renderer file paths, and propagates write failures', () => {
    expect(loadCustomCompanionSkin('../image.png')).toBeUndefined(); expect(mock.read).not.toHaveBeenCalled();
    mock.write.mockImplementation(() => { throw new Error('disk full'); });
    expect(() => saveCustomCompanionSkin(data(png()))).toThrow('disk full');
    expect(() => validateCompanionPng(Buffer.alloc(2))).toThrow();
  });
  it('deduplicates an existing verified image but refuses to reuse a corrupted file', () => {
    mock.write.mockImplementation(() => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); });
    expect(saveCustomCompanionSkin(data(png())).id).toBe(`custom-${createHash('sha256').update(png()).digest('hex')}`);
    mock.read.mockReturnValue(png(256));
    expect(() => saveCustomCompanionSkin(data(png()))).toThrow('exists');
  });
});
