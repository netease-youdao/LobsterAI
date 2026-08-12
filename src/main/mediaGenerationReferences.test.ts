import { describe, expect, test } from 'vitest';

import {
  applyMediaReferencesToGenerationParams,
  MediaAttachmentKind,
  type MediaAttachmentRefMain,
  MediaAttachmentRole,
  MediaGenerationRequestType,
  summarizeMediaGenerationParamsForLog,
} from './mediaGenerationReferences';

const makeImageRef = (overrides: Partial<MediaAttachmentRefMain>): MediaAttachmentRefMain => ({
  token: overrides.token ?? '@图片2',
  mediaType: MediaAttachmentKind.Image,
  index: overrides.index ?? 2,
  fileId: overrides.fileId ?? '/tmp/second.png',
  fileName: overrides.fileName ?? 'second.png',
  mimeType: overrides.mimeType ?? 'image/png',
  localPath: overrides.localPath,
  remoteUrl: overrides.remoteUrl,
  dataUrl: overrides.dataUrl,
  role: overrides.role,
});

const makeVideoRef = (overrides: Partial<MediaAttachmentRefMain>): MediaAttachmentRefMain => ({
  token: overrides.token ?? '@视频1',
  mediaType: MediaAttachmentKind.Video,
  index: overrides.index ?? 1,
  fileId: overrides.fileId ?? '/tmp/action.mp4',
  fileName: overrides.fileName ?? 'action.mp4',
  mimeType: overrides.mimeType ?? 'video/mp4',
  localPath: overrides.localPath,
  remoteUrl: overrides.remoteUrl,
  dataUrl: overrides.dataUrl,
  role: overrides.role,
});

const makeAudioRef = (overrides: Partial<MediaAttachmentRefMain>): MediaAttachmentRefMain => ({
  token: overrides.token ?? '@音频1',
  mediaType: MediaAttachmentKind.Audio,
  index: overrides.index ?? 1,
  fileId: overrides.fileId ?? '/tmp/voice.mp3',
  fileName: overrides.fileName ?? 'voice.mp3',
  mimeType: overrides.mimeType ?? 'audio/mpeg',
  localPath: overrides.localPath,
  remoteUrl: overrides.remoteUrl,
  dataUrl: overrides.dataUrl,
  role: overrides.role,
});

