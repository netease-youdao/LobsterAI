import { describe, expect, test, vi } from 'vitest';

import {
  buildCopiedMessageHtml,
  createCopiedMessageImageFile,
  extractCopiedMessageImages,
  resolveMessageImagesForCopy,
} from './messageClipboard';

const PNG_BASE64 = Buffer.from('png-bytes').toString('base64');
const JPEG_BASE64 = Buffer.from('jpeg-bytes').toString('base64');

describe('buildCopiedMessageHtml / extractCopiedMessageImages', () => {
  test('round-trips every image with its name', () => {
    const html = buildCopiedMessageHtml('看看这两张图', [
      { name: 'first "shot".png', mimeType: 'image/png', base64Data: PNG_BASE64 },
      { name: '截屏 <2>.jpg', mimeType: 'image/jpeg', base64Data: JPEG_BASE64 },
    ]);

    expect(extractCopiedMessageImages(html)).toEqual([
      { name: 'first "shot".png', mimeType: 'image/png', base64Data: PNG_BASE64 },
      { name: '截屏 <2>.jpg', mimeType: 'image/jpeg', base64Data: JPEG_BASE64 },
    ]);
  });

  test('escapes the message text so it cannot inject markup', () => {
    const html = buildCopiedMessageHtml('a <img src="data:image/png;base64,AAAA"> & b\nnext', [
      { name: 'real.png', mimeType: 'image/png', base64Data: PNG_BASE64 },
    ]);

    expect(html).toContain('a &lt;img src=&quot;data:image/png;base64,AAAA&quot;&gt; &amp; b<br>next');
    expect(extractCopiedMessageImages(html)).toEqual([
      { name: 'real.png', mimeType: 'image/png', base64Data: PNG_BASE64 },
    ]);
  });

  test('survives the wrapping the OS clipboard adds around HTML', () => {
    const fragment = buildCopiedMessageHtml('', [
      { name: 'shot.png', mimeType: 'image/png', base64Data: PNG_BASE64 },
    ]);
    const html = `<html><body>\r\n<!--StartFragment-->${fragment}<!--EndFragment-->\r\n</body></html>`;

    expect(extractCopiedMessageImages(html)).toEqual([
      { name: 'shot.png', mimeType: 'image/png', base64Data: PNG_BASE64 },
    ]);
  });

  test('ignores HTML that was not written by the message copy button', () => {
    expect(extractCopiedMessageImages(`<p>hi</p><img src="data:image/png;base64,${PNG_BASE64}">`)).toEqual([]);
    expect(extractCopiedMessageImages('<p>data-lobsterai-copied-message</p><img src="data:image/png;base64,AAAA">')).toEqual([]);
    expect(extractCopiedMessageImages('')).toEqual([]);
  });

  test('skips non-image and remote sources', () => {
    const html = '<div data-lobsterai-copied-message="1">'
      + '<img src="https://example.com/a.png">'
      + '<img src="data:text/html;base64,PGI+">'
      + `<img src="data:image/webp;base64,${PNG_BASE64}">`
      + '</div>';

    expect(extractCopiedMessageImages(html)).toEqual([
      { name: 'image-1', mimeType: 'image/webp', base64Data: PNG_BASE64 },
    ]);
  });
});

describe('createCopiedMessageImageFile', () => {
  test('decodes the image into a typed file', async () => {
    const file = createCopiedMessageImageFile({ name: 'shot.png', mimeType: 'image/png', base64Data: PNG_BASE64 });

    expect(file.name).toBe('shot.png');
    expect(file.type).toBe('image/png');
    expect(Buffer.from(await file.arrayBuffer()).toString()).toBe('png-bytes');
  });
});

describe('resolveMessageImagesForCopy', () => {
  test('prefers the original file over the stored preview', async () => {
    const readFileAsDataUrl = vi.fn(async () => ({ success: true, dataUrl: `data:image/png;base64,${PNG_BASE64}` }));

    const images = await resolveMessageImagesForCopy([
      { name: 'shot.png', mimeType: 'image/jpeg', base64Data: JPEG_BASE64, originalMimeType: 'image/png', localPath: '/tmp/shot.png' },
    ], readFileAsDataUrl);

    expect(readFileAsDataUrl).toHaveBeenCalledWith('/tmp/shot.png');
    expect(images).toEqual([{ name: 'shot.png', mimeType: 'image/png', base64Data: PNG_BASE64 }]);
  });

  test('keeps the recorded image type when the original reads back untyped', async () => {
    const readFileAsDataUrl = async () => ({ success: true, dataUrl: `data:application/octet-stream;base64,${PNG_BASE64}` });

    const images = await resolveMessageImagesForCopy([
      { name: 'shot.heic', mimeType: 'image/jpeg', base64Data: JPEG_BASE64, originalMimeType: 'image/heic', localPath: '/tmp/shot.heic' },
    ], readFileAsDataUrl);

    expect(images).toEqual([{ name: 'shot.heic', mimeType: 'image/heic', base64Data: PNG_BASE64 }]);
  });

  test('falls back to the stored image when the original is missing', async () => {
    const readFileAsDataUrl = vi.fn()
      .mockResolvedValueOnce({ success: false })
      .mockRejectedValueOnce(new Error('ENOENT'));

    const images = await resolveMessageImagesForCopy([
      { name: 'gone.png', mimeType: 'image/jpeg', base64Data: JPEG_BASE64, localPath: '/tmp/gone.png' },
      { name: 'broken.png', mimeType: 'image/png', base64Data: PNG_BASE64, localPath: '/tmp/broken.png' },
      { name: '', mimeType: 'image/png', base64Data: PNG_BASE64 },
    ], readFileAsDataUrl);

    expect(images).toEqual([
      { name: 'gone.png', mimeType: 'image/jpeg', base64Data: JPEG_BASE64 },
      { name: 'broken.png', mimeType: 'image/png', base64Data: PNG_BASE64 },
      { name: 'image-3', mimeType: 'image/png', base64Data: PNG_BASE64 },
    ]);
  });

  test('drops images that have no usable data', async () => {
    expect(await resolveMessageImagesForCopy([
      { name: 'empty.png', mimeType: 'image/png', base64Data: '' },
      { name: 'not-image.bin', mimeType: 'application/octet-stream', base64Data: PNG_BASE64 },
    ])).toEqual([]);
  });
});
