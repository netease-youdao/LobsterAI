import { beforeEach, describe, expect, test } from 'vitest';

import {
  buildConversationTurns,
  buildDisplayItems,
  getTurnTrailingReplyMessageIds,
} from '@/components/cowork/messageDisplayUtils';
import { dedupeArtifactsForDisplay, orderArtifactsByReplyReferences } from '@/services/artifactParser';
import { type Artifact, ArtifactMediaOriginType, ArtifactTypeValue } from '@/types/artifact';
import type { CoworkMessage } from '@/types/cowork';

import {
  clearVideoMetadataCache,
  computeSingleVideoBox,
  formatVideoDuration,
  formatVideoMetaLabel,
  formatVideoResolution,
  getCachedVideoMetadata,
  getPosterSeekTime,
  getVideoDisplayName,
  getVideoFileExtension,
  INLINE_VIDEO_DEFAULT_ASPECT_RATIO,
  INLINE_VIDEO_MAX_WIDTH,
  INLINE_VIDEO_MIN_WIDTH,
  partitionTurnMediaForDisplay,
  partitionVideoArtifactsForDisplay,
  rememberVideoMetadata,
} from './inlineVideoLayout';

const makeVideo = (
  id: string,
  messageId: string,
  fileName: string,
  overrides: Partial<Artifact> = {},
): Artifact => ({
  id,
  messageId,
  sessionId: 'sess-1',
  type: ArtifactTypeValue.Video,
  title: fileName,
  fileName,
  filePath: `/Users/dev/videos/${fileName}`,
  content: '',
  createdAt: 1000,
  ...overrides,
});

const makeGeneratedVideo = (
  id: string,
  messageId: string,
  fileName: string,
  taskId: string,
): Artifact => makeVideo(id, messageId, fileName, {
  source: 'tool',
  mediaOrigin: {
    type: ArtifactMediaOriginType.GeneratedVideo,
    taskId,
    outputIndex: 0,
  },
});

const makeImage = (
  id: string,
  messageId: string,
  fileName: string,
  overrides: Partial<Artifact> = {},
): Artifact => ({
  id,
  messageId,
  sessionId: 'sess-1',
  type: ArtifactTypeValue.Image,
  title: fileName,
  fileName,
  filePath: `/Users/dev/videos/${fileName}`,
  content: '',
  source: 'tool',
  createdAt: 1000,
  ...overrides,
});

