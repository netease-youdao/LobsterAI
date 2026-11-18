import fs from 'node:fs/promises';

import {
  COWORK_IMAGE_ATTACHMENT_MAX_BYTES,
  COWORK_IMAGE_ATTACHMENT_MODEL_MAX_BYTES,
  COWORK_IMAGE_ATTACHMENT_PREVIEW_FALLBACK_MAX_BYTES,
  type CoworkImageAttachmentPayload,
  type CoworkImageAttachmentPreview,
  isBrowserAnnotationTransportImage,
  isStoredOriginalImagePreview,
} from '../../../shared/cowork/imageAttachments';
import type { CoworkMessageEditRequest } from '../../../shared/cowork/messageEdit';
import type { ImageEditRequest } from '../../../shared/imageEditing/types';
import type { CoworkMessage } from '../../coworkStore';
import { t } from '../../i18n';
import {
  filterMediaReferencesByPrompt,
  type PersistedMediaReference,
  rebuildLegacyImageEditReferences,
  restoreMediaReferences,
  sniffImageMimeType,
} from './messageEditMedia';
import type { CoworkContinueOptions, CoworkMediaAttachmentRef } from './types';

export interface PrepareMessageEditDeps {
  /** Looks up a staged image-edit request; undefined once it no longer exists. */
  resolveImageEdit?: (sessionId: string, requestId: string) => ImageEditRequest | undefined;
  /** Re-encodes an original above the per-image model limit. */
  fitImage?: (bytes: Buffer, maxBytes: number) => { bytes: Buffer; mimeType: string };
  /** Reports whether the edit can be prepared, without loading attachment bytes. */
  validateOnly?: boolean;
}

type StoredImage = CoworkImageAttachmentPayload | CoworkImageAttachmentPreview;

async function restoreAttachment(image: StoredImage, deps: PrepareMessageEditDeps): Promise<CoworkImageAttachmentPayload> {
  if (!('isPreview' in image && image.isPreview)) return { ...image };
  const storedOriginal = isStoredOriginalImagePreview(image);
  const identity = {
    name: image.name,
    ...(image.localPath ? { localPath: image.localPath } : {}),
    ...(image.retainedOriginalPath ? { retainedOriginalPath: image.retainedOriginalPath } : {}),
    ...(image.role ? { role: image.role } : {}),
  };
  const stored = { ...identity, mimeType: image.originalMimeType, base64Data: image.base64Data };
  const sourcePath = image.localPath ?? image.retainedOriginalPath;
  let bytes: Buffer | undefined;
  if (sourcePath) {
    try {
      const stat = await fs.stat(sourcePath);
      if (!stat.isFile() || stat.size > COWORK_IMAGE_ATTACHMENT_MAX_BYTES) throw new Error('Attachment is unavailable.');
      if (deps.validateOnly) return stored;
      bytes = await fs.readFile(sourcePath);
    } catch {
      // A small image is stored whole on the message, so a missing file loses nothing.
      if (!storedOriginal) throw new Error(t('coworkEditMissingAttachment'));
    }
  }
  if (!bytes) {
    // Never substitute a thumbnail for the original.
    if (!storedOriginal) throw new Error(t('coworkEditMissingAttachment'));
    return stored;
  }
  let mimeType = sniffImageMimeType(bytes) ?? image.originalMimeType;
  if (bytes.length > COWORK_IMAGE_ATTACHMENT_MODEL_MAX_BYTES) {
    try {
      if (!deps.fitImage) throw new Error('No image re-encoder is available.');
      ({ bytes, mimeType } = deps.fitImage(bytes, COWORK_IMAGE_ATTACHMENT_MODEL_MAX_BYTES));
    } catch (error) {
      console.warn('[CoworkEdit] could not fit an original image within the model limit:', error);
      throw new Error(t('coworkEditImageTooLarge'));
    }
  }
  return {
    ...identity, mimeType, base64Data: bytes.toString('base64'),
    // The resent message needs its thumbnail again; large originals are never stored whole.
    ...(bytes.length > COWORK_IMAGE_ATTACHMENT_PREVIEW_FALLBACK_MAX_BYTES
      ? { previewMimeType: image.mimeType, previewBase64Data: image.base64Data } : {}),
  };
}

