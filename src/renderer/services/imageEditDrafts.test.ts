import { describe, expect, test } from 'vitest';

import { ImageEditOperation, type ImageEditRequest } from '../../shared/imageEditing/types';
import type { DraftAttachment } from '../store/slices/coworkSlice';
import { prepareCoworkPromptPayload } from './coworkPromptPayload';
import { mergeImageEditDraft } from './imageEditDrafts';

const request: ImageEditRequest = {
  id: 'remove-background', operation: ImageEditOperation.RemoveBackground, createdAt: 1, regions: [],
  source: { id: 'source', rootId: 'root', sessionId: 'session', title: 'cup.png', filePath: '/frozen/cup.png',
    width: 2048, height: 2048, operation: ImageEditOperation.Original, createdAt: 1 },
};
const ordinary: DraftAttachment[] = [{ path: '/notes.txt', name: 'notes.txt' }, { path: '/reference.png', name: 'reference.png', isImage: true }];
const draft = (edit: ImageEditRequest) => ({ path: edit.source.filePath, name: edit.source.title, imageEdit: edit, isImage: true });

describe('image edit drafts', () => {
  test('stages background removal while preserving ordinary attachments and composer text in the send payload', async () => {
    const attachments = mergeImageEditDraft(ordinary, request)!;
    expect(attachments.slice(0, 2)).toEqual(ordinary);
    const payload = await prepareCoworkPromptPayload({ basePrompt: 'My existing draft', attachments,
      modelSupportsImage: false, selectedTextSnippets: [], fileLabel: 'File', folderLabel: 'Folder' });
    expect(payload.success).toBe(true);
    if (!payload.success) return;
    expect(payload.payload.finalPrompt).toContain('My existing draft');
    expect(payload.payload.finalPrompt).toContain('notes.txt');
    expect(payload.payload.mediaReferences?.find(reference => reference.imageEdit)?.imageEdit).toEqual(request);
  });
  test('updates the same operation on the same image without duplicating cards', () => {
    const updated = mergeImageEditDraft([...ordinary, draft({ ...request, id: 'old' })], request)!;
    expect(updated).toHaveLength(3);
    expect(updated[2].imageEdit?.id).toBe(request.id);
  });
  test('requires confirmation when replacing comments, even on the same source', () => {
    const comment = { ...request, id: 'comment', operation: ImageEditOperation.Comment, regions: [
      { id: 'region', x: 0.1, y: 0.2, width: 0.3, height: 0.4, text: 'Make this blue' },
    ] };
    const attachments = [...ordinary, draft(comment)];
    expect(mergeImageEditDraft(attachments, request)).toBeUndefined();
    expect(attachments[2].imageEdit).toEqual(comment);
    expect(mergeImageEditDraft(attachments, request, ['comment'])).toEqual([...ordinary, draft(request)]);
  });
  test('never applies stale replacement permission to a newly changed draft or another source', () => {
    const different = { ...request, id: 'other', source: { ...request.source, id: 'other-image' } };
    expect(mergeImageEditDraft([draft(different)], request)).toBeUndefined();
    expect(mergeImageEditDraft([draft(different)], request, ['previous-draft'])).toBeUndefined();
    expect(mergeImageEditDraft([draft(different)], request, ['other'])).toEqual([draft(request)]);
  });
});
