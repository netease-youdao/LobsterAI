/**
 * Image sizes known before an <img> finishes loading, so conversation images
 * can reserve their final box up front instead of growing when they decode
 * (which shifts everything below them).
 */

export type ImageSize = { width: number; height: number };

const IMAGE_SIZE_CACHE_LIMIT = 500;
// Header bytes are enough for PNG/GIF/WebP; JPEG puts its size after the EXIF block.
const BASE64_HEADER_PROBE_CHARS = [4096, 256 * 1024];
const DEFAULT_IMAGE_MEASURE_TIMEOUT_MS = 1500;

// Natural sizes measured in this renderer, keyed by image src. Insertion order doubles as LRU order.
const imageSizeCache = new Map<string, ImageSize>();

const isValidSize = (width: number, height: number): boolean => (
  Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
);

// data: URLs can be megabytes long; never keep them as cache keys.
const isCacheableImageSrc = (src: string | undefined): src is string => (
  Boolean(src) && !/^data:/i.test(src as string)
);

export function getCachedImageSize(src: string | undefined): ImageSize | null {
  if (!isCacheableImageSrc(src)) return null;
  return imageSizeCache.get(src) ?? null;
}

export function rememberImageSize(src: string | undefined, width: number, height: number): void {
  if (!isCacheableImageSrc(src) || !isValidSize(width, height)) return;
  imageSizeCache.delete(src);
  imageSizeCache.set(src, { width, height });
  if (imageSizeCache.size > IMAGE_SIZE_CACHE_LIMIT) {
    const oldest = imageSizeCache.keys().next().value;
    if (oldest !== undefined) imageSizeCache.delete(oldest);
  }
}

export function clearImageSizeCache(): void {
  imageSizeCache.clear();
}

/** The box an image takes when shrunk (never enlarged) to fit within the given limits. */
export function fitImageSize(size: ImageSize, maxWidth: number, maxHeight: number): ImageSize {
  const scale = Math.min(1, maxWidth / size.width, maxHeight / size.height);
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

const decodeBase64Prefix = (base64: string, maxChars: number): Uint8Array | null => {
  const prefix = base64.slice(0, maxChars).replace(/[^A-Za-z0-9+/=]/g, '');
  const usable = prefix.slice(0, prefix.length - (prefix.length % 4));
  if (!usable) return null;
  try {
    const binary = atob(usable);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
};

const readUint16BE = (bytes: Uint8Array, offset: number): number => (bytes[offset] << 8) | bytes[offset + 1];
const readUint16LE = (bytes: Uint8Array, offset: number): number => bytes[offset] | (bytes[offset + 1] << 8);
const readUint24LE = (bytes: Uint8Array, offset: number): number => (
  bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
);
const readUint32BE = (bytes: Uint8Array, offset: number): number => (
  ((bytes[offset] << 24) >>> 0) + ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])
);
const readAscii = (bytes: Uint8Array, offset: number, length: number): string => (
  String.fromCharCode(...bytes.subarray(offset, offset + length))
);

const sizeOrNull = (width: number, height: number): ImageSize | null => (
  isValidSize(width, height) ? { width, height } : null
);

const readPngSize = (bytes: Uint8Array): ImageSize | null => {
  if (bytes.length < 24 || readAscii(bytes, 12, 4) !== 'IHDR') return null;
  return sizeOrNull(readUint32BE(bytes, 16), readUint32BE(bytes, 20));
};

const readGifSize = (bytes: Uint8Array): ImageSize | null => {
  if (bytes.length < 10) return null;
  return sizeOrNull(readUint16LE(bytes, 6), readUint16LE(bytes, 8));
};

const readWebpSize = (bytes: Uint8Array): ImageSize | null => {
  if (bytes.length < 25) return null;
  const chunk = readAscii(bytes, 12, 4);
  if (chunk === 'VP8L' && bytes[20] === 0x2f) {
    const width = 1 + (((bytes[22] & 0x3f) << 8) | bytes[21]);
    const height = 1 + (((bytes[24] & 0x0f) << 10) | (bytes[23] << 2) | ((bytes[22] & 0xc0) >> 6));
    return sizeOrNull(width, height);
  }
  if (bytes.length < 30) return null;
  if (chunk === 'VP8X') {
    return sizeOrNull(1 + readUint24LE(bytes, 24), 1 + readUint24LE(bytes, 27));
  }
  if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return sizeOrNull(readUint16LE(bytes, 26) & 0x3fff, readUint16LE(bytes, 28) & 0x3fff);
  }
  return null;
};

