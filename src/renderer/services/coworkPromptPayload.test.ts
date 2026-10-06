import { describe, expect, test, vi } from 'vitest';

import { prepareCoworkPromptPayload } from './coworkPromptPayload';

describe('prepareCoworkPromptPayload', () => {
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
