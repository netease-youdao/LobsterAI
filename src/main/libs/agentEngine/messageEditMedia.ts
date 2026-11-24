import { type CoworkImageAttachmentPayload, stripDataUrlPrefix } from '../../../shared/cowork/imageAttachments';
import type { ImageEditMessageSnapshot, ImageEditRequest } from '../../../shared/imageEditing/types';
import type { CoworkMediaAttachmentRef } from './types';

/** A media reference as stored on a message: image bytes stay out of SQLite. */
export type PersistedMediaReference = Omit<CoworkMediaAttachmentRef, 'dataUrl'> & {
  /** Position in the message's image attachments of the payload a path-less reference points at. */
  attachmentIndex?: number;
  /** Written by early builds that stored the payload inline; still honoured when present. */
  dataUrl?: string;
};

const MEDIA_TOKEN_PATTERN = /@(图片|视频|音频)(\d+)/g;
const IMAGE_TOKEN_PREFIX = '@图片';
const IMAGE_REFERENCE_ROLE = 'reference_image';

const hasLocation = (ref: Pick<CoworkMediaAttachmentRef, 'localPath' | 'remoteUrl'>): boolean =>
  Boolean(ref.localPath || ref.remoteUrl);

function findPayloadIndex(ref: CoworkMediaAttachmentRef, attachments: CoworkImageAttachmentPayload[]): number | undefined {
  const base64 = ref.dataUrl ? stripDataUrlPrefix(ref.dataUrl) : '';
  const exact = base64 ? attachments.findIndex(attachment => attachment.base64Data === base64) : -1;
  if (exact >= 0) return exact;
  // Oversized images are re-encoded for the model, so their bytes no longer match the draft.
  const named = attachments.flatMap((attachment, index) =>
    !attachment.localPath && attachment.name === ref.fileName ? [index] : []);
  return named.length === 1 ? named[0] : undefined;
}

/** Drops inline payloads before a reference is written to message metadata. */
export function toPersistedMediaReferences(
  refs: CoworkMediaAttachmentRef[] | undefined,
  attachments: CoworkImageAttachmentPayload[] | undefined,
): PersistedMediaReference[] | undefined {
  if (!refs?.length) return undefined;
  return refs.map(ref => {
    const { dataUrl, ...rest } = ref;
    if (!dataUrl || hasLocation(ref)) return rest;
    const attachmentIndex = findPayloadIndex(ref, attachments ?? []);
    return attachmentIndex === undefined ? rest : { ...rest, attachmentIndex };
  });
}

/**
 * Rebuilds runtime references from their stored form. `attachments` maps the
 * original image index to its restored payload. Returns null when a path-less
 * reference can no longer be backed by an attachment.
 */
export function restoreMediaReferences(
  refs: PersistedMediaReference[] | undefined,
  attachments: ReadonlyMap<number, CoworkImageAttachmentPayload>,
): CoworkMediaAttachmentRef[] | null | undefined {
  if (!refs?.length) return undefined;
  const restored: CoworkMediaAttachmentRef[] = [];
  for (const { attachmentIndex, ...ref } of refs) {
    if (hasLocation(ref) || ref.dataUrl) {
      restored.push(ref);
      continue;
    }
    const attachment = attachmentIndex === undefined ? undefined : attachments.get(attachmentIndex);
    if (!attachment) return null;
    restored.push({ ...ref, dataUrl: `data:${attachment.mimeType};base64,${attachment.base64Data}` });
  }
  return restored;
}

export function mediaTokensInPrompt(prompt: string): Set<string> {
  return new Set(Array.from(prompt.matchAll(MEDIA_TOKEN_PATTERN), match => match[0]));
}

/** A reference only applies while its @ token is still written in the prompt. */
export function filterMediaReferencesByPrompt(
  refs: CoworkMediaAttachmentRef[] | undefined,
  prompt: string,
): CoworkMediaAttachmentRef[] | undefined {
  if (!refs?.length) return undefined;
  const tokens = mediaTokensInPrompt(prompt);
  const kept = refs.filter(ref => tokens.has(ref.token));
  return kept.length ? kept : undefined;
}

/**
 * Image-edit messages sent before edit context was recorded keep only a
 * snapshot. The staged request and the source image path identify the same
 * reference the composer built, so it can be reconstructed exactly. Returns
 * null whenever the mapping is not certain.
 */
export function rebuildLegacyImageEditReferences(input: {
  originalPrompt: string;
  snapshots: ImageEditMessageSnapshot[];
  images: ReadonlyArray<{ name: string; localPath?: string; mimeType: string; originalMimeType?: string }>;
  resolveRequest: (requestId: string) => ImageEditRequest | undefined;
}): CoworkMediaAttachmentRef[] | null {
  const imageTokens = [...mediaTokensInPrompt(input.originalPrompt)].filter(token => token.startsWith(IMAGE_TOKEN_PREFIX));
  const refs: CoworkMediaAttachmentRef[] = [];
  for (const snapshot of input.snapshots) {
    const request = input.resolveRequest(snapshot.requestId);
    if (!request) return null;
    const matches = input.images.flatMap((image, index) => image.localPath === request.source.filePath ? [index] : []);
    if (matches.length !== 1) return null;
    const image = input.images[matches[0]];
    // The composer numbers image attachments in order; a lone token is unambiguous either way.
    const indexed = `${IMAGE_TOKEN_PREFIX}${matches[0] + 1}`;
    const token = input.snapshots.length === 1 && imageTokens.length === 1 ? imageTokens[0] : indexed;
    if (!imageTokens.includes(token) || refs.some(ref => ref.token === token)) return null;
    refs.push({
      token,
      mediaType: 'image',
      index: Number(token.slice(IMAGE_TOKEN_PREFIX.length)),
      fileId: request.source.filePath,
      fileName: image.name,
      mimeType: image.originalMimeType ?? image.mimeType,
      localPath: request.source.filePath,
      role: IMAGE_REFERENCE_ROLE,
      imageEdit: request,
    });
  }
  return refs.length ? refs : null;
}

/** Identifies an image by its signature; file names and stored labels can be stale. */
export function sniffImageMimeType(bytes: Uint8Array): string | undefined {
  const startsWith = (signature: number[], offset = 0) => signature.every((value, index) => bytes[offset + index] === value);
  if (startsWith([0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith([0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  if (startsWith([0x42, 0x4d])) return 'image/bmp';
  return undefined;
}