/** Restore attachments before touching either transcript. Never substitute a thumbnail. */
export async function prepareMessageEdit(
  message: CoworkMessage | null,
  request: CoworkMessageEditRequest,
  deps: PrepareMessageEditDeps = {},
): Promise<CoworkContinueOptions> {
  if (!message || message.type !== 'user' || typeof request.prompt !== 'string'
    || !request.sessionId || !request.messageId) throw new Error(t('coworkEditUnsupported'));
  const metadata = message.metadata ?? {};
  if (metadata.goalSetting) throw new Error(t('coworkEditUnsupported'));
  const editContext = metadata.editContext as (Pick<CoworkContinueOptions, 'skillIds' | 'mediaSelection' | 'workflowKind'>
    & { imageAttachmentCount?: number; mediaReferences?: PersistedMediaReference[] }) | undefined;
  const previews = metadata.imageAttachmentPreviews ?? [];
  const originals = metadata.imageAttachments ?? [];
  const images: StoredImage[] = previews.length ? previews : originals;
  if (editContext?.imageAttachmentCount !== undefined && editContext.imageAttachmentCount !== images.length) {
    throw new Error(t('coworkEditUnsupported'));
  }
  const removed = new Set(request.removedImageIndexes ?? []);
  for (const index of removed) {
    if (!Number.isInteger(index) || index < 0 || index >= images.length
      || isBrowserAnnotationTransportImage(images[index])) throw new Error(t('coworkEditUnsupported'));
  }
  const storedReferences = editContext?.mediaReferences;
  // Transport indices belong to browser annotations. Keep their ordering stable.
  if (removed.size && (metadata.browserAnnotations?.length || storedReferences?.length)) {
    throw new Error(t('coworkEditUnsupported'));
  }
  // Image edits sent before edit context was recorded: rebuild the reference
  // from the staged request, or let the user detach every source image so the
  // replacement becomes an ordinary text message.
  let legacyReferences: CoworkMediaAttachmentRef[] | undefined;
  if (metadata.imageEdits?.length && !storedReferences?.length
    && (!images.length || removed.size !== images.length)) {
    const rebuilt = removed.size ? null : rebuildLegacyImageEditReferences({
      originalPrompt: message.content,
      snapshots: metadata.imageEdits,
      images,
      resolveRequest: requestId => deps.resolveImageEdit?.(request.sessionId, requestId),
    });
    if (!rebuilt) throw new Error(t('coworkEditLegacyImageContext'));
    legacyReferences = rebuilt;
  }
  const attachments: CoworkImageAttachmentPayload[] = [];
  const attachmentsByIndex = new Map<number, CoworkImageAttachmentPayload>();
  for (const [index, image] of images.entries()) {
    if (removed.has(index)) continue;
    const attachment = await restoreAttachment(image, deps);
    attachments.push(attachment);
    attachmentsByIndex.set(index, attachment);
  }
  if (!request.prompt.trim() && !attachments.length && !metadata.browserAnnotations?.length) throw new Error(t('coworkEditEmpty'));
  const references = legacyReferences ?? restoreMediaReferences(storedReferences, attachmentsByIndex);
  if (references === null) throw new Error(t('coworkEditMissingAttachment'));
  return {
    skillIds: editContext?.skillIds ?? metadata.skillIds,
    messageSkillIds: metadata.skillIds,
    kitIds: metadata.kitIds,
    kitReferences: metadata.kitReferences,
    resolvedKitCapabilities: metadata.resolvedKitCapabilities,
    imageAttachments: attachments,
    mediaSelection: editContext?.mediaSelection,
    workflowKind: editContext?.workflowKind,
    mediaReferences: filterMediaReferencesByPrompt(references, request.prompt),
    selectedTextSnippets: metadata.selectedTextSnippets,
    browserAnnotations: metadata.browserAnnotations,
  };
}
