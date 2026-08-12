import { describe, expect, test, vi } from 'vitest';

import {
  assertMinimaxH3MediaSize,
  uploadMinimaxH3MediaParams,
  validateMinimaxH3MediaParams,
} from './mediaGenerationUpload';

describe('MiniMax-H3 NOS media upload', () => {
  test('rejects oversized files before upload', () => {
    expect(() => assertMinimaxH3MediaSize('audio', 15 * 1024 * 1024 + 1))
      .toThrow('音频单文件不能超过 15 MB');
  });

  test('rejects frame and reference modes mixed together', async () => {
    await expect(validateMinimaxH3MediaParams({
      firstFrame: 'https://nos.example.com/frame.png',
      videos: ['https://nos.example.com/reference.mp4'],
    })).rejects.toThrow('首尾帧模式与多模态参考模式不能混用');
  });

  test('uploads data URLs and replaces them with public links', async () => {
    const fetchWithAuth = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.body).toBeInstanceOf(FormData);
      return new Response(JSON.stringify({
        code: 0,
        data: { url: 'https://nos.example.com/input.png' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const result = await uploadMinimaxH3MediaParams({
      firstFrame: `data:image/png;base64,${png.toString('base64')}`,
    }, {
      serverBaseUrl: 'https://server.example.com',
      fetchWithAuth,
    });

    expect(result.firstFrame).toBe('https://nos.example.com/input.png');
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  test('keeps existing public URLs without uploading', async () => {
    const fetchWithAuth = vi.fn();
    const result = await uploadMinimaxH3MediaParams({
      referenceImages: ['https://cdn.example.com/reference.webp'],
    }, {
      serverBaseUrl: 'https://server.example.com',
      fetchWithAuth,
    });

    expect(result.referenceImages).toEqual(['https://cdn.example.com/reference.webp']);
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
});