describe('inlineVideoLayout', () => {
  beforeEach(() => {
    clearVideoMetadataCache();
  });

  test('computes single video box dimensions across landscape, square, portrait, and unknown sizes', () => {
    expect(computeSingleVideoBox(null, null)).toEqual({
      width: INLINE_VIDEO_MAX_WIDTH,
      aspectRatio: INLINE_VIDEO_DEFAULT_ASPECT_RATIO,
    });

    const landscape = computeSingleVideoBox(1280, 720);
    expect(landscape.width).toBe(INLINE_VIDEO_MAX_WIDTH);
    expect(landscape.aspectRatio).toBeCloseTo(16 / 9, 4);

    const square = computeSingleVideoBox(720, 720);
    expect(square.width).toBe(420);
    expect(square.aspectRatio).toBe(1);

    const portrait = computeSingleVideoBox(720, 1280);
    expect(portrait.width).toBe(INLINE_VIDEO_MIN_WIDTH);
    expect(portrait.aspectRatio).toBeCloseTo(9 / 16, 4);
  });

  test('formats duration and resolution badges cleanly', () => {
    expect(formatVideoDuration(null)).toBeNull();
    expect(formatVideoDuration(0)).toBeNull();
    expect(formatVideoDuration(0.3)).toBe('0:01');
    expect(formatVideoDuration(15)).toBe('0:15');
    expect(formatVideoDuration(65)).toBe('1:05');
    expect(formatVideoDuration(3661)).toBe('1:01:01');

    expect(formatVideoResolution(1280, 720)).toBe('720p');
    expect(formatVideoResolution(720, 1280)).toBe('720p');
    expect(formatVideoResolution(1920, 1080)).toBe('1080p');
    expect(formatVideoResolution(3840, 2160)).toBe('4K');
    expect(formatVideoResolution(320, 240)).toBe('320×240');
    expect(formatVideoResolution(0, 720)).toBeNull();

    expect(formatVideoMetaLabel({ width: 1280, height: 720, duration: 30 })).toBe('0:30 · 720p');
    expect(formatVideoMetaLabel({ width: 1280, height: 720, duration: null })).toBe('720p');
  });

  test('extracts display name, extension, and safe poster seek time', () => {
    expect(getVideoDisplayName(makeVideo('v1', 'm1', 'arrow-chase.mp4'), 'Video')).toBe('arrow-chase.mp4');
    expect(getVideoDisplayName({
      ...makeVideo('v2', 'm1', ''),
      fileName: undefined,
      filePath: 'C:\\clips\\final-cut.mov',
      title: 'untitled',
    }, 'Video')).toBe('final-cut.mov');
    expect(getVideoFileExtension(makeVideo('v1', 'm1', 'arrow-chase.mp4'))).toBe('MP4');

    expect(getPosterSeekTime(30)).toBe(0.1);
    expect(getPosterSeekTime(0.2)).toBeCloseTo(0.02, 4);
    expect(getPosterSeekTime(null)).toBe(0);
  });

  test('caches video metadata by source key', () => {
    rememberVideoMetadata('key-1', { width: 1280, height: 720, duration: 15 });
    expect(getCachedVideoMetadata('key-1')).toEqual({ width: 1280, height: 720, duration: 15 });
    expect(getCachedVideoMetadata('missing')).toBeNull();
  });

  test('promotes reply-referenced final deliverable and folds intermediate clips', () => {
    const clip1 = makeVideo('clip-1', 'tool-res-1', 'generated-video-1.mp4');
    const clip2 = makeVideo('clip-2', 'tool-res-2', 'generated-video-2.mp4');
    const finalTool = makeVideo('final-tool', 'tool-res-3', 'arrow-chase-30s-final.mp4');
    const finalReply = makeVideo('final-reply-ref', 'final-reply', 'arrow-chase-30s-final.mp4');
    const rawArtifacts = [clip1, clip2, finalTool, finalReply];
    const ordered = orderArtifactsByReplyReferences(
      dedupeArtifactsForDisplay(rawArtifacts),
      rawArtifacts,
      ['final-reply'],
    );

    const partitioned = partitionVideoArtifactsForDisplay(ordered, rawArtifacts, ['final-reply']);
    expect(partitioned.primaryVideos.map(v => v.fileName)).toEqual(['arrow-chase-30s-final.mp4']);
    expect(partitioned.secondaryVideos.map(v => v.fileName)).toEqual([
      'generated-video-1.mp4',
      'generated-video-2.mp4',
    ]);
  });

  test('keeps stitched final video primary even when final reply lists all 3 filenames and a later ffmpeg checks frames', () => {
    const messages: CoworkMessage[] = [
      { id: 'u1', type: 'user', content: 'make a 30s arrow chase video', timestamp: 1_000 },
      {
        id: 't1', type: 'tool_use', content: '', timestamp: 2_000,
        metadata: { toolName: 'lobsterai_video_generate', toolInput: { prompt: 'part 1' }, toolUseId: 't1' },
      },
      { id: 't1-r', type: 'tool_result', content: 'ok', timestamp: 3_000, metadata: { toolUseId: 't1' } },
      {
        id: 't2', type: 'tool_use', content: '', timestamp: 4_000,
        metadata: { toolName: 'lobsterai_video_generate', toolInput: { prompt: 'part 2' }, toolUseId: 't2' },
      },
      { id: 't2-r', type: 'tool_result', content: 'ok', timestamp: 5_000, metadata: { toolUseId: 't2' } },
      {
        id: 't3', type: 'tool_use', content: '', timestamp: 6_000,
        metadata: {
          toolName: 'exec',
          toolInput: {
            command: 'ffmpeg -i /Users/dev/videos/generated-video-1.mp4 -i /Users/dev/videos/generated-video-2.mp4 /Users/dev/videos/arrow-chase-30s-final.mp4',
          },
          toolUseId: 't3',
        },
      },
      { id: 't3-r', type: 'tool_result', content: 'done', timestamp: 7_000, metadata: { toolUseId: 't3' } },
      {
        id: 't4', type: 'tool_use', content: '', timestamp: 8_000,
        metadata: {
          toolName: 'exec',
          toolInput: { command: 'ffmpeg -i /Users/dev/videos/arrow-chase-30s-final.mp4 -vf fps=1 check_%02d.jpg' },
          toolUseId: 't4',
        },
      },
      { id: 't4-r', type: 'tool_result', content: 'inspected', timestamp: 9_000, metadata: { toolUseId: 't4' } },
      { id: 'final-reply', type: 'assistant', content: 'Stitched final cut plus raw clips.', timestamp: 10_000 },
    ];
    const turn = buildConversationTurns(buildDisplayItems(messages))[0];

    const clip1 = makeGeneratedVideo('clip-1', 't1-r', 'generated-video-1.mp4', '101');
    const clip2 = makeGeneratedVideo('clip-2', 't2-r', 'generated-video-2.mp4', '102');
    // Final reply mentions all three videos (final first, plus both raw clips).
    const finalRef = makeVideo('final-ref', 'final-reply', 'arrow-chase-30s-final.mp4');
    const clip1Ref = makeVideo('clip-1-ref', 'final-reply', 'generated-video-1.mp4');
    const clip2Ref = makeVideo('clip-2-ref', 'final-reply', 'generated-video-2.mp4');
    const rawArtifacts = [clip1, clip2, finalRef, clip1Ref, clip2Ref];
    const orderedVideos = orderArtifactsByReplyReferences(
      dedupeArtifactsForDisplay(rawArtifacts),
      rawArtifacts,
      ['final-reply'],
    );

    const partitioned = partitionTurnMediaForDisplay({
      videoArtifacts: orderedVideos,
      imageArtifacts: [],
      rawArtifacts,
      turnItems: turn.assistantItems,
      trailingReplyMessageIds: getTurnTrailingReplyMessageIds(turn),
    });

    expect(partitioned.primaryVideos.map(v => v.fileName)).toEqual(['arrow-chase-30s-final.mp4']);
    expect(partitioned.secondaryVideos.map(v => v.fileName)).toEqual([
      'generated-video-1.mp4',
      'generated-video-2.mp4',
    ]);
  });

  test('folds raw generated clips behind a post-processed local video even when tool command hides paths', () => {
    const clip1 = makeGeneratedVideo('clip-1', 't1-r', 'generated-video-1.mp4', '101');
    const clip2 = makeGeneratedVideo('clip-2', 't2-r', 'generated-video-2.mp4', '102');
    const finalVideo = makeVideo('final-1', 'final-reply', 'arrow-chase-30s-final.mp4');
    const rawArtifacts = [clip1, clip2, finalVideo];

    const partitioned = partitionTurnMediaForDisplay({
      videoArtifacts: [finalVideo, clip1, clip2],
      imageArtifacts: [],
      rawArtifacts,
      turnItems: [],
      trailingReplyMessageIds: ['final-reply'],
    });

    expect(partitioned.primaryVideos.map(v => v.fileName)).toEqual(['arrow-chase-30s-final.mp4']);
    expect(partitioned.secondaryVideos.map(v => v.fileName)).toEqual([
      'generated-video-1.mp4',
      'generated-video-2.mp4',
    ]);
  });

  test('folds first-frame reference image into process assets when fed into video generation', () => {
    const messages: CoworkMessage[] = [
      { id: 'u1', type: 'user', content: 'boy cycling one-take fantasy shot', timestamp: 1_000 },
      {
        id: 'img-call', type: 'tool_use', content: '', timestamp: 2_000,
        metadata: { toolName: 'lobsterai_image_generate', toolInput: { prompt: 'first frame' }, toolUseId: 'img-call' },
      },
      { id: 'img-res', type: 'tool_result', content: 'saved', timestamp: 3_000, metadata: { toolUseId: 'img-call' } },
      {
        id: 'vid-call', type: 'tool_use', content: '', timestamp: 4_000,
        metadata: {
          toolName: 'lobsterai_video_generate',
          toolInput: {
            prompt: 'camera follows cycling boy',
            firstFrame: '/Users/dev/videos/generated-image-1.png',
          },
          toolUseId: 'vid-call',
        },
      },
      { id: 'vid-res', type: 'tool_result', content: 'saved', timestamp: 5_000, metadata: { toolUseId: 'vid-call' } },
      { id: 'final-reply', type: 'assistant', content: 'Here is the generated video.', timestamp: 6_000 },
    ];
    const turn = buildConversationTurns(buildDisplayItems(messages))[0];

    const keyframe = makeImage('img-1', 'img-res', 'generated-image-1.png');
    const video = makeGeneratedVideo('vid-1', 'vid-res', 'generated-video-1.mp4', '201');
    const rawArtifacts = [keyframe, video];

    const partitioned = partitionTurnMediaForDisplay({
      videoArtifacts: [video],
      imageArtifacts: [keyframe],
      rawArtifacts,
      turnItems: turn.assistantItems,
      trailingReplyMessageIds: getTurnTrailingReplyMessageIds(turn),
    });

    expect(partitioned.primaryVideos.map(v => v.fileName)).toEqual(['generated-video-1.mp4']);
    expect(partitioned.primaryImages).toEqual([]);
    expect(partitioned.secondaryImages.map(img => img.fileName)).toEqual(['generated-image-1.png']);
  });

  test('folds pre-video keyframe when video tool references it via token and completes via system message', () => {
    const messages: CoworkMessage[] = [
      { id: 'u1', type: 'user', content: 'make video from generated frame', timestamp: 1_000 },
      {
        id: 'img-call', type: 'tool_use', content: '', timestamp: 2_000,
        metadata: { toolName: 'lobsterai_image_generate', toolInput: { prompt: 'frame' }, toolUseId: 'img-call' },
      },
      { id: 'img-res', type: 'tool_result', content: 'saved', timestamp: 3_000, metadata: { toolUseId: 'img-call' } },
      {
        id: 'vid-call', type: 'tool_use', content: '', timestamp: 4_000,
        metadata: {
          toolName: 'lobsterai_video_generate',
          toolInput: { prompt: 'animate', firstFrame: '@图片1' },
          toolUseId: 'vid-call',
        },
      },
      { id: 'vid-res', type: 'tool_result', content: 'background', timestamp: 5_000, metadata: { toolUseId: 'vid-call' } },
      { id: 'vid-sys', type: 'system', content: 'Saved generated video', timestamp: 6_000 },
    ];
    const turn = buildConversationTurns(buildDisplayItems(messages))[0];

    const keyframe = makeImage('img-1', 'img-res', 'first-frame.png');
    const video = makeGeneratedVideo('vid-1', 'vid-sys', 'generated-video-1.mp4', '202');

    const partitioned = partitionTurnMediaForDisplay({
      videoArtifacts: [video],
      imageArtifacts: [keyframe],
      rawArtifacts: [keyframe, video],
      turnItems: turn.assistantItems,
      trailingReplyMessageIds: getTurnTrailingReplyMessageIds(turn),
    });

    expect(partitioned.primaryVideos.map(v => v.fileName)).toEqual(['generated-video-1.mp4']);
    expect(partitioned.primaryImages).toEqual([]);
    expect(partitioned.secondaryImages.map(img => img.fileName)).toEqual(['first-frame.png']);
  });

  test('keeps independent image deliverable alongside text-to-video output', () => {
    const messages: CoworkMessage[] = [
      { id: 'u1', type: 'user', content: 'make a poster image and a promo video', timestamp: 1_000 },
      {
        id: 'img-call', type: 'tool_use', content: '', timestamp: 2_000,
        metadata: { toolName: 'lobsterai_image_generate', toolInput: { prompt: 'poster' }, toolUseId: 'img-call' },
      },
      { id: 'img-res', type: 'tool_result', content: 'saved', timestamp: 3_000, metadata: { toolUseId: 'img-call' } },
      {
        id: 'vid-call', type: 'tool_use', content: '', timestamp: 4_000,
        metadata: { toolName: 'lobsterai_video_generate', toolInput: { prompt: 'promo clip' }, toolUseId: 'vid-call' },
      },
      { id: 'vid-res', type: 'tool_result', content: 'saved', timestamp: 5_000, metadata: { toolUseId: 'vid-call' } },
      { id: 'final-reply', type: 'assistant', content: 'Both poster and video are ready.', timestamp: 6_000 },
    ];
    const turn = buildConversationTurns(buildDisplayItems(messages))[0];

    const poster = makeImage('img-1', 'img-res', 'poster.png');
    const promo = makeGeneratedVideo('vid-1', 'vid-res', 'promo.mp4', '301');

    const partitioned = partitionTurnMediaForDisplay({
      videoArtifacts: [promo],
      imageArtifacts: [poster],
      rawArtifacts: [poster, promo],
      turnItems: turn.assistantItems,
      trailingReplyMessageIds: getTurnTrailingReplyMessageIds(turn),
    });

    expect(partitioned.primaryVideos.map(v => v.fileName)).toEqual(['promo.mp4']);
    expect(partitioned.primaryImages.map(img => img.fileName)).toEqual(['poster.png']);
    expect(partitioned.secondaryImages).toEqual([]);
  });

  test('keeps all videos primary when no trailing reply references a subset or when all equal clips are referenced', () => {
    const clip1 = makeGeneratedVideo('clip-1', 'tool-res-1', 'v1.mp4', '401');
    const clip2 = makeGeneratedVideo('clip-2', 'tool-res-2', 'v2.mp4', '402');

    // No reply references any video: keep both as equal peers.
    const noRef = partitionVideoArtifactsForDisplay([clip1, clip2], [clip1, clip2], ['final-reply']);
    expect(noRef.primaryVideos.map(v => v.fileName)).toEqual(['v1.mp4', 'v2.mp4']);
    expect(noRef.secondaryVideos).toEqual([]);

    // Earlier intermediate reply referenced clip-1, trailing reply referenced neither: do not demote clip-2.
    const earlyRef = makeVideo('early-ref', 'mid-reply', 'v1.mp4');
    const trailingOnly = partitionVideoArtifactsForDisplay(
      [clip1, clip2],
      [clip1, earlyRef, clip2],
      ['final-reply'],
    );
    expect(trailingOnly.primaryVideos.map(v => v.fileName)).toEqual(['v1.mp4', 'v2.mp4']);
    expect(trailingOnly.secondaryVideos).toEqual([]);

    // Final reply references both equal generated videos: keep both as equal peers.
    const ref1 = makeVideo('ref-1', 'final-reply', 'v1.mp4');
    const ref2 = makeVideo('ref-2', 'final-reply', 'v2.mp4');
    const allRef = partitionVideoArtifactsForDisplay(
      [clip1, clip2],
      [clip1, clip2, ref1, ref2],
      ['final-reply'],
    );
    expect(allRef.primaryVideos.map(v => v.fileName)).toEqual(['v1.mp4', 'v2.mp4']);
    expect(allRef.secondaryVideos).toEqual([]);
  });

  test('extracts only assistant replies after the last tool step for trailing reply ids', () => {
    const messages: CoworkMessage[] = [
      { id: 'u1', type: 'user', content: 'stitch two clips', timestamp: 1_000 },
      { id: 't1', type: 'tool_use', content: '', timestamp: 2_000, metadata: { toolName: 'video', toolUseId: 't1' } },
      { id: 't1-r', type: 'tool_result', content: 'ok', timestamp: 3_000, metadata: { toolUseId: 't1' } },
      { id: 'mid-reply', type: 'assistant', content: 'First clip ready.', timestamp: 4_000 },
      { id: 't2', type: 'tool_use', content: '', timestamp: 5_000, metadata: { toolName: 'exec', toolUseId: 't2' } },
      { id: 't2-r', type: 'tool_result', content: 'ok', timestamp: 6_000, metadata: { toolUseId: 't2' } },
      { id: 'think-end', type: 'assistant', content: 'summarizing', timestamp: 7_000, metadata: { isThinking: true } },
      { id: 'final-reply', type: 'assistant', content: 'Final video ready.', timestamp: 8_000 },
    ];
    const turn = buildConversationTurns(buildDisplayItems(messages))[0];
    expect(getTurnTrailingReplyMessageIds(turn)).toEqual(['final-reply']);
  });
});
