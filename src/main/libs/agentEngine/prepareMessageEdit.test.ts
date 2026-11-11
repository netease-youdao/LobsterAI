import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  buildCoworkImageAttachmentPreviews,
  COWORK_IMAGE_ATTACHMENT_MODEL_MAX_BYTES,
  COWORK_IMAGE_ATTACHMENT_PREVIEW_FALLBACK_MAX_BYTES,
  type CoworkImageAttachmentPreview,
  CoworkImageAttachmentRole,
} from '../../../shared/cowork/imageAttachments';
import { type ImageEditMessageSnapshot, ImageEditOperation, type ImageEditRequest } from '../../../shared/imageEditing/types';
import type { CoworkMessage } from '../../coworkStore';
import { t } from '../../i18n';
import { prepareMessageEdit } from './prepareMessageEdit';

const request = { sessionId: 'session', messageId: 'message', prompt: 'Corrected request' };
const legacyImageEdit: ImageEditMessageSnapshot = {
  requestId: 'legacy-image-edit', operation: ImageEditOperation.Reframe, regions: [],
  source: { id: 'source', rootId: 'source', sessionId: request.sessionId, filePath: '/missing/source.png',
    title: 'source.png', width: 1, height: 1, operation: ImageEditOperation.Original, createdAt: 1 },
};
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function writeTemp(name: string, content: string | Buffer): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cowork-message-edit-'));
  directories.push(directory);
  const filePath = path.join(directory, name);
  await fs.writeFile(filePath, content);
  return filePath;
}

function message(previews: CoworkImageAttachmentPreview[]): CoworkMessage {
  return { id: 'message', type: 'user', content: 'Original', timestamp: 1,
    metadata: { imageAttachmentPreviews: previews, skillIds: ['selected-skill'], kitIds: ['selected-kit'] } };
}

function preview(localPath?: string): CoworkImageAttachmentPreview {
  return { name: 'original.png', mimeType: 'image/webp', base64Data: 'thumbnail',
    originalMimeType: 'image/png', originalSizeBytes: 9, isPreview: true, localPath };
}

