import type { AssistantTurnItem } from '@/components/cowork/messageDisplayUtils';
import { isBashLikeToolName, normalizeToolName } from '@/components/cowork/messageDisplayUtils';
import { getArtifactIdentityKeys } from '@/services/artifactParser';
import { type Artifact, ArtifactMediaOriginType } from '@/types/artifact';

export const VideoLoadState = {
  Idle: 'idle',
  Loading: 'loading',
  Ready: 'ready',
  Failed: 'failed',
} as const;
export type VideoLoadState = typeof VideoLoadState[keyof typeof VideoLoadState];

export const VideoCardVariant = {
  Hero: 'hero',
  Grid: 'grid',
} as const;
export type VideoCardVariant = typeof VideoCardVariant[keyof typeof VideoCardVariant];

export const INLINE_VIDEO_MAX_WIDTH = 640;
export const INLINE_VIDEO_MIN_WIDTH = 240;
export const INLINE_VIDEO_MAX_HEIGHT = 420;
export const INLINE_VIDEO_DEFAULT_ASPECT_RATIO = 16 / 9;
export const INLINE_VIDEO_MIN_ASPECT_RATIO = 0.4;
export const INLINE_VIDEO_MAX_ASPECT_RATIO = 2.4;
export const MAX_COLLAPSED_VIDEO_TILES = 4;

export interface VideoMediaMetadata {
  width: number;
  height: number;
  duration: number | null;
}

export interface VideoPartition {
  primaryVideos: Artifact[];
  secondaryVideos: Artifact[];
}

export interface TurnMediaPartition {
  primaryVideos: Artifact[];
  primaryImages: Artifact[];
  secondaryVideos: Artifact[];
  secondaryImages: Artifact[];
}

const MAX_CACHED_VIDEO_METADATA = 200;
const videoMetadataCache = new Map<string, VideoMediaMetadata>();

const VIDEO_GENERATION_TOOL_NAMES = new Set([
  'lobsteraivideogenerate',
  'videogenerate',
]);

const WRITE_LIKE_TOOL_NAMES = new Set([
  'write',
  'writefile',
  'edit',
  'editfile',
  'multiedit',
  'createfile',
]);

