import { afterEach, describe, expect, test, vi } from 'vitest';

import { CompanionCustomSkin } from '../../../shared/desktopCompanion/customSkin';
import { cropCompanionSkinImage, readCompanionSkinImage } from './customSkinImage';

afterEach(() => vi.unstubAllGlobals());

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
