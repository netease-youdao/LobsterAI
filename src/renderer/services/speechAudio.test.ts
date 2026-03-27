import { describe, expect, test, vi } from 'vitest';
import { prepareSpeechUpload } from './speechAudio';

describe('prepareSpeechUpload', () => {
  test('converts glm recordings to wav before upload', async () => {
    const blobToBase64 = vi.fn().mockResolvedValue('wav-base64');
    const convertBlobToWav = vi.fn().mockResolvedValue(new Blob(['wav-data'], { type: 'audio/wav' }));

    const result = await prepareSpeechUpload({
      provider: 'glm',
      blob: new Blob(['webm-data'], { type: 'audio/webm' }),
      mimeType: 'audio/webm',
      fileName: 'speech-input.webm',
    }, {
      blobToBase64,
      convertBlobToWav,
    });

    expect(convertBlobToWav).toHaveBeenCalledTimes(1);
    expect(blobToBase64).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      audioBase64: 'wav-base64',
      mimeType: 'audio/wav',
      fileName: 'speech-input.wav',
    });
  });

  test('keeps qwen recordings in the original format', async () => {
    const blobToBase64 = vi.fn().mockResolvedValue('webm-base64');
    const convertBlobToWav = vi.fn();

    const result = await prepareSpeechUpload({
      provider: 'qwen',
      blob: new Blob(['webm-data'], { type: 'audio/webm' }),
      mimeType: 'audio/webm',
      fileName: 'speech-input.webm',
    }, {
      blobToBase64,
      convertBlobToWav,
    });

    expect(convertBlobToWav).not.toHaveBeenCalled();
    expect(result).toEqual({
      audioBase64: 'webm-base64',
      mimeType: 'audio/webm',
      fileName: 'speech-input.webm',
    });
  });
});