/** EXIF orientation 5–8 rotates the picture a quarter turn; Chromium honors it when laying out <img>. */
const readJpegExifOrientation = (bytes: Uint8Array, segmentStart: number, segmentEnd: number): number => {
  if (readAscii(bytes, segmentStart, 6) !== 'Exif\0\0') return 1;
  const tiff = segmentStart + 6;
  if (tiff + 8 > segmentEnd) return 1;
  const byteOrder = readAscii(bytes, tiff, 2);
  if (byteOrder !== 'II' && byteOrder !== 'MM') return 1;
  const littleEndian = byteOrder === 'II';
  const read16 = (offset: number): number => (littleEndian ? readUint16LE(bytes, offset) : readUint16BE(bytes, offset));
  const read32 = (offset: number): number => (littleEndian
    ? (read16(offset) + read16(offset + 2) * 0x10000)
    : (read16(offset) * 0x10000 + read16(offset + 2)));
  const ifd = tiff + read32(tiff + 4);
  if (ifd + 2 > segmentEnd) return 1;
  const entryCount = read16(ifd);
  for (let entry = 0; entry < entryCount; entry += 1) {
    const offset = ifd + 2 + entry * 12;
    if (offset + 12 > segmentEnd) return 1;
    if (read16(offset) === 0x0112) return read16(offset + 8);
  }
  return 1;
};

const isJpegStartOfFrame = (marker: number): boolean => (
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
);

/** Returns undefined when the probed bytes end before the frame header, so a longer probe can retry. */
const readJpegSize = (bytes: Uint8Array): ImageSize | null | undefined => {
  let orientation = 1;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const segmentLength = readUint16BE(bytes, offset + 2);
    if (segmentLength < 2) return null;
    const segmentStart = offset + 4;
    const segmentEnd = offset + 2 + segmentLength;
    if (isJpegStartOfFrame(marker)) {
      if (segmentStart + 5 > bytes.length) return undefined;
      const height = readUint16BE(bytes, segmentStart + 1);
      const width = readUint16BE(bytes, segmentStart + 3);
      return orientation >= 5 && orientation <= 8 ? sizeOrNull(height, width) : sizeOrNull(width, height);
    }
    if (marker === 0xe1 && segmentEnd <= bytes.length) {
      orientation = readJpegExifOrientation(bytes, segmentStart, segmentEnd);
    }
    offset = segmentEnd;
  }
  return undefined;
};

/**
 * Reads an image's intrinsic size from the header of its base64 data (PNG,
 * JPEG, GIF, WebP), without decoding the picture. Returns null when the format
 * is unknown or the header is unreadable.
 */
export function readBase64ImageSize(base64Data: string | undefined): ImageSize | null {
  if (!base64Data) return null;
  const base64 = base64Data.replace(/^data:[^,]*,/, '');
  for (const probeChars of BASE64_HEADER_PROBE_CHARS) {
    const bytes = decodeBase64Prefix(base64, probeChars);
    if (!bytes || bytes.length < 4) return null;
    if (bytes[0] === 0x89 && readAscii(bytes, 1, 3) === 'PNG') return readPngSize(bytes);
    if (readAscii(bytes, 0, 4) === 'GIF8') return readGifSize(bytes);
    if (readAscii(bytes, 0, 4) === 'RIFF' && readAscii(bytes, 8, 4) === 'WEBP') return readWebpSize(bytes);
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    const jpegSize = readJpegSize(bytes);
    if (jpegSize !== undefined) return jpegSize;
    if (probeChars >= base64.length) return null;
  }
  return null;
}

/**
 * Loads and decodes images ahead of rendering them, recording their natural
 * sizes. A later <img> with the same src then lays out at its final size and
 * paints from the decoded copy. Gives up quietly on failures and slow loads.
 */
export async function measureImageSizes(
  srcs: string[],
  timeoutMs = DEFAULT_IMAGE_MEASURE_TIMEOUT_MS,
): Promise<void> {
  const pending = [...new Set(srcs)].filter(src => isCacheableImageSrc(src) && !imageSizeCache.has(src));
  if (pending.length === 0 || typeof Image === 'undefined') return;
  const measurements = pending.map(async (src) => {
    const image = new Image();
    image.src = src;
    try {
      await image.decode();
      rememberImageSize(src, image.naturalWidth, image.naturalHeight);
    } catch {
      // Broken or unsupported images keep their regular loading placeholder.
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(measurements),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}
