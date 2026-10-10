import {
  DEFAULT_IMAGE_RESOURCE_LIMITS, sniffImageMime, type SupportedImageMime, validateRasterHeader,
} from '@docx-editor.dev/core/editor';

import { WORD_PACKAGE_LIMITS } from '../../../../shared/office/word/wordFile';

/** What the picture button offers. WebP and BMP are stored as PNG, which every Word and WPS version shows. */
export const WORD_IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/bmp';

export const WordImageError = {
  Empty: 'empty',
  /** The picture, or the document with it, exceeds what the editor can open again. */
  TooLarge: 'too-large',
  Unsupported: 'unsupported',
  /** The editor refused the insertion at the current selection. */
  Rejected: 'rejected',
} as const;
export type WordImageError = typeof WordImageError[keyof typeof WordImageError];

type StoredMime = Extract<SupportedImageMime, 'image/png' | 'image/jpeg' | 'image/gif'>;
const STORED_MIMES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif'] satisfies StoredMime[];
const CONVERTED_MIMES: readonly string[] = ['image/webp', 'image/bmp'] satisfies SupportedImageMime[];
/** A picture is one package part, and a document must stay within the limits it is opened with. */
const MAX_IMAGE_BYTES = Math.min(DEFAULT_IMAGE_RESOURCE_LIMITS.maxEncodedBytes, WORD_PACKAGE_LIMITS.maxPartBytes);
/** Pictures without a resolution are shown at 96 dpi, as Word does. */
const DEFAULT_DPI = 96;
const POINTS_PER_INCH = 72;

export interface WordImage {
  bytes: Uint8Array;
  mime: StoredMime;
  /** Natural size; the editor scales a picture down to fit where it is inserted. */
  widthPoints: number;
  heightPoints: number;
}

export type WordImageResult = { ok: true; image: WordImage } | { ok: false; error: WordImageError };
export type PngEncoder = (bytes: Uint8Array, mime: string) => Promise<Uint8Array>;

const failure = (error: WordImageError): WordImageResult => ({ ok: false, error });
const toPoints = (pixels: number, dpi: number) => Math.max(1, Math.round((pixels * POINTS_PER_INCH / dpi) * 100) / 100);

/** Re-encodes a picture the browser can decode as PNG. */
export async function encodeAsPng(bytes: Uint8Array, mime: string): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('No 2D canvas context');
    context.drawImage(bitmap, 0, 0);
    return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  } finally {
    bitmap.close();
  }
}

/**
 * Checks picture bytes before they reach the editor: the type comes from the bytes, never from a
 * file name or a claimed type, and the pixel size is read from the header before anything decodes.
 */
export async function prepareWordImage(bytes: Uint8Array, toPng: PngEncoder = encodeAsPng): Promise<WordImageResult> {
  if (!bytes.byteLength) return failure(WordImageError.Empty);
  if (bytes.byteLength > MAX_IMAGE_BYTES) return failure(WordImageError.TooLarge);
  const mime = sniffImageMime(bytes);
  if (!STORED_MIMES.includes(mime) && !CONVERTED_MIMES.includes(mime)) return failure(WordImageError.Unsupported);
  const header = validateRasterHeader(bytes, mime as SupportedImageMime);
  if (!header) return failure(WordImageError.Unsupported);
  const limits = DEFAULT_IMAGE_RESOURCE_LIMITS;
  if (header.pixelWidth > limits.maxDimension || header.pixelHeight > limits.maxDimension
    || header.pixelWidth * header.pixelHeight > limits.maxPixels) return failure(WordImageError.TooLarge);
  const size = {
    widthPoints: toPoints(header.pixelWidth, header.dpiX ?? DEFAULT_DPI),
    heightPoints: toPoints(header.pixelHeight, header.dpiY ?? DEFAULT_DPI),
  };
  if (STORED_MIMES.includes(mime)) return { ok: true, image: { bytes, mime: mime as StoredMime, ...size } };
  let png: Uint8Array;
  try {
    png = await toPng(bytes, mime);
  } catch (error) {
    console.warn('[WordEditor] Could not convert a picture to PNG:', error);
    return failure(WordImageError.Unsupported);
  }
  if (png.byteLength > MAX_IMAGE_BYTES) return failure(WordImageError.TooLarge);
  return { ok: true, image: { bytes: png, mime: 'image/png', ...size } };
}

/** The first picture file a paste or drop carries. */
export function imageFileOf(transfer: DataTransfer | null): File | null {
  if (!transfer) return null;
  const file = [...transfer.files].find(candidate => candidate.type.startsWith('image/'));
  if (file) return file;
  for (const item of transfer.items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) return item.getAsFile();
  }
  return null;
}

export function hasImageFile(transfer: DataTransfer | null): boolean {
  return Boolean(transfer && [...transfer.items].some(item => item.kind === 'file' && item.type.startsWith('image/')));
}
