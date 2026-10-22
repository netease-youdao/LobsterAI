import { describe, expect, test, vi } from 'vitest';

import { ImageEditOperation, type ImageEditRequest } from '../../shared/imageEditing/types';
import { prepareCoworkPromptPayload } from './coworkPromptPayload';

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
});
