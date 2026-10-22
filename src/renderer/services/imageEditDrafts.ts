import type { ImageEditRequest } from '../../shared/imageEditing/types';
import type { DraftAttachment } from '../store/slices/coworkSlice';

export function imageEditDraftConflicts(attachments: DraftAttachment[], request: ImageEditRequest): ImageEditRequest[] {
  return attachments.flatMap(attachment => attachment.imageEdit
    && (attachment.imageEdit.source.id !== request.source.id || attachment.imageEdit.operation !== request.operation)
    ? [attachment.imageEdit] : []);
}

/** Replacing a different operation requires approval for the exact drafts being replaced. */
export function mergeImageEditDraft(attachments: DraftAttachment[], request: ImageEditRequest, replaceIds: string[] = []): DraftAttachment[] | undefined {
  if (imageEditDraftConflicts(attachments, request).some(conflict => !replaceIds.includes(conflict.id))) return undefined;
  return [...attachments.filter(attachment => !attachment.imageEdit),
    { path: request.source.filePath, name: request.source.title, isImage: true, imageEdit: request }];
}