const VIDEO_IMAGE_INPUT_KEY_RE = /(?:image|frame|media)/i;
const MEDIA_TOKEN_REF_RE = /(?:^|\s|["'@])(?:@图片\d+|@image\s*\d+|media:)/i;

export function getCachedVideoMetadata(key: string): VideoMediaMetadata | null {
  return videoMetadataCache.get(key) ?? null;
}

export function rememberVideoMetadata(key: string, metadata: VideoMediaMetadata): void {
  if (!key || metadata.width <= 0 || metadata.height <= 0) return;
  if (videoMetadataCache.has(key)) {
    videoMetadataCache.delete(key);
  }
  videoMetadataCache.set(key, metadata);
  if (videoMetadataCache.size > MAX_CACHED_VIDEO_METADATA) {
    const oldestKey = videoMetadataCache.keys().next().value;
    if (oldestKey !== undefined) {
      videoMetadataCache.delete(oldestKey);
    }
  }
}

export function clearVideoMetadataCache(): void {
  videoMetadataCache.clear();
}

export function clampVideoAspectRatio(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return INLINE_VIDEO_DEFAULT_ASPECT_RATIO;
  return Math.min(INLINE_VIDEO_MAX_ASPECT_RATIO, Math.max(INLINE_VIDEO_MIN_ASPECT_RATIO, ratio));
}

/** Computes the hero card width and viewport aspect ratio from natural video dimensions. */
export function computeSingleVideoBox(
  width: number | null | undefined,
  height: number | null | undefined,
): { width: number; aspectRatio: number } {
  const hasDimensions = typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0;
  const aspectRatio = hasDimensions
    ? clampVideoAspectRatio(width / height)
    : INLINE_VIDEO_DEFAULT_ASPECT_RATIO;
  const naturalFitWidth = Math.round(Math.min(INLINE_VIDEO_MAX_WIDTH, INLINE_VIDEO_MAX_HEIGHT * aspectRatio));
  return {
    width: Math.max(INLINE_VIDEO_MIN_WIDTH, naturalFitWidth),
    aspectRatio,
  };
}

export function formatVideoDuration(seconds: number | null | undefined): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  const totalSeconds = Math.max(1, Math.round(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

export function formatVideoResolution(
  width: number | null | undefined,
  height: number | null | undefined,
): string | null {
  if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) {
    return null;
  }
  const shortSide = Math.min(width, height);
  if (shortSide >= 2160) return '4K';
  if (shortSide >= 1440) return '2K';
  if (shortSide >= 1080) return '1080p';
  if (shortSide >= 720) return '720p';
  if (shortSide >= 480) return '480p';
  return `${Math.round(width)}×${Math.round(height)}`;
}

export function formatVideoMetaLabel(metadata: VideoMediaMetadata | null | undefined): string | null {
  if (!metadata) return null;
  const parts = [
    formatVideoDuration(metadata.duration),
    formatVideoResolution(metadata.width, metadata.height),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function getVideoDisplayName(artifact: Artifact, fallbackLabel: string): string {
  const fileName = artifact.fileName?.trim();
  if (fileName) return fileName;
  const filePath = artifact.filePath?.trim();
  if (filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    const lastSlash = normalized.lastIndexOf('/');
    const baseName = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
    if (baseName) return baseName;
  }
  const title = artifact.title?.trim();
  return title || fallbackLabel;
}

export function getVideoFileExtension(artifact: Artifact): string {
  const name = getVideoDisplayName(artifact, '');
  const withoutQuery = name.split(/[?#]/, 1)[0] ?? name;
  const dotIndex = withoutQuery.lastIndexOf('.');
  if (dotIndex < 0 || dotIndex === withoutQuery.length - 1) return '';
  return withoutQuery.slice(dotIndex + 1).toUpperCase();
}

export function getPosterSeekTime(duration: number | null | undefined): number {
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
    return 0;
  }
  if (duration > 0.25) return 0.1;
  return Math.max(0, duration * 0.1);
}

function isGeneratedVideoArtifact(artifact: Artifact): boolean {
  return artifact.mediaOrigin?.type === ArtifactMediaOriginType.GeneratedVideo
    || Boolean(artifact.legacyGeneratedVideoCandidate);
}

function normalizePathText(value: string): string {
  return value.trim().replace(/\\/g, '/').toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectInputStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 6 || value == null) return;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) out.push(trimmed);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectInputStrings(item, out, depth + 1);
    }
    return;
  }
  if (typeof value === 'object') {
    for (const entryValue of Object.values(value as Record<string, unknown>)) {
      collectInputStrings(entryValue, out, depth + 1);
    }
  }
}

function hasVideoImageConditioningInput(toolInput: Record<string, unknown> | undefined): {
  hasAnyImageInput: boolean;
  hasUnresolvedTokenInput: boolean;
} {
  if (!toolInput) return { hasAnyImageInput: false, hasUnresolvedTokenInput: false };
  const candidateStrings: string[] = [];
  for (const [key, value] of Object.entries(toolInput)) {
    if (!VIDEO_IMAGE_INPUT_KEY_RE.test(key)) continue;
    collectInputStrings(value, candidateStrings);
  }
  const hasAnyImageInput = candidateStrings.length > 0;
  const hasUnresolvedTokenInput = candidateStrings.some(str => MEDIA_TOKEN_REF_RE.test(str));
  return { hasAnyImageInput, hasUnresolvedTokenInput };
}

interface ArtifactMatchSpec {
  exactTokens: string[];
  fileNamePattern: RegExp | null;
}

function buildArtifactMatchSpec(artifact: Artifact): ArtifactMatchSpec {
  const exactTokens: string[] = [];
  const normalizedPath = artifact.filePath ? normalizePathText(artifact.filePath) : '';
  if (normalizedPath) exactTokens.push(normalizedPath);
  const remoteUrl = artifact.remoteUrl?.trim().toLowerCase();
  if (remoteUrl) exactTokens.push(remoteUrl);

  const fileName = getVideoDisplayName(artifact, '').trim().toLowerCase();
  const hasUsableFileName = fileName.length >= 5 && fileName.includes('.');
  const fileNamePattern = hasUsableFileName
    ? new RegExp(`(?:^|[^a-z0-9_-])${escapeRegExp(fileName)}(?:$|[^a-z0-9_-])`)
    : null;
  return { exactTokens, fileNamePattern };
}

function textReferencesArtifact(normalizedText: string, spec: ArtifactMatchSpec): boolean {
  if (!normalizedText) return false;
  for (const token of spec.exactTokens) {
    if (normalizedText.includes(token)) return true;
  }
  if (spec.fileNamePattern && spec.fileNamePattern.test(normalizedText)) {
    return true;
  }
  return false;
}

interface TurnToolStep {
  stepIndex: number;
  normalizedToolName: string;
  isVideoGenerate: boolean;
  isTransformTool: boolean;
  toolInput: Record<string, unknown> | undefined;
  normalizedInputText: string;
}

function isVideoGenerationToolName(normalizedToolName: string): boolean {
  return VIDEO_GENERATION_TOOL_NAMES.has(normalizedToolName)
    || normalizedToolName.endsWith('lobsteraivideogenerate');
}

function extractTurnToolSteps(turnItems: readonly AssistantTurnItem[]): TurnToolStep[] {
  const steps: TurnToolStep[] = [];
  for (let index = 0; index < turnItems.length; index += 1) {
    const item = turnItems[index];
    if (item.type !== 'tool_group') continue;
    const rawToolName = typeof item.group.toolUse.metadata?.toolName === 'string'
      ? item.group.toolUse.metadata.toolName
      : '';
    const normalizedToolName = normalizeToolName(rawToolName);
    const isVideoGenerate = isVideoGenerationToolName(normalizedToolName);
    const isTransformTool = isVideoGenerate
      || isBashLikeToolName(rawToolName)
      || WRITE_LIKE_TOOL_NAMES.has(normalizedToolName);
    if (!isTransformTool) continue;

    const toolInput = item.group.toolUse.metadata?.toolInput as Record<string, unknown> | undefined;
    const strings: string[] = [];
    collectInputStrings(toolInput, strings);
    steps.push({
      stepIndex: index,
      normalizedToolName,
      isVideoGenerate,
      isTransformTool,
      toolInput,
      normalizedInputText: normalizePathText(strings.join('\n')),
    });
  }
  return steps;
}

function buildEarliestArtifactStepMap(
  rawArtifacts: readonly Artifact[],
  turnItems: readonly AssistantTurnItem[],
): Map<string, number> {
  const stepByMessageId = new Map<string, number>();
  for (let index = 0; index < turnItems.length; index += 1) {
    const item = turnItems[index];
    if (item.type === 'tool_group') {
      stepByMessageId.set(item.group.toolUse.id, index);
      if (item.group.toolResult) {
        stepByMessageId.set(item.group.toolResult.id, index);
      }
    } else {
      stepByMessageId.set(item.message.id, index);
    }
  }

  const earliestByKey = new Map<string, number>();
  for (const artifact of rawArtifacts) {
    const step = stepByMessageId.get(artifact.messageId);
    if (step === undefined) continue;
    for (const key of getArtifactIdentityKeys(artifact)) {
      const existing = earliestByKey.get(key);
      if (existing === undefined || step < existing) {
        earliestByKey.set(key, step);
      }
    }
  }
  return earliestByKey;
}

function resolveEffectiveCreatedStep(
  artifact: Artifact,
  matchSpec: ArtifactMatchSpec,
  earliestByKey: ReadonlyMap<string, number>,
  toolSteps: readonly TurnToolStep[],
  fallbackStep: number,
): number {
  let step = fallbackStep;
  for (const key of getArtifactIdentityKeys(artifact)) {
    const known = earliestByKey.get(key);
    if (known !== undefined && known < step) {
      step = known;
    }
  }
  // Files synthesized inside a shell command (e.g. ffmpeg output) are only detected from the reply;
  // anchor them to the first shell/write tool step whose input mentions the output file.
  for (const toolStep of toolSteps) {
    if (toolStep.stepIndex >= step) break;
    if (textReferencesArtifact(toolStep.normalizedInputText, matchSpec)) {
      return toolStep.stepIndex;
    }
  }
  return step;
}

function getTrailingReplyReferencedKeys(
  rawArtifacts: readonly Artifact[],
  trailingReplyMessageIds: readonly string[],
): Set<string> {
  const keys = new Set<string>();
  if (trailingReplyMessageIds.length === 0) return keys;
  const replyIdSet = new Set(trailingReplyMessageIds);
  for (const artifact of rawArtifacts) {
    if (!replyIdSet.has(artifact.messageId)) continue;
    for (const key of getArtifactIdentityKeys(artifact)) {
      keys.add(key);
    }
  }
  return keys;
}

function isArtifactReferencedByKeys(artifact: Artifact, keySet: ReadonlySet<string>): boolean {
  return getArtifactIdentityKeys(artifact).some(key => keySet.has(key));
}

/**
 * Splits a turn's videos into primary deliverables and intermediate clips using
 * reply references (standalone helper kept for callers without full turn items).
 */
export function partitionVideoArtifactsForDisplay(
  videoArtifacts: readonly Artifact[],
  rawArtifacts: readonly Artifact[],
  trailingReplyMessageIds: readonly string[],
): VideoPartition {
  const { primaryVideos, secondaryVideos } = partitionTurnMediaForDisplay({
    videoArtifacts,
    imageArtifacts: [],
    rawArtifacts,
    turnItems: [],
    trailingReplyMessageIds,
  });
  return { primaryVideos, secondaryVideos };
}

/**
 * Classifies a turn's video and image artifacts into final deliverables vs.
 * intermediate process assets (source clips, first/last frames, reference images)
 * so the user immediately sees the final deliverable without clicking through
 * intermediate files.
 *
 * Rules (applied only when the turn produces at least one video):
 * 1. Videos consumed as inputs by a tool step at or before a newer video is produced
 *    are demoted to intermediate clips (even if mentioned in the final summary text).
 * 2. When both model-generated raw clips and locally post-processed/stitched videos
 *    survive, the post-processed deliverable(s) lead and raw clips fold into process assets.
 * 3. When multiple equal candidates remain and the trailing reply links a strict subset,
 *    the linked subset leads.
 * 4. Images fed into video generation / pre-video shell steps, returned alongside a video
 *    in the same tool result (e.g. last frame), or generated right before an
 *    image-conditioned video call fold into process assets rather than competing with the video.
 */
export function partitionTurnMediaForDisplay(params: {
  videoArtifacts: readonly Artifact[];
  imageArtifacts: readonly Artifact[];
  rawArtifacts: readonly Artifact[];
  turnItems: readonly AssistantTurnItem[];
  trailingReplyMessageIds: readonly string[];
}): TurnMediaPartition {
  const { videoArtifacts, imageArtifacts, rawArtifacts, turnItems, trailingReplyMessageIds } = params;

  if (videoArtifacts.length === 0) {
    return {
      primaryVideos: [],
      primaryImages: [...imageArtifacts],
      secondaryVideos: [],
      secondaryImages: [],
    };
  }

  const toolSteps = extractTurnToolSteps(turnItems);
  const earliestByKey = buildEarliestArtifactStepMap(rawArtifacts, turnItems);
  const trailingReplyKeys = getTrailingReplyReferencedKeys(rawArtifacts, trailingReplyMessageIds);
  const fallbackStep = turnItems.length;

  const videoSpecs = new Map<string, ArtifactMatchSpec>();
  const videoCreatedStep = new Map<string, number>();
  for (const video of videoArtifacts) {
    const spec = buildArtifactMatchSpec(video);
    videoSpecs.set(video.id, spec);
    videoCreatedStep.set(
      video.id,
      resolveEffectiveCreatedStep(video, spec, earliestByKey, toolSteps, fallbackStep),
    );
  }

  // ── Partition videos ────────────────────────────────────────────────────────
  let primaryVideos = [...videoArtifacts];
  const secondaryVideoIds = new Set<string>();

  if (primaryVideos.length > 1) {
    // Layer 1: Direct tool-step lineage consumption.
    if (toolSteps.length > 0) {
      const consumedIds = new Set<string>();
      for (const toolStep of toolSteps) {
        const referencedEarlierVideos = primaryVideos.filter(video => {
          const created = videoCreatedStep.get(video.id) ?? fallbackStep;
          if (created >= toolStep.stepIndex) return false;
          const spec = videoSpecs.get(video.id);
          return spec ? textReferencesArtifact(toolStep.normalizedInputText, spec) : false;
        });
        if (referencedEarlierVideos.length === 0) continue;

        const hasDownstreamVideo = primaryVideos.some(other => {
          const otherCreated = videoCreatedStep.get(other.id) ?? fallbackStep;
          return otherCreated >= toolStep.stepIndex
            && !referencedEarlierVideos.some(ref => ref.id === other.id);
        });
        if (hasDownstreamVideo) {
          for (const consumed of referencedEarlierVideos) {
            consumedIds.add(consumed.id);
          }
        }
      }
      const unconsumed = primaryVideos.filter(video => !consumedIds.has(video.id));
      if (unconsumed.length > 0 && unconsumed.length < primaryVideos.length) {
        for (const id of consumedIds) secondaryVideoIds.add(id);
        primaryVideos = unconsumed;
      }
    }

    // Layer 2: Locally post-processed deliverable(s) beat raw generated clips from the same turn.
    if (primaryVideos.length > 1) {
      const postProcessed = primaryVideos.filter(video => !isGeneratedVideoArtifact(video));
      const rawGenerated = primaryVideos.filter(video => isGeneratedVideoArtifact(video));
      if (postProcessed.length > 0 && rawGenerated.length > 0) {
        for (const raw of rawGenerated) secondaryVideoIds.add(raw.id);
        primaryVideos = postProcessed;
      }
    }

    // Layer 3: Strict subset explicitly referenced by the trailing assistant reply.
    if (primaryVideos.length > 1 && trailingReplyKeys.size > 0) {
      const referenced = primaryVideos.filter(video => isArtifactReferencedByKeys(video, trailingReplyKeys));
      if (referenced.length > 0 && referenced.length < primaryVideos.length) {
        for (const video of primaryVideos) {
          if (!referenced.some(item => item.id === video.id)) {
            secondaryVideoIds.add(video.id);
          }
        }
        primaryVideos = referenced;
      }
    }
  }

  const secondaryVideos = videoArtifacts.filter(video => secondaryVideoIds.has(video.id));

  // ── Partition images in a video-producing turn ──────────────────────────────
  if (imageArtifacts.length === 0) {
    return {
      primaryVideos,
      primaryImages: [],
      secondaryVideos,
      secondaryImages: [],
    };
  }

  const rawVideoMessageIds = new Set(
    rawArtifacts
      .filter(artifact => artifact.type === 'video')
      .map(artifact => artifact.messageId),
  );
  const toolOrSystemMessageIds = new Set<string>();
  for (const item of turnItems) {
    if (item.type === 'tool_group') {
      toolOrSystemMessageIds.add(item.group.toolUse.id);
      if (item.group.toolResult) toolOrSystemMessageIds.add(item.group.toolResult.id);
    } else if (item.type === 'tool_result' || item.type === 'system') {
      toolOrSystemMessageIds.add(item.message.id);
    }
  }
  const videoGenerateSteps = toolSteps.filter(step => step.isVideoGenerate);
  const maxVideoCreatedStep = Math.max(
    ...videoArtifacts.map(video => videoCreatedStep.get(video.id) ?? fallbackStep),
  );

  const primaryImages: Artifact[] = [];
  const secondaryImages: Artifact[] = [];

  for (const image of imageArtifacts) {
    const imageSpec = buildArtifactMatchSpec(image);
    const imageCreatedStep = resolveEffectiveCreatedStep(
      image,
      imageSpec,
      earliestByKey,
      toolSteps,
      fallbackStep,
    );
    const imageKeys = getArtifactIdentityKeys(image);
    const matchesRawImage = (raw: Artifact) => (
      raw.type === 'image' && getArtifactIdentityKeys(raw).some(key => imageKeys.includes(key))
    );
    const producedByToolOrSystem = image.source === 'tool'
      || rawArtifacts.some(raw => matchesRawImage(raw) && toolOrSystemMessageIds.has(raw.messageId));
    const sharesToolResultWithVideo = rawArtifacts.some(raw => (
      matchesRawImage(raw)
      && rawVideoMessageIds.has(raw.messageId)
      && (raw.source === 'tool' || toolOrSystemMessageIds.has(raw.messageId))
    ));

    // Rule 1: Image path/filename/URL passed directly to video generation or a pre-video shell/write step.
    const consumedByVideoOrPreVideoStep = toolSteps.some(step => {
      if (!textReferencesArtifact(step.normalizedInputText, imageSpec)) return false;
      if (step.isVideoGenerate) return true;
      return step.stepIndex <= maxVideoCreatedStep && imageCreatedStep <= step.stepIndex;
    });

    // Rule 2: Image generated before an image-conditioned video call (handles @图片1 token or indirect ref).
    const preVideoKeyframe = producedByToolOrSystem && videoGenerateSteps.some(step => {
      if (imageCreatedStep >= step.stepIndex) return false;
      const { hasAnyImageInput, hasUnresolvedTokenInput } = hasVideoImageConditioningInput(step.toolInput);
      if (!hasAnyImageInput) return false;
      return hasUnresolvedTokenInput || !isArtifactReferencedByKeys(image, trailingReplyKeys);
    });

    // Rule 3: Tool-generated inspection/extracted frame referenced alongside a turn video in a shell step.
    const extractedInspectionFrame = producedByToolOrSystem
      && !isArtifactReferencedByKeys(image, trailingReplyKeys)
      && toolSteps.some(step => (
        !step.isVideoGenerate
        && textReferencesArtifact(step.normalizedInputText, imageSpec)
        && videoArtifacts.some(video => {
          const spec = videoSpecs.get(video.id);
          return spec ? textReferencesArtifact(step.normalizedInputText, spec) : false;
        })
      ));

    if (
      sharesToolResultWithVideo
      || consumedByVideoOrPreVideoStep
      || preVideoKeyframe
      || extractedInspectionFrame
    ) {
      secondaryImages.push(image);
    } else {
      primaryImages.push(image);
    }
  }

  return {
    primaryVideos,
    primaryImages,
    secondaryVideos,
    secondaryImages,
  };
}
