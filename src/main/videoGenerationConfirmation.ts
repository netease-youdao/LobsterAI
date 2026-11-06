import { UsageOutcome, UsageStage } from '../shared/analytics/usage';
import {
  MediaConfirmationReason,
  type MediaConfirmationResponse,
  type VideoConfirmationDetails,
  VideoReferenceKind,
} from '../shared/media/confirmation';
import { MediaTaskStatus } from '../shared/media/constants';
import { estimateVideoCredits } from '../shared/media/videoCreditEstimate';
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
type Translate = (key: string, params?: Record<string, string | number>) => string;

const MAX_CONFIRMATION_REFERENCES = 9;
const MAX_CONFIRMATION_PROMPT = 4000;

/**
 * The reference media a video request carries, for the confirmation card.
 * `thumbnail` turns one resolved source (data or HTTP URL) into a small preview,
 * so full-size inputs never travel to the renderer twice.
 */
export function videoConfirmationReferences(
  params: Record<string, unknown>,
  thumbnail: (source: string) => string | undefined,
): VideoConfirmationDetails['references'] {
  const seen = new Set<string>();
  const references: VideoConfirmationDetails['references'] = [];
  const add = (kind: VideoReferenceKind, source: unknown) => {
    if (typeof source !== 'string' || !source || seen.has(source) || references.length >= MAX_CONFIRMATION_REFERENCES) return;
    seen.add(source);
    let preview: string | undefined;
    try { preview = kind === VideoReferenceKind.Image ? thumbnail(source) : undefined; } catch { preview = undefined; }
    references.push({ kind, ...(preview ? { thumbnail: preview } : {}) });
  };
  const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [value];
  for (const key of ['firstFrame', 'lastFrame', 'images', 'referenceImages']) list(params[key]).forEach(source => add(VideoReferenceKind.Image, source));
  list(params.videos).forEach(source => add(VideoReferenceKind.Video, source));
  for (const item of Array.isArray(params.media) ? params.media : []) {
    const entry = item && typeof item === 'object' ? item as Record<string, { url?: unknown } | unknown> : undefined;
    const image = entry?.image_url as { url?: unknown } | undefined;
    const video = entry?.video_url as { url?: unknown } | undefined;
    if (image?.url) add(VideoReferenceKind.Image, image.url);
    else if (video?.url) add(VideoReferenceKind.Video, video.url);
    else if (typeof item === 'string') add(item.startsWith('data:video/') ? VideoReferenceKind.Video : VideoReferenceKind.Image, item);
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
