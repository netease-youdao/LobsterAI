import path from 'path';

import { UsageOutcome, UsageStage } from '../shared/analytics/usage';
import { ArtifactPreviewHost, ArtifactPreviewProtocol } from '../shared/artifactPreview/constants';
import { isSniffableImageMimeType } from '../shared/cowork/imageAttachments';
import {
  MediaConfirmationReason,
  type MediaConfirmationResponse,
  type VideoConfirmationDetails,
  VideoReferenceKind,
} from '../shared/media/confirmation';
import { MediaTaskStatus } from '../shared/media/constants';
import { estimateVideoCredits } from '../shared/media/videoCreditEstimate';
import { getLocalFileMimeType, resolveServableLocalPath } from './artifactLocalFileProtocol';
import type { AskUserRequest } from './libs/mcpBridgeServer';

export type VideoConfirmationModel = {
  pricing?: Record<string, unknown>;
  pricingDescription?: string;
};
export interface VideoConfirmationInput {
  model: string;
  params: Record<string, unknown>;
  prompt: string;
  portalUrl: string;
  references?: VideoConfirmationDetails['references'];
}
export type VideoReferencePreview = string | {
  thumbnail?: string;
  previewUrl?: string;
  name?: string;
};
export interface DecodedPreviewImage {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(options: { width?: number; height?: number }): DecodedPreviewImage;
  toJPEG(quality: number): Buffer;
}
type Translate = (key: string, params?: Record<string, string | number>) => string;

const MAX_CONFIRMATION_REFERENCES = 9;
const MAX_CONFIRMATION_PROMPT = 4000;
const THUMBNAIL_HEIGHT_PX = 96;
const THUMBNAIL_JPEG_QUALITY = 80;
const INLINE_PREVIEW_MAX_EDGE_PX = 1280;
const INLINE_PREVIEW_JPEG_QUALITY = 85;
const INLINE_PREVIEW_DIRECT_BYTES = 256 * 1024;
const INLINE_UNDECODED_MAX_BYTES = 4 * 1024 * 1024;
const CONTENT_HASH_BASENAME_RE = /^[0-9a-f]{64}$/i;
const DATA_IMAGE_MIME_RE = /^data:(image\/[a-z0-9.+-]+);base64,/i;

export function buildLocalFileImagePreviewUrl(
  filePath: string,
  fallbackMimeType?: string,
): string | undefined {
  if (!path.isAbsolute(filePath)) return undefined;
  const servable = resolveServableLocalPath(filePath);
  if (!servable) return undefined;
  const extensionMime = getLocalFileMimeType(servable);
  const mime = extensionMime
    ?? (path.extname(servable) === '' && isSniffableImageMimeType(fallbackMimeType)
      ? fallbackMimeType.toLowerCase()
      : null);
  if (!mime || !mime.startsWith('image/')) return undefined;
  const normalized = servable.replace(/\\/g, '/');
  const pathForUrl = normalized.startsWith('/') ? normalized : `/${normalized}`;
  const encoded = pathForUrl.split('/').map(encodeURIComponent).join('/');
  return `${ArtifactPreviewProtocol.LocalFile}://${ArtifactPreviewHost.LocalFile}${encoded}`;
}

