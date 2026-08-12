export const MediaGenerationRequestType = {
  Image: 'image',
  Video: 'video',
} as const;
export type MediaGenerationRequestType =
  typeof MediaGenerationRequestType[keyof typeof MediaGenerationRequestType];

export const MediaAttachmentKind = {
  Image: 'image',
  Video: 'video',
  Audio: 'audio',
} as const;
export type MediaAttachmentKind = typeof MediaAttachmentKind[keyof typeof MediaAttachmentKind];

export const MediaAttachmentRole = {
  FirstFrame: 'first_frame',
  LastFrame: 'last_frame',
  ReferenceImage: 'reference_image',
  ReferenceVideo: 'reference_video',
  ReferenceAudio: 'reference_audio',
} as const;
export type MediaAttachmentRole = typeof MediaAttachmentRole[keyof typeof MediaAttachmentRole];

export interface MediaAttachmentRefMain {
  token: string;
  mediaType: MediaAttachmentKind;
  index: number;
  fileId: string;
  fileName: string;
  mimeType: string;
  localPath?: string;
  remoteUrl?: string;
  dataUrl?: string;
  role?: MediaAttachmentRole;
}

interface ApplyMediaReferencesInput {
  mediaType: MediaGenerationRequestType;
  params: Record<string, unknown>;
  refs?: MediaAttachmentRefMain[];
}

const DATA_URL_RE = /^data:([^;,]+)[;,]/;

const getStringArray = (value: unknown): string[] => (
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
);

const resolveReferencedMediaValue = (ref: MediaAttachmentRefMain): string | undefined => (
  ref.localPath || ref.dataUrl || ref.remoteUrl
);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const buildReferenceValueByToken = (refs?: MediaAttachmentRefMain[]): Map<string, string> => {
  const values = new Map<string, string>();
  for (const ref of refs ?? []) {
    const token = ref.token.trim();
    const value = resolveReferencedMediaValue(ref);
    if (token && value) {
      values.set(token, value);
    }
  }
  return values;
};

const replaceMediaReferenceTokens = (
  value: unknown,
  valueByToken: Map<string, string>,
): unknown => {
  if (typeof value === 'string') {
    return valueByToken.get(value.trim()) ?? value;
  }

  if (Array.isArray(value)) {
    return value.map(item => replaceMediaReferenceTokens(item, valueByToken));
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      replaceMediaReferenceTokens(item, valueByToken),
    ]),
  );
};

const dedupeValues = (values: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
};

const normalizeVideoImageRole = (
  role: string | undefined,
  isPrimary: boolean,
  hasNonImageReference: boolean,
): MediaAttachmentRole => {
  if (role === MediaAttachmentRole.FirstFrame || role === MediaAttachmentRole.LastFrame) {
    return role;
  }
  if (hasNonImageReference) {
    return MediaAttachmentRole.ReferenceImage;
  }
  return isPrimary ? MediaAttachmentRole.FirstFrame : MediaAttachmentRole.ReferenceImage;
};

const normalizeReferenceImageRole = (): MediaAttachmentRole => MediaAttachmentRole.ReferenceImage;

const removeProviderMedia = (value: unknown): unknown => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const next = { ...(value as Record<string, unknown>) };
  delete next.media;
  return next;
};

const removeConflictingImageInputs = (params: Record<string, unknown>): void => {
  delete params.image;
  delete params.firstFrame;
  delete params.lastFrame;
  delete params.referenceImages;
  delete params.media;
  if (params.providerOptions) {
    params.providerOptions = removeProviderMedia(params.providerOptions);
  }
};

export const applyMediaReferencesToGenerationParams = ({
  mediaType,
  params,
  refs,
}: ApplyMediaReferencesInput): Record<string, unknown> => {
  const valueByToken = buildReferenceValueByToken(refs);
  const next = replaceMediaReferenceTokens(params, valueByToken) as Record<string, unknown>;
  const resolvedRefs = (refs ?? [])
    .map(ref => ({ ref, value: valueByToken.get(ref.token.trim()) }))
    .filter((item): item is { ref: MediaAttachmentRefMain; value: string } => Boolean(item.value));

  const imageRefs = resolvedRefs.filter(item => item.ref.mediaType === MediaAttachmentKind.Image);
  const videoRefs = resolvedRefs.filter(item => item.ref.mediaType === MediaAttachmentKind.Video);
  const audioRefs = resolvedRefs.filter(item => item.ref.mediaType === MediaAttachmentKind.Audio);

  if (imageRefs.length > 0) {
    removeConflictingImageInputs(next);

    if (mediaType === MediaGenerationRequestType.Video) {
      const referencedImages = dedupeValues(imageRefs.map(item => item.value));
      const hasNonImageReference = videoRefs.length > 0 || audioRefs.length > 0;
      const referencedRoles = imageRefs.map((item, index) => (
        normalizeVideoImageRole(item.ref.role, index === 0, hasNonImageReference)
      ));

      next.images = referencedImages;
      next.imageRoles = referencedRoles.slice(0, referencedImages.length);
    } else {
      const referencedImages = dedupeValues(imageRefs.map(item => item.value));
      const referencedRoles = imageRefs.map(() => normalizeReferenceImageRole());
      next.images = referencedImages;
      next.imageRoles = referencedRoles.slice(0, referencedImages.length);
    }
  }

  if (videoRefs.length > 0) {
    const referencedVideos = videoRefs.map(item => item.value);
    const existingVideos = getStringArray(next.videos);
    const existingVideoRoles = getStringArray(next.videoRoles);
    next.videos = dedupeValues([...referencedVideos, ...existingVideos]);
    next.videoRoles = [
      ...videoRefs.map(item => item.ref.role || MediaAttachmentRole.ReferenceVideo),
      ...existingVideoRoles,
    ].slice(0, (next.videos as string[]).length);
  }

  if (audioRefs.length > 0) {
    const referencedAudios = audioRefs.map(item => item.value);
    const existingAudios = getStringArray(next.audios);
    const existingAudioRoles = getStringArray(next.audioRoles);
    next.audios = dedupeValues([...referencedAudios, ...existingAudios]);
    next.audioRoles = [
      ...audioRefs.map(item => item.ref.role || MediaAttachmentRole.ReferenceAudio),
      ...existingAudioRoles,
    ].slice(0, (next.audios as string[]).length);
  }

  return next;
};

export const summarizeMediaGenerationParamsForLog = (value: unknown): unknown => {
  if (typeof value === 'string') {
    const match = DATA_URL_RE.exec(value);
    if (match) {
      return `[data-url:${match[1]},length=${value.length}]`;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(item => summarizeMediaGenerationParamsForLog(item));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      summarizeMediaGenerationParamsForLog(item),
    ]),
  );
};
