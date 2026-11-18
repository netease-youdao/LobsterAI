import { describe, expect, test, vi } from 'vitest';

import { COWORK_IMAGE_ATTACHMENT_MODEL_MAX_BYTES } from '../../shared/cowork/imageAttachments';
import { ImageEditOperation, type ImageEditRequest } from '../../shared/imageEditing/types';
import { CoworkPromptPayloadFailureCode, prepareCoworkPromptPayload } from './coworkPromptPayload';

const base64OfBytes = (bytes: number): string => 'A'.repeat(Math.ceil(bytes / 3) * 4);

describe('prepareCoworkPromptPayload', () => {
  test('queued image edits retain their exact original and structured regions without a vision model', async () => {
    const edit: ImageEditRequest = { id: 'edit-1', operation: ImageEditOperation.Comment, createdAt: 1,
      source: { id: 'source', rootId: 'source', sessionId: 'session', filePath: '/snapshots/frozen.png', title: 'cup.png',
        width: 2048, height: 2048, operation: ImageEditOperation.Original, createdAt: 1 },
      regions: [{ id: 'region', x: 0.2, y: 0.3, width: 0.3, height: 0.4, text: 'Make the cup blue' }] };
    const result = await prepareCoworkPromptPayload({ basePrompt: 'Preserve the lighting', attachments: [
      { path: '/notes.txt', name: 'notes.txt' },
      { path: edit.source.filePath, name: 'cup.png', isImage: true, imageEdit: edit },
    ], modelSupportsImage: false, selectedTextSnippets: [], fileLabel: 'File', folderLabel: 'Folder' });
    expect(result.success).toBe(true); if (!result.success) return;
    expect(result.payload.finalPrompt).toContain('Preserve the lighting'); expect(result.payload.finalPrompt).toContain('File: /notes.txt');
    expect(result.payload.finalPrompt).toContain('Make the cup blue');
    expect(result.payload.mediaReferences).toHaveLength(1);
    expect(result.payload.mediaReferences?.[0]).toMatchObject({ localPath: '/snapshots/frozen.png', imageEdit: edit });
    expect(result.payload.imageAttachments).toBeUndefined();
  });
  test('preserves file and folder labels in the final prompt', async () => {
    const result = await prepareCoworkPromptPayload({
      basePrompt: 'continue',
      attachments: [
        { path: '/tmp/file.txt', name: 'file.txt' },
        { path: '/tmp/folder', name: 'folder', isDirectory: true },
      ],
      selectedTextSnippets: [],
      modelSupportsImage: false,
      fileLabel: 'File',
      folderLabel: 'Folder',
    });

    expect(result).toEqual({
      success: true,
      payload: {
        finalPrompt: 'continue\n\nFile: /tmp/file.txt\nFolder: /tmp/folder',
      },
    });
  });

  test('preserves Windows paths without path-specific rewriting', async () => {
    const result = await prepareCoworkPromptPayload({
      basePrompt: 'continue',
      attachments: [
        { path: 'C:\\Users\\tester\\notes.txt', name: 'notes.txt' },
        { path: 'D:\\workspace\\assets', name: 'assets', isDirectory: true },
      ],
      selectedTextSnippets: [],
      modelSupportsImage: false,
      fileLabel: 'File',
      folderLabel: 'Folder',
    });

    expect(result).toEqual({
      success: true,
      payload: {
        finalPrompt: 'continue\n\nFile: C:\\Users\\tester\\notes.txt\nFolder: D:\\workspace\\assets',
      },
    });
  });

  test('rehydrates a local image only when the queued model supports images', async () => {
    const readFileAsDataUrl = vi.fn(async () => ({
      success: true,
      dataUrl: 'data:image/png;base64,YWJj',
    }));
    const result = await prepareCoworkPromptPayload({
      basePrompt: 'inspect',
      attachments: [{ path: '/tmp/image.png', name: 'image.png', isImage: true }],
      selectedTextSnippets: [],
      modelSupportsImage: true,
      readFileAsDataUrl,
      fileLabel: 'File',
      folderLabel: 'Folder',
    });

    expect(readFileAsDataUrl).toHaveBeenCalledWith('/tmp/image.png');
    expect(result).toMatchObject({
      success: true,
      payload: {
        finalPrompt: 'inspect',
        imageAttachments: [{
          name: 'image.png',
          mimeType: 'image/png',
          base64Data: 'YWJj',
          localPath: '/tmp/image.png',
        }],
      },
    });
  });

  test('re-encodes an image edit source above the model limit and keeps the original path', async () => {
    const edit: ImageEditRequest = { id: 'edit-2', operation: ImageEditOperation.Comment, createdAt: 1,
      source: { id: 'source', rootId: 'source', sessionId: 'session', filePath: '/snapshots/large.png', title: 'race.png',
        width: 2496, height: 1664, operation: ImageEditOperation.Original, createdAt: 1 },
      regions: [{ id: 'region', x: 0.2, y: 0.3, width: 0.1, height: 0.1, text: 'Change it to yeah2' }] };
    const original = `data:image/png;base64,${base64OfBytes(COWORK_IMAGE_ATTACHMENT_MODEL_MAX_BYTES + 1024)}`;
    const fitImageDataUrl = vi.fn(async () => 'data:image/jpeg;base64,Zml0dGVk');
    const createImagePreviewDataUrl = vi.fn();
    const result = await prepareCoworkPromptPayload({
      basePrompt: '',
      attachments: [{ path: edit.source.filePath, name: 'race.png', isImage: true, imageEdit: edit }],
      selectedTextSnippets: [],
      modelSupportsImage: true,
      readFileAsDataUrl: async () => ({ success: true, dataUrl: original }),
      createImagePreviewDataUrl,
      fitImageDataUrl,
      fileLabel: 'File',
      folderLabel: 'Folder',
    });

    expect(fitImageDataUrl).toHaveBeenCalledWith(original, COWORK_IMAGE_ATTACHMENT_MODEL_MAX_BYTES);
    expect(createImagePreviewDataUrl).not.toHaveBeenCalled();
    expect(result.success).toBe(true); if (!result.success) return;
    expect(result.payload.imageAttachments).toEqual([{
      name: 'race.png',
      mimeType: 'image/jpeg',
      base64Data: 'Zml0dGVk',
      sizeBytes: 6,
      localPath: '/snapshots/large.png',
    }]);
    expect(result.payload.mediaReferences?.[0]).toMatchObject({ localPath: '/snapshots/large.png', imageEdit: edit });
  });

  test('leaves images within the model limit untouched', async () => {
    const fitImageDataUrl = vi.fn();
    const result = await prepareCoworkPromptPayload({
      basePrompt: 'inspect',
      attachments: [{ path: '/tmp/image.png', name: 'image.png', isImage: true }],
      selectedTextSnippets: [],
      modelSupportsImage: true,
      readFileAsDataUrl: async () => ({ success: true, dataUrl: 'data:image/png;base64,YWJj' }),
      fitImageDataUrl,
      fileLabel: 'File',
      folderLabel: 'Folder',
    });

    expect(fitImageDataUrl).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, payload: { imageAttachments: [{ mimeType: 'image/png', base64Data: 'YWJj' }] } });
  });

  test.each([
    ['still exceeds the limit', async () => `data:image/jpeg;base64,${base64OfBytes(COWORK_IMAGE_ATTACHMENT_MODEL_MAX_BYTES + 3)}`],
    ['cannot be decoded', async () => { throw new Error('decode failed'); }],
  ])('reports the model limit when the re-encoded image %s', async (_label, fitImageDataUrl) => {
    const originalBytes = COWORK_IMAGE_ATTACHMENT_MODEL_MAX_BYTES + 1024;
    const result = await prepareCoworkPromptPayload({
      basePrompt: 'inspect',
      attachments: [{ path: '/tmp/large.png', name: 'large.png', isImage: true }],
      selectedTextSnippets: [],
      modelSupportsImage: true,
      readFileAsDataUrl: async () => ({ success: true, dataUrl: `data:image/png;base64,${base64OfBytes(originalBytes)}` }),
      fitImageDataUrl,
      fileLabel: 'File',
      folderLabel: 'Folder',
    });

    expect(result).toEqual({
      success: false,
      failure: {
        code: CoworkPromptPayloadFailureCode.ImageTooLarge,
        attachmentName: 'large.png',
        sizeBytes: Math.ceil(originalBytes / 3) * 3,
        maxBytes: COWORK_IMAGE_ATTACHMENT_MODEL_MAX_BYTES,
      },
    });
  });

  test('keeps a local image as a file path for a non-vision model', async () => {
    const readFileAsDataUrl = vi.fn();
    const result = await prepareCoworkPromptPayload({
      basePrompt: 'inspect',
      attachments: [{ path: '/tmp/image.png', name: 'image.png', isImage: true }],
      selectedTextSnippets: [],
      modelSupportsImage: false,
      readFileAsDataUrl,
      fileLabel: 'File',
      folderLabel: 'Folder',
    });

    expect(readFileAsDataUrl).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      payload: {
        finalPrompt: 'inspect\n\nFile: /tmp/image.png',
      },
    });
  });

  test('embeds pasted-text cards after the prompt and before file lines', async () => {
    const result = await prepareCoworkPromptPayload({
      basePrompt: 'why does this fail?',
      attachments: [
        { path: '/tmp/app.log', name: 'app.log' },
        { path: 'pasted:p1', name: 'Error: boom', pastedText: 'Error: boom\nat main()' },
      ],
      selectedTextSnippets: [],
      modelSupportsImage: false,
      fileLabel: 'File',
      folderLabel: 'Folder',
    });

    expect(result).toEqual({
      success: true,
      payload: {
        finalPrompt: 'why does this fail?\n\n'
          + '<pasted_text id="p1">\nError: boom\nat main()\n</pasted_text id="p1">\n\n'
          + 'File: /tmp/app.log',
      },
    });
  });

  test('sends a pasted-text card on its own without a typed prompt', async () => {
    const result = await prepareCoworkPromptPayload({
      basePrompt: '',
      attachments: [{ path: 'pasted:p2', name: 'notes', pastedText: 'notes' }],
      selectedTextSnippets: [],
      modelSupportsImage: false,
      fileLabel: 'File',
      folderLabel: 'Folder',
    });

    expect(result.success && result.payload.finalPrompt).toBe('<pasted_text id="p2">\nnotes\n</pasted_text id="p2">');
  });
});