export function createVideoReferenceImagePreview(
  source: string,
  options: {
    localPath?: string;
    decodeDataUrl: (dataUrl: string) => DecodedPreviewImage;
  },
): VideoReferencePreview | undefined {
  if (/^https?:\/\//i.test(source)) return source;
  if (!source.startsWith('data:image/')) return undefined;
  const sourceMimeType = DATA_IMAGE_MIME_RE.exec(source)?.[1];
  const localUrl = options.localPath
    ? buildLocalFileImagePreviewUrl(options.localPath, sourceMimeType)
    : undefined;
  const rawName = options.localPath ? path.basename(options.localPath) : undefined;
  const name = rawName && !CONTENT_HASH_BASENAME_RE.test(rawName) ? rawName : undefined;
  const image = options.decodeDataUrl(source);
  if (image.isEmpty()) {
    if (localUrl) return { thumbnail: localUrl, previewUrl: localUrl, ...(name ? { name } : {}) };
    return source.length <= INLINE_UNDECODED_MAX_BYTES
      ? { thumbnail: source, previewUrl: source, ...(name ? { name } : {}) }
      : undefined;
  }
  const thumbnail = `data:image/jpeg;base64,${image.resize({ height: THUMBNAIL_HEIGHT_PX }).toJPEG(THUMBNAIL_JPEG_QUALITY).toString('base64')}`;
  let previewUrl = localUrl;
  if (!previewUrl) {
    if (source.length <= INLINE_PREVIEW_DIRECT_BYTES) {
      previewUrl = source;
    } else {
      const { width, height } = image.getSize();
      const resized = width > INLINE_PREVIEW_MAX_EDGE_PX || height > INLINE_PREVIEW_MAX_EDGE_PX
        ? (width >= height
          ? image.resize({ width: INLINE_PREVIEW_MAX_EDGE_PX })
          : image.resize({ height: INLINE_PREVIEW_MAX_EDGE_PX }))
        : image;
      previewUrl = `data:image/jpeg;base64,${resized.toJPEG(INLINE_PREVIEW_JPEG_QUALITY).toString('base64')}`;
    }
  }
  return {
    thumbnail,
    ...(previewUrl ? { previewUrl } : {}),
    ...(name ? { name } : {}),
  };
}

/**
 * The reference media a video request carries, for the confirmation card.
 * `thumbnail` turns one resolved source (data or HTTP URL) into a small card
 * preview and an optional higher-resolution preview URL, so full-size base64
 * inputs never travel to the renderer twice.
 */
export function videoConfirmationReferences(
  params: Record<string, unknown>,
  thumbnail: (source: string) => VideoReferencePreview | undefined,
): VideoConfirmationDetails['references'] {
  const seen = new Set<string>();
  const references: VideoConfirmationDetails['references'] = [];
  const add = (kind: VideoReferenceKind, source: unknown) => {
    if (typeof source !== 'string' || !source || seen.has(source) || references.length >= MAX_CONFIRMATION_REFERENCES) return;
    seen.add(source);
    let preview: VideoReferencePreview | undefined;
    try { preview = kind === VideoReferenceKind.Image ? thumbnail(source) : undefined; } catch { preview = undefined; }
    if (typeof preview === 'string') {
      references.push({ kind, ...(preview ? { thumbnail: preview } : {}) });
      return;
    }
    references.push({
      kind,
      ...(preview?.thumbnail ? { thumbnail: preview.thumbnail } : {}),
      ...(preview?.previewUrl ? { previewUrl: preview.previewUrl } : {}),
      ...(preview?.name ? { name: preview.name } : {}),
    });
  };
  const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [value];
  const nestedUrl = (value: unknown): unknown => (
    typeof value === 'string'
      ? value
      : value && typeof value === 'object' && !Array.isArray(value)
        ? (value as { url?: unknown }).url
        : undefined
  );
  for (const key of [
    'firstFrame', 'first_frame', 'firstFrameImage', 'first_frame_image',
    'lastFrame', 'last_frame', 'lastFrameImage', 'last_frame_image',
    'image', 'imageUrl', 'image_url', 'images', 'imageUrls',
    'referenceImage', 'referenceImages',
  ]) {
    list(params[key]).forEach(source => add(VideoReferenceKind.Image, nestedUrl(source)));
  }
  list(params.videos).forEach(source => add(VideoReferenceKind.Video, nestedUrl(source)));
  const providerOptions = params.providerOptions && typeof params.providerOptions === 'object' && !Array.isArray(params.providerOptions)
    ? params.providerOptions as Record<string, unknown>
    : undefined;
  const mediaItems = Array.isArray(params.media)
    ? params.media
    : Array.isArray(providerOptions?.media)
      ? providerOptions.media
      : [];
  for (const item of mediaItems) {
    if (typeof item === 'string') {
      if (item.startsWith('data:audio/')) continue;
      add(item.startsWith('data:video/') ? VideoReferenceKind.Video : VideoReferenceKind.Image, item);
      continue;
    }
    const entry = item && typeof item === 'object' && !Array.isArray(item)
      ? item as Record<string, unknown>
      : undefined;
    if (!entry) continue;
    const imageUrl = nestedUrl(entry.image_url);
    const videoUrl = nestedUrl(entry.video_url);
    if (imageUrl) {
      add(VideoReferenceKind.Image, imageUrl);
      continue;
    }
    if (videoUrl) {
      add(VideoReferenceKind.Video, videoUrl);
      continue;
    }
    const directUrl = nestedUrl(entry.url);
    if (typeof directUrl !== 'string' || !directUrl) continue;
    const descriptor = `${typeof entry.type === 'string' ? entry.type : ''} ${typeof entry.role === 'string' ? entry.role : ''}`.toLowerCase();
    if (descriptor.includes('audio') || directUrl.startsWith('data:audio/')) continue;
    add(
      descriptor.includes('video') || directUrl.startsWith('data:video/')
        ? VideoReferenceKind.Video
        : VideoReferenceKind.Image,
      directUrl,
    );
  }
  return references;
}

export function videoConfirmationQuestions(
  input: VideoConfirmationInput,
  model: VideoConfirmationModel,
  t: Translate,
): AskUserRequest['questions'] {
  const estimate = estimateVideoCredits(model.pricing, input.params);
  const duration = Number(input.params.durationSeconds);
  const video: VideoConfirmationDetails = {
    model: input.model,
    prompt: input.prompt.slice(0, MAX_CONFIRMATION_PROMPT),
    portalUrl: input.portalUrl,
    ...(typeof input.params.resolution === 'string' ? { resolution: input.params.resolution } : {}),
    ...(Number.isFinite(duration) && duration > 0 ? { durationSeconds: duration } : {}),
    ...(typeof input.params.aspectRatio === 'string' ? { aspectRatio: input.params.aspectRatio } : {}),
    ...(typeof input.params.audio === 'boolean' ? { audio: input.params.audio } : {}),
    ...(estimate !== undefined ? { estimatedCredits: estimate } : {}),
    ...(estimate === undefined && model.pricingDescription?.trim() ? { pricingNote: model.pricingDescription.trim() } : {}),
    references: input.references ?? [],
  };
  return [
    {
      question:
        t('mediaVideoConfirmDescription').replace('{url}', input.portalUrl) +
        '\n\n' +
        t('mediaVideoConfirmRequest', {
          model: input.model,
          resolution: String(input.params.resolution ?? '-'),
          duration: String(input.params.durationSeconds ?? '-'),
          prompt: input.prompt.slice(0, 500),
        }),
      title: t('mediaVideoConfirmTitle'),
      subtitle:
        estimate !== undefined
          ? t('mediaVideoConfirmCostEstimate', { credits: estimate })
          : [t('mediaVideoConfirmCostUnknown'), model.pricingDescription?.trim()]
              .filter(Boolean)
              .join('\n'),
      options: [
        { label: t('mediaVideoConfirmAccept'), description: t('mediaVideoConfirmStart') },
        { label: t('mediaVideoConfirmCancel'), description: t('mediaVideoConfirmLater') },
      ],
      video,
    },
  ];
}

export function videoConfirmationFailure(response: MediaConfirmationResponse | null, t: Translate) {
  const reason = response?.reason ?? MediaConfirmationReason.NoRoute;
  const timeout =
    reason === MediaConfirmationReason.Timeout || reason === MediaConfirmationReason.NotDisplayed;
  const interrupted = reason === MediaConfirmationReason.Interrupted || reason === MediaConfirmationReason.AccountChanged;
  const declined = reason === MediaConfirmationReason.UserCancelled || reason === MediaConfirmationReason.Skipped || reason === MediaConfirmationReason.InvalidAnswer;
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: t(
          timeout
            ? 'mediaVideoConfirmationTimedOut'
            : reason === MediaConfirmationReason.UserCancelled
              ? 'mediaVideoConfirmationCancelled'
              : 'mediaVideoConfirmationUnavailable',
        ),
      },
    ],
    details: {
      status: timeout ? MediaTaskStatus.Timeout : interrupted ? UsageOutcome.Interrupted : declined ? MediaTaskStatus.Cancelled : MediaTaskStatus.Failed,
      reason,
      failureCode: reason,
      failureStage: UsageStage.Confirmation,
    },
  };
}
