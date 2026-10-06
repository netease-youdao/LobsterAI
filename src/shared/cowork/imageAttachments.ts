export const COWORK_IMAGE_ATTACHMENT_MAX_BYTES = 30 * 1000 * 1000;
export const COWORK_IMAGE_ATTACHMENT_PREVIEW_FALLBACK_MAX_BYTES = 512 * 1024;

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
