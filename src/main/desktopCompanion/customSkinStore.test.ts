import { createHash } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CompanionCustomSkin, validateCompanionGif } from '../../shared/desktopCompanion/customSkin';
import { deleteCustomCompanionSkin, loadCustomCompanionSkin, saveCustomCompanionSkin, validateCompanionPng } from './customSkinStore';

const mock = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), stat: vi.fn(), mkdir: vi.fn(), decode: vi.fn(), unlink: vi.fn(), exists: vi.fn() }));
vi.mock('fs', () => ({ default: { readFileSync: mock.read, writeFileSync: mock.write, lstatSync: mock.stat, mkdirSync: mock.mkdir, unlinkSync: mock.unlink, existsSync: mock.exists } }));
vi.mock('electron', () => ({ app: { getPath: () => 'F:/test-user-data' }, nativeImage: { createFromBuffer: mock.decode } }));
function png(width = 512, height = 512) {
  const buffer = Buffer.alloc(40);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer);
  buffer.write('IHDR', 12);
  buffer.writeUInt32BE(width, 16); buffer.writeUInt32BE(height, 20);
  return buffer;
}
const data = (buffer: Buffer) => `data:image/png;base64,${buffer.toString('base64')}`;
function gif() {
  // Two one-pixel frames on a 512px canvas, with different timing and infinite looping.
  const header = Buffer.from('47494638396100020002800000000000ffffff', 'hex');
  const loop = Buffer.from('21ff0b4e45545343415045322e300301000000', 'hex');
  const first = Buffer.from('21f904090a0000002c0000000001000100000202440100', 'hex');
  const second = Buffer.from('21f90409140000002c01000000010001000002024c0100', 'hex');
  return Buffer.concat([header, loop, first, second, Buffer.from([0x3b])]);
}
const gifData = (bytes: Buffer) => `data:image/gif;base64,${bytes.toString('base64')}`;
beforeEach(() => {
  vi.resetAllMocks();
  mock.stat.mockReturnValue({ isFile: () => true, isDirectory: () => true, isSymbolicLink: () => false, size: 40 });
  mock.read.mockReturnValue(png());
  mock.decode.mockReturnValue({ isEmpty: () => false, getSize: () => ({ width: 512, height: 512 }), toPNG: () => png(), toBitmap: () => Buffer.from([0, 0, 0, 0, 255, 255, 255, 255]) });
});
describe('custom companion local image store', () => {
  it('preserves all GIF frames and loop metadata across save, reload and delete', () => {
    const original = gif();
    // Electron's nativeImage does not support GIF; the GIF path must never call it.
    mock.decode.mockReturnValue({ isEmpty: () => true });
    expect(validateCompanionGif(original)).toEqual({ width: 512, height: 512, frames: 2 });
    const asset = saveCustomCompanionSkin(gifData(original));
    expect(asset).toEqual({ id: `custom-${createHash('sha256').update(original).digest('hex')}`, dataUrl: gifData(original) });
    expect(mock.write).toHaveBeenCalledWith(expect.stringContaining(`${asset.id}.gif`), original, { flag: 'wx', mode: 0o600 });
    // A fresh load has no renderer image or in-memory format metadata to rely on.
    mock.exists.mockReturnValue(true); mock.read.mockReturnValue(original);
    expect(loadCustomCompanionSkin(asset.id)).toEqual(asset);
    expect(mock.decode).not.toHaveBeenCalled();
    deleteCustomCompanionSkin(asset.id);
    expect(mock.unlink).toHaveBeenCalledWith(expect.stringContaining(`${asset.id}.gif`));
  });
  it('rejects forged GIF types, truncated frames, off-canvas frames and excessive dimensions before decoding', () => {
    const wrongSize = gif(); wrongSize.writeUInt16LE(65535, 6);
    const outside = gif(); outside.writeUInt16LE(512, 47); // first frame left offset
    for (const invalid of [png(), gif().subarray(0, -2), wrongSize, outside, Buffer.concat([gif(), Buffer.from('extra')]), Buffer.alloc(CompanionCustomSkin.MaxSavedBytes + 1)]) {
      expect(() => saveCustomCompanionSkin(gifData(invalid))).toThrow();
    }
    expect(() => saveCustomCompanionSkin(data(gif()))).toThrow();
    expect(mock.decode).not.toHaveBeenCalled(); expect(mock.write).not.toHaveBeenCalled();
  });
  it('does not restore a tampered or symlinked GIF', () => {
    const bytes = gif(); const asset = saveCustomCompanionSkin(gifData(bytes));
    mock.exists.mockReturnValue(true); mock.read.mockReturnValue(bytes);
    expect(loadCustomCompanionSkin(`custom-${'f'.repeat(64)}`)).toBeUndefined();
    mock.stat.mockReturnValue({ isDirectory: () => true, isFile: () => true, isSymbolicLink: () => true });
    expect(loadCustomCompanionSkin(asset.id)).toBeUndefined();
  });
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
});
