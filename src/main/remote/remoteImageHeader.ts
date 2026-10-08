/** Header-only resource admission. Native decoding runs exclusively in a sandboxed renderer. */
export const RemoteImageBudget = { InputBytes: 24 * 1024 * 1024, Pixels: 16 * 1024 * 1024,
  Dimension: 8192, RssBytes: 384 * 1024 * 1024, OutputBytes: 24 * 1024 * 1024, TimeoutMs: 15000 } as const;
export function inspectRemoteImage(bytes: Buffer): { width: number; height: number; mimeType: string } {
  const invalid = (): never => { throw new Error('INPUT_UNSUPPORTED'); };
  let width = 0, height = 0, mimeType = '';
  if (bytes.length > RemoteImageBudget.InputBytes) invalid();
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.toString('ascii', 12, 16) === 'IHDR') {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); mimeType = 'image/png';
  } else if (bytes.length >= 10 && /^GIF8[79]a$/u.test(bytes.toString('ascii', 0, 6))) {
    width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8); mimeType = 'image/gif';
  } else if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const format = bytes.toString('ascii', 12, 16); mimeType = 'image/webp';
    if (format === 'VP8X' && (bytes[20] & 0x02)) invalid(); // Animated WebP.
    if (format === 'VP8X') { width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3); }
    else if (format === 'VP8L' && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21); width = 1 + (bits & 0x3fff); height = 1 + ((bits >>> 14) & 0x3fff);
    } else if (format === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff;
    }
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    mimeType = 'image/jpeg'; let offset = 2;
    // Reject files hiding frame dimensions behind unbounded metadata before decoding.
    while (offset + 9 <= Math.min(bytes.length, 512 * 1024)) {
      if (bytes[offset++] !== 0xff) invalid();
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > bytes.length) invalid();
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) invalid();
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  }
  if (!width || !height || width > RemoteImageBudget.Dimension || height > RemoteImageBudget.Dimension
    || width * height > RemoteImageBudget.Pixels) invalid();
  // Reject animated containers: a small first frame does not bound all native decoder work.
  if (mimeType === 'image/png') {
    let offset = 8, chunks = 0, ended = false;
    while (offset + 12 <= bytes.length && ++chunks <= 4096) {
      const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
      if (length > bytes.length - offset - 12 || type === 'acTL') invalid();
      offset += 12 + length;
      if (type === 'IEND') { ended = true; break; }
    }
    if (!ended) invalid();
  } else if (mimeType === 'image/gif') {
    if (bytes.length < 13) invalid();
    let offset = 13 + ((bytes[10] & 0x80) ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0), blocks = 0, frames = 0, ended = false;
    const skipData = (): void => {
      while (offset < bytes.length && ++blocks <= 4096) {
        const size = bytes[offset++];
        if (!size) return;
        offset += size;
      }
      invalid();
    };
    while (offset < bytes.length && ++blocks <= 4096) {
      const tag = bytes[offset++];
      if (tag === 0x3b) { ended = true; break; }
      if (tag === 0x21) { offset++; skipData(); }
      else if (tag === 0x2c) {
        if (++frames > 1 || offset + 9 > bytes.length) invalid();
        const frameWidth = bytes.readUInt16LE(offset + 4), frameHeight = bytes.readUInt16LE(offset + 6), flags = bytes[offset + 8];
        if (!frameWidth || !frameHeight || frameWidth > width || frameHeight > height) invalid();
        offset += 9 + ((flags & 0x80) ? 3 * 2 ** ((flags & 7) + 1) : 0);
        offset++; skipData(); // LZW minimum code size, then bounded data sub-blocks.
      } else invalid();
    }
    if (!ended || frames !== 1) invalid();
  }
  return { width, height, mimeType };
}
