import {
  SkinAssetExtension,
  type SkinAssetExtension as SkinAssetExtensionValue,
  SkinAssetFormat,
  SkinAssetMimeType,
  type SkinAssetMimeType as SkinAssetMimeTypeValue,
} from '../../shared/skin/constants';

export interface SkinImageInfo {
  format: SkinAssetFormat;
  extension: SkinAssetExtensionValue;
  mimeType: SkinAssetMimeTypeValue;
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function hasValidPngHeaderFields(data: Buffer, dataOffset: number): boolean {
  const bitDepth = data[dataOffset + 8];
  const colorType = data[dataOffset + 9];
  const allowedBitDepths: Record<number, readonly number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  return Boolean(
    allowedBitDepths[colorType]?.includes(bitDepth) &&
    data[dataOffset + 10] === 0 &&
    data[dataOffset + 11] === 0 &&
    (data[dataOffset + 12] === 0 || data[dataOffset + 12] === 1),
  );
}

function inspectPng(data: Buffer): SkinImageInfo | null {
  if (data.length < 57 || !data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return null;
  }

  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawImageData = false;

  while (offset + 12 <= data.length) {
    const chunkLength = data.readUInt32BE(offset);
    const typeOffset = offset + 4;
    const dataOffset = offset + 8;
    const crcOffset = dataOffset + chunkLength;
    const chunkEnd = crcOffset + 4;
    if (chunkEnd > data.length) return null;

    const chunkType = data.toString('ascii', typeOffset, dataOffset);
    if (!/^[A-Za-z]{4}$/.test(chunkType)) return null;
    if (data.readUInt32BE(crcOffset) !== crc32(data.subarray(typeOffset, crcOffset))) return null;

    if (chunkType === 'IHDR') {
      if (sawHeader || offset !== PNG_SIGNATURE.length || chunkLength !== 13) return null;
      width = data.readUInt32BE(dataOffset);
      height = data.readUInt32BE(dataOffset + 4);
      sawHeader = width > 0 && height > 0 && hasValidPngHeaderFields(data, dataOffset);
      if (!sawHeader) return null;
    } else if (!sawHeader) {
      return null;
    } else if (chunkType === 'IDAT') {
      sawImageData = true;
    } else if (chunkType === 'IEND') {
      if (chunkLength !== 0 || !sawImageData || chunkEnd !== data.length) return null;
      return {
        format: SkinAssetFormat.Png,
        extension: SkinAssetExtension.Png,
        mimeType: SkinAssetMimeType.Png,
        width,
        height,
      };
    }

    offset = chunkEnd;
  }

  return null;
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
]);

function inspectJpeg(data: Buffer): SkinImageInfo | null {
  if (
    data.length < 16 ||
    data[0] !== 0xff ||
    data[1] !== 0xd8 ||
    data[data.length - 2] !== 0xff ||
    data[data.length - 1] !== 0xd9
  ) {
    return null;
  }

  let offset = 2;
  let width = 0;
  let height = 0;
  let sawScan = false;

  while (offset < data.length - 2) {
    if (data[offset] !== 0xff) return null;
    while (offset < data.length && data[offset] === 0xff) offset += 1;
    if (offset >= data.length) return null;

    const marker = data[offset];
    offset += 1;
    if (marker === 0x00) return null;
    if (marker === 0xd9) break;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > data.length) return null;

    const segmentLength = data.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > data.length) return null;

    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 8) return null;
      height = data.readUInt16BE(offset + 3);
      width = data.readUInt16BE(offset + 5);
      if (width === 0 || height === 0) return null;
    }

    if (marker === 0xda) {
      if (segmentLength < 6 || width === 0 || height === 0) return null;
      sawScan = true;
      break;
    }

    offset += segmentLength;
  }

  if (!sawScan || width === 0 || height === 0) return null;
  return {
    format: SkinAssetFormat.Jpeg,
    extension: SkinAssetExtension.Jpeg,
    mimeType: SkinAssetMimeType.Jpeg,
    width,
    height,
  };
}

function readUInt24LE(data: Buffer, offset: number): number {
  return data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16);
}

function inspectWebp(data: Buffer): SkinImageInfo | null {
  if (
    data.length < 25 ||
    data.toString('ascii', 0, 4) !== 'RIFF' ||
    data.toString('ascii', 8, 12) !== 'WEBP' ||
    data.readUInt32LE(4) + 8 !== data.length
  ) {
    return null;
  }

  let offset = 12;
  let width = 0;
  let height = 0;
  let hasImageData = false;

  while (offset + 8 <= data.length) {
    const chunkType = data.toString('ascii', offset, offset + 4);
    const chunkLength = data.readUInt32LE(offset + 4);
    const payloadOffset = offset + 8;
    const payloadEnd = payloadOffset + chunkLength;
    const chunkEnd = payloadEnd + (chunkLength % 2);
    if (payloadEnd > data.length || chunkEnd > data.length) return null;

    if (chunkType === 'VP8X') {
      if (chunkLength !== 10) return null;
      width = readUInt24LE(data, payloadOffset + 4) + 1;
      height = readUInt24LE(data, payloadOffset + 7) + 1;
    } else if (chunkType === 'VP8L') {
      if (chunkLength < 5 || data[payloadOffset] !== 0x2f) return null;
      const byte1 = data[payloadOffset + 1];
      const byte2 = data[payloadOffset + 2];
      const byte3 = data[payloadOffset + 3];
      const byte4 = data[payloadOffset + 4];
      width = 1 + byte1 + ((byte2 & 0x3f) << 8);
      height = 1 + (byte2 >> 6) + (byte3 << 2) + ((byte4 & 0x0f) << 10);
      hasImageData = true;
    } else if (chunkType === 'VP8 ') {
      if (
        chunkLength < 10 ||
        data[payloadOffset + 3] !== 0x9d ||
        data[payloadOffset + 4] !== 0x01 ||
        data[payloadOffset + 5] !== 0x2a
      ) {
        return null;
      }
      width = data.readUInt16LE(payloadOffset + 6) & 0x3fff;
      height = data.readUInt16LE(payloadOffset + 8) & 0x3fff;
      hasImageData = true;
    } else if (chunkType === 'ANMF') {
      if (chunkLength < 16) return null;
      hasImageData = true;
    }

    offset = chunkEnd;
  }

  if (offset !== data.length || !hasImageData || width === 0 || height === 0) return null;
  return {
    format: SkinAssetFormat.Webp,
    extension: SkinAssetExtension.Webp,
    mimeType: SkinAssetMimeType.Webp,
    width,
    height,
  };
}

export function inspectSkinImage(data: Buffer): SkinImageInfo | null {
  return inspectPng(data) ?? inspectJpeg(data) ?? inspectWebp(data);
}
