export const COWORK_IMAGE_ATTACHMENT_MAX_BYTES = 30 * 1000 * 1000;
/**
 * OpenClaw's gateway rejects any single chat image above this (media-core `MAX_IMAGE_BYTES`),
 * regardless of `agents.defaults.mediaMaxMb`. Larger images are re-encoded before sending.
 */
export const COWORK_IMAGE_ATTACHMENT_MODEL_MAX_BYTES = 6 * 1024 * 1024;
export const COWORK_IMAGE_ATTACHMENT_PREVIEW_FALLBACK_MAX_BYTES = 512 * 1024;

export const SniffableImageMimeType = {
  Png: 'image/png',
  Jpeg: 'image/jpeg',
  Gif: 'image/gif',
  Webp: 'image/webp',
  Bmp: 'image/bmp',
} as const;
export type SniffableImageMimeType = typeof SniffableImageMimeType[keyof typeof SniffableImageMimeType];

const SNIFFABLE_IMAGE_MIME_SET = new Set<string>(Object.values(SniffableImageMimeType));

export function isSniffableImageMimeType(mimeType: string | undefined): mimeType is SniffableImageMimeType {
  return typeof mimeType === 'string' && SNIFFABLE_IMAGE_MIME_SET.has(mimeType.toLowerCase());
}

/** Identifies an image by its signature when the file name or stored MIME type is unavailable or stale. */
export function sniffImageMimeType(bytes: Uint8Array): SniffableImageMimeType | undefined {
  const startsWith = (signature: number[], offset = 0) =>
    bytes.length >= offset + signature.length
    && signature.every((value, index) => bytes[offset + index] === value);
  if (startsWith([0x89, 0x50, 0x4e, 0x47])) return SniffableImageMimeType.Png;
  if (startsWith([0xff, 0xd8, 0xff])) return SniffableImageMimeType.Jpeg;
  if (startsWith([0x47, 0x49, 0x46, 0x38])) return SniffableImageMimeType.Gif;
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) return SniffableImageMimeType.Webp;
  if (startsWith([0x42, 0x4d])) return SniffableImageMimeType.Bmp;
  return undefined;
}

export interface ImageDimensions {
  width: number;
  height: number;
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 8) | bytes[offset + 1]) >>> 0;
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8)) >>> 0;
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)) >>> 0;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) >>> 0)
    + ((bytes[offset + 1] << 16) >>> 0)
    + ((bytes[offset + 2] << 8) >>> 0)
    + bytes[offset + 3]
  );
}

function readInt32LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
}

function readJpegDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) break;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const segmentLength = readUint16BE(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame && segmentLength >= 7) {
      const height = readUint16BE(bytes, offset + 3);
      const width = readUint16BE(bytes, offset + 5);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    offset += segmentLength;
  }
  return undefined;
}

function readWebpDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 30) return undefined;
  const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (chunk === 'VP8X') {
    const width = readUint24LE(bytes, 24) + 1;
    const height = readUint24LE(bytes, 27) + 1;
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) return undefined;
    const b0 = bytes[21];
    const b1 = bytes[22];
    const b2 = bytes[23];
    const b3 = bytes[24];
    const width = (b0 | ((b1 & 0x3f) << 8)) + 1;
    const height = (((b1 & 0xc0) >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)) + 1;
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  if (chunk === 'VP8 ') {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return undefined;
    const width = readUint16LE(bytes, 26) & 0x3fff;
    const height = readUint16LE(bytes, 28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  return undefined;
}

/**
 * Reads raster image dimensions directly from binary headers so formats that
 * Electron's `nativeImage` cannot decode (such as WebP and GIF) still validate
 * their true pixel size.
 */
export function readImageDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  const mime = sniffImageMimeType(bytes);
  if (!mime) return undefined;
  switch (mime) {
    case SniffableImageMimeType.Png: {
      if (bytes.length < 24) return undefined;
      if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return undefined;
      const width = readUint32BE(bytes, 16);
      const height = readUint32BE(bytes, 20);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    case SniffableImageMimeType.Jpeg:
      return readJpegDimensions(bytes);
    case SniffableImageMimeType.Gif: {
      if (bytes.length < 10) return undefined;
      const width = readUint16LE(bytes, 6);
      const height = readUint16LE(bytes, 8);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    case SniffableImageMimeType.Webp:
      return readWebpDimensions(bytes);
    case SniffableImageMimeType.Bmp: {
      if (bytes.length < 26) return undefined;
      const width = Math.abs(readInt32LE(bytes, 18));
      const height = Math.abs(readInt32LE(bytes, 22));
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
  }
}

export const CoworkImageAttachmentRole = {
  /** Browser-annotation screenshot attached only as model transport. */
  BrowserAnnotation: 'browser-annotation',
} as const;
export type CoworkImageAttachmentRole =
  typeof CoworkImageAttachmentRole[keyof typeof CoworkImageAttachmentRole];

export type CoworkImageAttachmentPayload = {
  name: string;
  mimeType: string;
  base64Data: string;
  sizeBytes?: number;
  localPath?: string;
  /** App-private copy of an original that has no file of its own, such as a pasted image. */
  retainedOriginalPath?: string;
  previewMimeType?: string;
  previewBase64Data?: string;
  role?: CoworkImageAttachmentRole;
};

export type CoworkImageAttachmentPreview = {
  name: string;
  mimeType: string;
  base64Data: string;
  originalMimeType: string;
  originalSizeBytes: number;
  localPath?: string;
  retainedOriginalPath?: string;
  isPreview: true;
  role?: CoworkImageAttachmentRole;
};

/** Historical transport images predate the role marker; match their fixed name pattern. */
const LEGACY_BROWSER_ANNOTATION_IMAGE_NAME_PREFIXES = [
  '浏览器注释截图-',
  'Browser annotation screenshot-',
];

export function isBrowserAnnotationTransportImage(
  image: Pick<CoworkImageAttachmentPayload, 'name' | 'role'>,
): boolean {
  if (image.role === CoworkImageAttachmentRole.BrowserAnnotation) return true;
  const name = image.name ?? '';
  return LEGACY_BROWSER_ANNOTATION_IMAGE_NAME_PREFIXES.some(prefix => name.startsWith(prefix));
}

export type CoworkImageAttachmentSizeValidation = {
  ok: boolean;
  sizeBytes: number;
  maxBytes: number;
};

export function stripDataUrlPrefix(value: string): string {
  const match = /^data:[^;]+;base64,(.*)$/s.exec(value.trim());
  return match ? match[1] : value.trim();
}

export function estimateBase64DecodedBytes(base64Value: string): number {
  const base64 = stripDataUrlPrefix(base64Value).replace(/\s+/g, '');
  if (!base64) return 0;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

export function formatCoworkImageAttachmentLimit(bytes = COWORK_IMAGE_ATTACHMENT_MAX_BYTES): string {
  return `${Math.floor(bytes / 1000 / 1000)}MB`;
}

export function validateCoworkImageAttachmentSize(
  attachment: Pick<CoworkImageAttachmentPayload, 'base64Data' | 'sizeBytes'>,
  maxBytes = COWORK_IMAGE_ATTACHMENT_MAX_BYTES,
): CoworkImageAttachmentSizeValidation {
  const declaredSizeBytes = typeof attachment.sizeBytes === 'number' && Number.isFinite(attachment.sizeBytes)
    ? Math.max(0, Math.floor(attachment.sizeBytes))
    : 0;
  const estimatedSizeBytes = estimateBase64DecodedBytes(attachment.base64Data);
  const sizeBytes = Math.max(declaredSizeBytes, estimatedSizeBytes);

  return {
    ok: sizeBytes > 0 && sizeBytes <= maxBytes,
    sizeBytes,
    maxBytes,
  };
}

export function buildCoworkImageAttachmentPreview(
  attachment: CoworkImageAttachmentPayload,
): CoworkImageAttachmentPreview | undefined {
  const sizeValidation = validateCoworkImageAttachmentSize(attachment);
  const previewBase64Data = attachment.previewBase64Data?.trim();
  const previewMimeType = attachment.previewMimeType?.trim() || attachment.mimeType;

  if (previewBase64Data) {
    return {
      name: attachment.name,
      mimeType: previewMimeType,
      base64Data: stripDataUrlPrefix(previewBase64Data),
      originalMimeType: attachment.mimeType,
      originalSizeBytes: sizeValidation.sizeBytes,
      ...(attachment.localPath ? { localPath: attachment.localPath } : {}),
      ...(attachment.retainedOriginalPath ? { retainedOriginalPath: attachment.retainedOriginalPath } : {}),
      ...(attachment.role ? { role: attachment.role } : {}),
      isPreview: true,
    };
  }

  if (sizeValidation.sizeBytes <= COWORK_IMAGE_ATTACHMENT_PREVIEW_FALLBACK_MAX_BYTES) {
    return {
      name: attachment.name,
      mimeType: attachment.mimeType,
      base64Data: stripDataUrlPrefix(attachment.base64Data),
      originalMimeType: attachment.mimeType,
      originalSizeBytes: sizeValidation.sizeBytes,
      ...(attachment.localPath ? { localPath: attachment.localPath } : {}),
      ...(attachment.retainedOriginalPath ? { retainedOriginalPath: attachment.retainedOriginalPath } : {}),
      ...(attachment.role ? { role: attachment.role } : {}),
      isPreview: true,
    };
  }

  return undefined;
}

export function buildCoworkImageAttachmentPreviews(
  attachments: CoworkImageAttachmentPayload[] | undefined,
): CoworkImageAttachmentPreview[] | undefined {
  const previews = attachments
    ?.map(buildCoworkImageAttachmentPreview)
    .filter((preview): preview is CoworkImageAttachmentPreview => Boolean(preview));

  return previews?.length ? previews : undefined;
}

/**
 * Small images are stored whole instead of as a thumbnail, so the stored bytes
 * are the original that was sent.
 */
export function isStoredOriginalImagePreview(preview: CoworkImageAttachmentPreview): boolean {
  return preview.mimeType === preview.originalMimeType
    && estimateBase64DecodedBytes(preview.base64Data) === preview.originalSizeBytes;
}