describe('prepare message edits before rewind', () => {
  test('restores original bytes and MIME instead of the display thumbnail, preserving context', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cowork-message-edit-'));
    directories.push(directory);
    const localPath = path.join(directory, 'original.png');
    await fs.writeFile(localPath, 'original!');
    const prepared = await prepareMessageEdit(message([preview(localPath)]), request);
    expect(prepared.imageAttachments).toEqual([expect.objectContaining({
      base64Data: Buffer.from('original!').toString('base64'), mimeType: 'image/png', localPath,
    })]);
    expect(prepared).toMatchObject({ skillIds: ['selected-skill'], messageSkillIds: ['selected-skill'], kitIds: ['selected-kit'] });
  });

  test('fails on a missing original, but allows explicitly removing that attachment', async () => {
    const original = message([preview()]);
    await expect(prepareMessageEdit(original, request)).rejects.toThrow();
    const prepared = await prepareMessageEdit(original, { ...request, removedImageIndexes: [0] });
    expect(prepared.imageAttachments).toEqual([]);
  });

  test('retains legacy original payloads without treating them as thumbnails', async () => {
    const original = message([]);
    original.metadata!.imageAttachments = [{ name: 'legacy.png', mimeType: 'image/png', base64Data: 'b3JpZ2luYWw=' }];
    expect((await prepareMessageEdit(original, request)).imageAttachments).toEqual(original.metadata!.imageAttachments);
  });

  test('rejects invalid indexes, transport removal, and an empty replacement', async () => {
    await expect(prepareMessageEdit(message([preview()]), { ...request, removedImageIndexes: [1] })).rejects.toThrow();
    await expect(prepareMessageEdit(message([{ ...preview(), role: CoworkImageAttachmentRole.BrowserAnnotation }]),
      { ...request, removedImageIndexes: [0] })).rejects.toThrow();
    await expect(prepareMessageEdit(message([]), { ...request, prompt: ' ' })).rejects.toThrow();
  });

  test('rejects incomplete attachment metadata instead of silently dropping images', async () => {
    const original = message([]);
    original.metadata!.editContext = { imageAttachmentCount: 1 };
    await expect(prepareMessageEdit(original, request)).rejects.toThrow();
  });

  test('allows a legacy image-edit message to become text when all original images are explicitly removed', async () => {
    const original = message([preview()]);
    original.metadata!.imageEdits = [legacyImageEdit];
    const prepared = await prepareMessageEdit(original, { ...request, removedImageIndexes: [0] });
    expect(prepared.imageAttachments).toEqual([]);
    expect(prepared.mediaReferences).toBeUndefined();
    expect(prepared.workflowKind).toBeUndefined();
    expect(prepared.kitIds).toEqual(['selected-kit']);
  });

  test('still rejects legacy image edits with retained or missing source metadata', async () => {
    const original = message([preview(), preview()]);
    original.metadata!.imageEdits = [legacyImageEdit];
    await expect(prepareMessageEdit(original, request)).rejects.toThrow(t('coworkEditLegacyImageContext'));
    await expect(prepareMessageEdit(original, { ...request, removedImageIndexes: [0] })).rejects.toThrow(t('coworkEditLegacyImageContext'));
    original.metadata!.imageAttachmentPreviews = [];
    await expect(prepareMessageEdit(original, request)).rejects.toThrow();
  });

  test('preserves immutable media references and refuses to detach their source images', async () => {
    const original = message([preview()]);
    const mediaReferences = [{ token: '@图片1', mediaType: 'image', index: 1, fileId: 'version-1',
      fileName: 'version.png', mimeType: 'image/png', localPath: '/versions/version-1.png' }];
    original.metadata!.editContext = { mediaReferences, imageAttachmentCount: 1 };
    await expect(prepareMessageEdit(original, { ...request, removedImageIndexes: [0] })).rejects.toThrow();
    original.metadata!.imageAttachmentPreviews = [];
    original.metadata!.editContext = { mediaReferences, imageAttachmentCount: 0 };
    expect((await prepareMessageEdit(original, { ...request, prompt: 'Use @图片1 instead' })).mediaReferences).toEqual(mediaReferences);
    // A reference whose @ token was deleted no longer describes the request.
    expect((await prepareMessageEdit(original, { ...request, prompt: 'Use @图片10 instead' })).mediaReferences).toBeUndefined();
  });

  test('rebuilds the reference of an image edit sent before edit context was recorded', async () => {
    const localPath = await writeTemp('source.png', 'source!');
    const original = message([preview(localPath)]);
    original.content = '@图片1 Reframe this image to 16:9.';
    original.metadata!.imageEdits = [legacyImageEdit];
    const staged: ImageEditRequest = { id: legacyImageEdit.requestId, operation: ImageEditOperation.Reframe, regions: [],
      source: { ...legacyImageEdit.source, filePath: localPath }, aspectRatio: '16:9', createdAt: 1 };
    const deps = { resolveImageEdit: (_sessionId: string, requestId: string) => requestId === staged.id ? staged : undefined };
    const prepared = await prepareMessageEdit(original, { ...request, prompt: `${original.content} Keep the subject.` }, deps);
    expect(prepared.mediaReferences).toEqual([expect.objectContaining({
      token: '@图片1', index: 1, mediaType: 'image', localPath, mimeType: 'image/png', imageEdit: staged,
    })]);
    expect(prepared.imageAttachments).toHaveLength(1);
    // The staged request is the only source of truth; without it the edit stays refused.
    await expect(prepareMessageEdit(original, request, { resolveImageEdit: () => undefined }))
      .rejects.toThrow(t('coworkEditLegacyImageContext'));
  });

  test('resends a pasted image that is stored whole, and a larger one from its retained original', async () => {
    const bytes = Buffer.from('pasted image');
    const whole: CoworkImageAttachmentPreview = { name: 'pasted.png', mimeType: 'image/png', base64Data: bytes.toString('base64'),
      originalMimeType: 'image/png', originalSizeBytes: bytes.length, isPreview: true };
    expect((await prepareMessageEdit(message([whole]), request)).imageAttachments).toEqual([
      { name: 'pasted.png', mimeType: 'image/png', base64Data: bytes.toString('base64') },
    ]);
    const retainedOriginalPath = await writeTemp('retained.png', 'retained original');
    const prepared = await prepareMessageEdit(message([{ ...preview(), retainedOriginalPath }]), request);
    expect(prepared.imageAttachments).toEqual([expect.objectContaining({
      base64Data: Buffer.from('retained original').toString('base64'), retainedOriginalPath,
    })]);
  });

  test('labels restored bytes by their real format and refits originals above the model limit', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(COWORK_IMAGE_ATTACHMENT_MODEL_MAX_BYTES)]);
    const localPath = await writeTemp('large.png', png);
    const stored = message([{ ...preview(localPath), originalMimeType: 'image/jpeg' }]);
    const fitted = Buffer.from('fitted');
    const prepared = await prepareMessageEdit(stored, request, {
      fitImage: (bytes, maxBytes) => {
        expect(bytes.length).toBeGreaterThan(maxBytes);
        return { bytes: fitted, mimeType: 'image/jpeg' };
      },
    });
    expect(prepared.imageAttachments).toEqual([expect.objectContaining({ mimeType: 'image/jpeg', base64Data: fitted.toString('base64') })]);
    await expect(prepareMessageEdit(stored, request)).rejects.toThrow(t('coworkEditImageTooLarge'));

    const smallPath = await writeTemp('small.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]));
    const small = await prepareMessageEdit(message([{ ...preview(smallPath), originalMimeType: 'image/jpeg' }]), request);
    expect(small.imageAttachments?.[0].mimeType).toBe('image/png');
  });

  test('keeps the thumbnail of a large original so the resent message still shows it', async () => {
    const localPath = await writeTemp('photo.png', Buffer.alloc(COWORK_IMAGE_ATTACHMENT_PREVIEW_FALLBACK_MAX_BYTES + 1));
    const prepared = await prepareMessageEdit(message([preview(localPath)]), request);
    expect(prepared.imageAttachments?.[0]).toMatchObject({ previewMimeType: 'image/webp', previewBase64Data: 'thumbnail' });
    expect(buildCoworkImageAttachmentPreviews(prepared.imageAttachments)).toHaveLength(1);
  });

  test('gives a path-less reference its payload back from the restored attachment', async () => {
    const bytes = Buffer.from('pasted image');
    const original = message([{ name: 'pasted.png', mimeType: 'image/png', base64Data: bytes.toString('base64'),
      originalMimeType: 'image/png', originalSizeBytes: bytes.length, isPreview: true }]);
    const reference = { token: '@图片1', mediaType: 'image', index: 1, fileId: 'inline:pasted.png', fileName: 'pasted.png', mimeType: 'image/png' };
    original.metadata!.editContext = { imageAttachmentCount: 1, mediaReferences: [{ ...reference, attachmentIndex: 0 }] };
    const prepared = await prepareMessageEdit(original, { ...request, prompt: 'Describe @图片1' });
    expect(prepared.mediaReferences).toEqual([{ ...reference, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` }]);
    original.metadata!.editContext = { imageAttachmentCount: 1, mediaReferences: [reference] };
    await expect(prepareMessageEdit(original, { ...request, prompt: 'Describe @图片1' })).rejects.toThrow(t('coworkEditMissingAttachment'));
  });

  test('validates without loading attachment bytes', async () => {
    const localPath = await writeTemp('original.png', 'original!');
    const checked = await prepareMessageEdit(message([preview(localPath)]), request, { validateOnly: true });
    expect(checked.imageAttachments?.[0].base64Data).toBe('thumbnail');
    await expect(prepareMessageEdit(message([preview('/missing/original.png')]), request, { validateOnly: true }))
      .rejects.toThrow(t('coworkEditMissingAttachment'));
  });
});
