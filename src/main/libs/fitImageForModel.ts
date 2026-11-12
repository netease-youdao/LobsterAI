import { nativeImage } from 'electron';

const JPEG_QUALITY = 90;
const MAX_DIMENSION = 4096;
const FIT_ATTEMPTS = 6;

/**
 * Re-encodes an image so it fits the gateway's per-image limit, mirroring what
 * the composer does before a normal send. Throws when the format cannot be
 * decoded or the image cannot be brought under the limit.
 */
export function fitImageBytesForModel(bytes: Buffer, maxBytes: number): { bytes: Buffer; mimeType: string } {
  let image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new Error('Image cannot be decoded for re-encoding.');
  const initial = image.getSize();
  let scale = Math.min(1, MAX_DIMENSION / Math.max(initial.width, initial.height, 1));
  for (let attempt = 0; attempt < FIT_ATTEMPTS; attempt += 1) {
    if (scale < 1) {
      const size = image.getSize();
      image = image.resize({ width: Math.max(1, Math.round(size.width * scale)), quality: 'best' });
    }
    const fitted = image.toJPEG(JPEG_QUALITY);
    if (fitted.length <= maxBytes) return { bytes: fitted, mimeType: 'image/jpeg' };
    scale = Math.min(0.9, Math.sqrt(maxBytes / fitted.length) * 0.9);
  }
  throw new Error('Image cannot be fitted within the model size limit.');
}
