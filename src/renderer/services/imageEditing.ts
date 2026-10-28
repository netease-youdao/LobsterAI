import { ImageEditOperation, ImageEditorEvent, type ImageEditRequest, type ImageRegion, type ImageVersion } from '../../shared/imageEditing/types';
import { store } from '../store';
import { addArtifact, openArtifactPreviewTab } from '../store/slices/artifactSlice';
import { type DraftAttachment, setDraftAttachments } from '../store/slices/coworkSlice';
import { requestImageEditorFocus, setImageRegions } from '../store/slices/imageEditorSlice';
import { ArtifactTypeValue } from '../types/artifact';
import { i18nService } from './i18n';
import { mergeImageEditDraft } from './imageEditDrafts';

export const imageEditTitle = (operation: ImageEditOperation): string => i18nService.t({
  [ImageEditOperation.Original]: 'imageEditOriginal', [ImageEditOperation.Markup]: 'imageEditMarkup',
  [ImageEditOperation.Comment]: 'imageEditComment', [ImageEditOperation.RemoveBackground]: 'imageEditRemoveBackground',
  [ImageEditOperation.Erase]: 'imageEditErase', [ImageEditOperation.Resize]: 'imageEditResize', [ImageEditOperation.Reframe]: 'imageEditAIReframe',
}[operation]);

export function imageEditAttachment(request: ImageEditRequest): DraftAttachment {
  return { path: request.source.filePath, name: request.source.title, isImage: true, imageEdit: request };
}

/** One source per draft. Ordinary attachments and the user's text remain untouched. */
export function setImageEditDraft(request: ImageEditRequest, replaceIds: string[] = []): boolean {
  const draftKey = request.source.sessionId;
  const attachments = store.getState().cowork.draftAttachments[draftKey] ?? [];
  const merged = mergeImageEditDraft(attachments, request, replaceIds);
  if (!merged) return false;
  store.dispatch(setDraftAttachments({ draftKey, attachments: merged }));
  return true;
}

export interface ImageEditSubmitEvent {
  request: ImageEditRequest;
  complete: (accepted: boolean, error?: string) => void;
}
export function submitImageEdit(request: ImageEditRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    const event = new CustomEvent<ImageEditSubmitEvent>(ImageEditorEvent.Submit, {
      cancelable: true,
      detail: { request, complete: (accepted, error) => accepted ? resolve() : reject(new Error(error ?? i18nService.t('imageEditBusy'))) },
    });
    window.dispatchEvent(event);
    if (!event.defaultPrevented) reject(new Error(i18nService.t('imageEditBusy')));
  });
}
export function focusImageEdit(source: ImageVersion, regionId?: string, regions?: ImageRegion[], operation?: ImageEditOperation): void {
  if (regions) store.dispatch(setImageRegions({ key: `${source.sessionId}:${source.id}`, regions }));
  const artifacts = store.getState().artifact.artifactsBySession[source.sessionId] ?? [];
  const existing = artifacts.find(artifact => artifact.filePath === source.filePath || artifact.filePath === source.originalPath);
  const artifactId = existing?.id ?? `image-edit-version-${source.id}`;
  if (!existing) store.dispatch(addArtifact({ sessionId: source.sessionId, artifact: {
    id: artifactId, sessionId: source.sessionId, messageId: '', type: ArtifactTypeValue.Image,
    title: source.title, content: '', filePath: source.filePath, createdAt: source.createdAt,
  } }));
  store.dispatch(openArtifactPreviewTab({ sessionId: source.sessionId, artifactId }));
  store.dispatch(requestImageEditorFocus({ id: crypto.randomUUID(), source, regionId, operation }));
}
