export const DelimitedTextEncoding = {
  Auto: 'auto',
  Utf8: 'utf-8',
  Gb18030: 'gb18030',
  Utf16Le: 'utf-16le',
  Utf16Be: 'utf-16be',
  Big5: 'big5',
} as const;
export type DelimitedTextEncoding = typeof DelimitedTextEncoding[keyof typeof DelimitedTextEncoding];
type ExplicitEncoding = Exclude<DelimitedTextEncoding, typeof DelimitedTextEncoding.Auto>;

export const DelimitedTextEncodingSource = {
  Bom: 'bom',
  Utf8: 'utf8',
  Fallback: 'fallback',
  Manual: 'manual',
} as const;
export type DelimitedTextEncodingSource = typeof DelimitedTextEncodingSource[keyof typeof DelimitedTextEncodingSource];

export const DelimitedTextEncodingError = {
  Invalid: 'invalid',
  UnsupportedBom: 'unsupported-bom',
} as const;
export type DelimitedTextEncodingError = typeof DelimitedTextEncodingError[keyof typeof DelimitedTextEncodingError];

export interface DecodedDelimitedText {
  text: string;
  encoding: ExplicitEncoding;
  source: DelimitedTextEncodingSource;
}

export type DelimitedTextDecodeResult =
  | { ok: true; decoded: DecodedDelimitedText }
  | { ok: false; error: DelimitedTextEncodingError };

/** Decode only in memory. Never replace invalid bytes or infer encoding from a filename/OS locale. */
export function decodeDelimitedText(
  bytes: Uint8Array,
  selection: DelimitedTextEncoding = DelimitedTextEncoding.Auto,
): DelimitedTextDecodeResult {
  // Check four-byte signatures before UTF-16LE's shared FF FE prefix.
  if (startsWith(bytes, [0xff, 0xfe, 0x00, 0x00]) || startsWith(bytes, [0x00, 0x00, 0xfe, 0xff])) {
    return { ok: false, error: DelimitedTextEncodingError.UnsupportedBom };
  }

  if (selection !== DelimitedTextEncoding.Auto) {
    return decode(bytes, selection, DelimitedTextEncodingSource.Manual);
  }

  const bomEncoding = startsWith(bytes, [0xef, 0xbb, 0xbf]) ? DelimitedTextEncoding.Utf8
    : startsWith(bytes, [0xff, 0xfe]) ? DelimitedTextEncoding.Utf16Le
      : startsWith(bytes, [0xfe, 0xff]) ? DelimitedTextEncoding.Utf16Be : null;
  // A declared but malformed encoding must not silently fall back to another one.
  if (bomEncoding) return decode(bytes, bomEncoding, DelimitedTextEncodingSource.Bom);

  const utf8 = decode(bytes, DelimitedTextEncoding.Utf8, DelimitedTextEncodingSource.Utf8);
  if (utf8.ok) return utf8;
  // Successful decoding is compatibility, not positive identification (e.g. Big5 can also pass).
  return decode(bytes, DelimitedTextEncoding.Gb18030, DelimitedTextEncodingSource.Fallback);
}

function decode(bytes: Uint8Array, encoding: ExplicitEncoding, source: DelimitedTextEncodingSource): DelimitedTextDecodeResult {
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    // NULs commonly indicate BOM-less UTF-16 read as an ASCII-compatible encoding.
    // Keep the selector available so the user can explicitly choose the byte order.
    if (text.includes('\0')) return { ok: false, error: DelimitedTextEncodingError.Invalid };
    return { ok: true, decoded: { text, encoding, source } };
  } catch {
    return { ok: false, error: DelimitedTextEncodingError.Invalid };
  }
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

// Only user choices are remembered, not detection results or decoded contents. Refreshes decode
// the latest bytes again. This renderer-lifetime cache never writes preferences into source files.
const selections = new Map<string, DelimitedTextEncoding>();

export function getDelimitedTextEncoding(fileKey: string): DelimitedTextEncoding {
  return selections.get(fileKey) ?? DelimitedTextEncoding.Auto;
}

export function rememberDelimitedTextEncoding(fileKey: string, encoding: DelimitedTextEncoding): void {
  if (encoding === DelimitedTextEncoding.Auto) selections.delete(fileKey);
  else selections.set(fileKey, encoding);
}
