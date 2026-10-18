// @vitest-environment jsdom
import { afterEach, describe, expect, it, test, vi } from 'vitest';

import { CompanionCustomSkin } from '../../../shared/desktopCompanion/customSkin';
import { cropCompanionSkinImage, decodeCompanionSkinImage, readCompanionSkinImage } from './customSkinImage';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('custom companion upload', () => {
  test('rejects SVG and oversized input before reading or decoding', async () => {
    const reader = vi.fn();
    vi.stubGlobal('FileReader', reader);
    await expect(readCompanionSkinImage({ type: 'image/svg+xml', size: 5 } as File)).rejects.toThrow('format');
    await expect(readCompanionSkinImage({ type: 'image/png', size: CompanionCustomSkin.MaxSourceBytes + 1 } as File)).rejects.toThrow('size');
    expect(reader).not.toHaveBeenCalled();
  });
  test('exports a 512px PNG with the complete wide image and no circular clipping', () => {
    const context = { drawImage: vi.fn() };
    const canvas = { width: 0, height: 0, getContext: () => context, toDataURL: vi.fn(() => 'data:image/png;base64,YQ==') };
    vi.stubGlobal('document', { createElement: () => canvas });
    const image = { naturalWidth: 1024, naturalHeight: 256 } as HTMLImageElement;
    expect(cropCompanionSkinImage(image, 1, 0.5, 0.5)).toBe('data:image/png;base64,YQ==');
    expect(canvas.width).toBe(512); expect(canvas.height).toBe(512);
    expect(context.drawImage).toHaveBeenCalledWith(image, 0, 192, 512, 128);
    expect(canvas.toDataURL).toHaveBeenCalledWith('image/png');
  });
});

describe('animated companion skin image handling', () => {
  it('keeps original GIF data out of the canvas pipeline, including non-square images', async () => {
    const bytes = Uint8Array.from(Buffer.from('47494638396180000001800000000000ffffff21f904090a0000002c00000000010001000002024401003b', 'hex'));
    const dataUrl = `data:image/gif;base64,${Buffer.from(bytes).toString('base64')}`;
    vi.stubGlobal('Image', class {
      naturalWidth = 128; naturalHeight = 256;
      onload?: () => void;
      private source = '';
      get src() { return this.source; }
      set src(value: string) { this.source = value; queueMicrotask(() => this.onload?.()); }
    });
    const canvas = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
    const image = await decodeCompanionSkinImage(dataUrl);
    expect(image.src).toBe(dataUrl);
    expect(cropCompanionSkinImage(image, 3, 0, 1)).toBe(dataUrl);
    expect(canvas).not.toHaveBeenCalled();
  });
  it('rejects forged or oversized GIF uploads before displaying a preview', async () => {
    await expect(decodeCompanionSkinImage('data:image/gif;base64,PHN2Zz4=')).rejects.toThrow();
    await expect(readCompanionSkinImage(new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'large.gif', { type: 'image/gif' }))).rejects.toThrow();
    await expect(readCompanionSkinImage(new File(['<svg/>'], 'fake.gif', { type: 'image/svg+xml' }))).rejects.toThrow();
  });
});