describe('applyMediaReferencesToGenerationParams', () => {
  test('replaces a single image token with the referenced file path', () => {
    const params = applyMediaReferencesToGenerationParams({
      mediaType: MediaGenerationRequestType.Image,
      params: {
        image: '@图片2',
      },
      refs: [
        makeImageRef({
          token: '@图片2',
          localPath: '/tmp/second.png',
        }),
      ],
    });

    expect(params.image).toBeUndefined();
    expect(params.images).toEqual(['/tmp/second.png']);
    expect(params.imageRoles).toEqual([MediaAttachmentRole.ReferenceImage]);
  });

  test('replaces image tokens inside image arrays and dedupes references', () => {
    const params = applyMediaReferencesToGenerationParams({
      mediaType: MediaGenerationRequestType.Image,
      params: {
        images: ['@图片1', '/tmp/existing.png'],
      },
      refs: [
        makeImageRef({
          token: '@图片1',
          index: 1,
          localPath: '/tmp/existing.png',
        }),
      ],
    });

    expect(params.images).toEqual(['/tmp/existing.png']);
    expect(params.images).not.toContain('@图片1');
  });

  test('puts explicit image mention first for video generation and treats it as first frame', () => {
    const params = applyMediaReferencesToGenerationParams({
      mediaType: MediaGenerationRequestType.Video,
      params: {
        images: ['/tmp/first.png'],
        imageRoles: [MediaAttachmentRole.ReferenceImage],
        firstFrame: '/tmp/first.png',
      },
      refs: [
        makeImageRef({
          localPath: '/tmp/second.png',
          role: MediaAttachmentRole.ReferenceImage,
        }),
      ],
    });

    expect(params.images).toEqual(['/tmp/second.png']);
    expect(params.imageRoles).toEqual([MediaAttachmentRole.FirstFrame]);
    expect(params.firstFrame).toBeUndefined();
  });

  test('keeps only explicit image mentions as image generation references', () => {
    const params = applyMediaReferencesToGenerationParams({
      mediaType: MediaGenerationRequestType.Image,
      params: {
        images: ['/tmp/first.png'],
        referenceImages: ['/tmp/first.png'],
        media: [{ type: 'reference_image', url: '/tmp/first.png' }],
        providerOptions: {
          media: [{ type: 'reference_image', url: '/tmp/first.png' }],
          prompt_optimizer: true,
        },
      },
      refs: [
        makeImageRef({
          localPath: '/tmp/second.png',
          role: MediaAttachmentRole.ReferenceImage,
        }),
      ],
    });

    expect(params.images).toEqual(['/tmp/second.png']);
    expect(params.imageRoles).toEqual([MediaAttachmentRole.ReferenceImage]);
    expect(params.referenceImages).toBeUndefined();
    expect(params.media).toBeUndefined();
    expect(params.providerOptions).toEqual({ prompt_optimizer: true });
  });

  test('normalizes firstFrame and referenceImages tokens to real image values for video generation', () => {
    const params = applyMediaReferencesToGenerationParams({
      mediaType: MediaGenerationRequestType.Video,
      params: {
        firstFrame: '@图片1',
        referenceImages: ['@图片2'],
      },
      refs: [
        makeImageRef({
          token: '@图片1',
          index: 1,
          localPath: '/tmp/first.png',
          role: MediaAttachmentRole.FirstFrame,
        }),
        makeImageRef({
          token: '@图片2',
          index: 2,
          localPath: '/tmp/second.png',
          role: MediaAttachmentRole.ReferenceImage,
        }),
      ],
    });

    expect(params.firstFrame).toBeUndefined();
    expect(params.referenceImages).toBeUndefined();
    expect(params.images).toEqual(['/tmp/first.png', '/tmp/second.png']);
    expect(params.imageRoles).toEqual([
      MediaAttachmentRole.FirstFrame,
      MediaAttachmentRole.ReferenceImage,
    ]);
  });

  test('replaces media tokens inside providerOptions media urls', () => {
    const params = applyMediaReferencesToGenerationParams({
      mediaType: MediaGenerationRequestType.Video,
      params: {
        providerOptions: {
          media: [{ type: 'reference_video', url: '@视频1' }],
        },
      },
      refs: [
        makeVideoRef({
          token: '@视频1',
          localPath: '/tmp/action.mp4',
        }),
      ],
    });

    expect(params.videos).toEqual(['/tmp/action.mp4']);
    expect(params.providerOptions).toEqual({
      media: [{ type: 'reference_video', url: '/tmp/action.mp4' }],
    });
  });

  test('uses data URL fallback when a referenced image has no local path', () => {
    const dataUrl = 'data:image/png;base64,abc123';
    const params = applyMediaReferencesToGenerationParams({
      mediaType: MediaGenerationRequestType.Image,
      params: {
        images: ['@图片1'],
      },
      refs: [
        makeImageRef({
          token: '@图片1',
          index: 1,
          localPath: undefined,
          dataUrl,
        }),
      ],
    });

    expect(params.images).toEqual([dataUrl]);
  });

  test('maps referenced audio for multimodal video generation', () => {
    const params = applyMediaReferencesToGenerationParams({
      mediaType: MediaGenerationRequestType.Video,
      params: {},
      refs: [makeAudioRef({ localPath: '/tmp/voice.mp3' })],
    });

    expect(params.audios).toEqual(['/tmp/voice.mp3']);
    expect(params.audioRoles).toEqual([MediaAttachmentRole.ReferenceAudio]);
  });
});

describe('summarizeMediaGenerationParamsForLog', () => {
  test('redacts data URL payloads in logged params', () => {
    const summary = summarizeMediaGenerationParamsForLog({
      images: ['data:image/png;base64,abc123'],
    });

    expect(summary).toEqual({
      images: ['[data-url:image/png,length=28]'],
    });
  });
});
