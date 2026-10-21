/** Read dimensions before native decoding so compressed oversized images cannot exhaust memory. */
export function imageEditingHeader(bytes: Buffer): { width: number; height: number; extension: string; mime: string } {
  const invalid = () => { throw new Error('imageEditUnsupported'); };
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (bytes.length < 33 || bytes.toString('ascii', 12, 16) !== 'IHDR') return invalid();
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset);
      if (offset + length + 12 > bytes.length) return invalid();
      if (bytes.toString('ascii', offset + 4, offset + 8) === 'acTL') return invalid();
      offset += length + 12;
    }
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), extension: 'png', mime: 'image/png' };
  }
  if (bytes[0] === 255 && bytes[1] === 216) {
    for (let offset = 2; offset + 4 <= bytes.length;) {
      if (bytes[offset++] !== 255) return invalid();
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218 || offset + 2 > bytes.length) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return invalid();
      if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) {
        if (length < 8) return invalid();
        return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3), extension: 'jpg', mime: 'image/jpeg' };
      }
      offset += length;
    }
    return invalid();
  }
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    let size: { width: number; height: number } | undefined;
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const kind = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4), start = offset + 8;
      if (start + length > bytes.length || kind === 'ANIM') return invalid();
      if (kind === 'VP8X' && length >= 10) {
        if (bytes[start] & 2) return invalid();
        size = { width: bytes.readUIntLE(start + 4, 3) + 1, height: bytes.readUIntLE(start + 7, 3) + 1 };
      } else if (!size && kind === 'VP8 ' && length >= 10) {
        size = { width: bytes.readUInt16LE(start + 6) & 16383, height: bytes.readUInt16LE(start + 8) & 16383 };
      } else if (!size && kind === 'VP8L' && length >= 5 && bytes[start] === 47) {
        size = { width: 1 + ((bytes[start + 1] | bytes[start + 2] << 8) & 16383),
          height: 1 + ((bytes[start + 2] >> 6 | bytes[start + 3] << 2 | bytes[start + 4] << 10) & 16383) };
      }
      offset = start + length + (length & 1);
    }
    if (size) return { ...size, extension: 'webp', mime: 'image/webp' };
  }
  return invalid();
}
