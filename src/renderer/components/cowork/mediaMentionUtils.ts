import type { DraftAttachment } from '../../store/slices/coworkSlice';
import type { MediaAttachmentRef } from '../../types/mediaGeneration';

export const MediaMentionType = {
  Image: 'image',
  Video: 'video',
  Audio: 'audio',
} as const;

export type MediaMentionType = typeof MediaMentionType[keyof typeof MediaMentionType];

export const MediaMentionLabelPrefix = {
  Image: '图片',
  Video: '视频',
  Audio: '音频',
} as const;

export type MediaMentionLabelPrefix =
  typeof MediaMentionLabelPrefix[keyof typeof MediaMentionLabelPrefix];

export const MediaMentionSegmentKind = {
  Text: 'text',
  Mention: 'mention',
} as const;

export type MediaMentionSegmentKind =
  typeof MediaMentionSegmentKind[keyof typeof MediaMentionSegmentKind];

export interface MediaLabel {
  attachment: DraftAttachment;
  label: string;
  mediaType: MediaMentionType;
  index: number;
}

export type MediaMentionSegment =
  | {
      kind: typeof MediaMentionSegmentKind.Text;
      text: string;
    }
  | {
      kind: typeof MediaMentionSegmentKind.Mention;
      text: string;
      label: string;
    };

export interface MediaMentionTrigger {
  atIndex: number;
  cursorPos: number;
  filter: string;
}

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff', 'tif', 'avif']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'avi', 'webm', 'mkv', 'flv', 'wmv', 'm4v']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma']);

const MEDIA_MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  avif: 'image/avif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  flv: 'video/x-flv',
  wmv: 'video/x-ms-wmv',
  m4v: 'video/x-m4v',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  wma: 'audio/x-ms-wma',
};

const MEDIA_ROLE_BY_TYPE: Record<MediaMentionType, NonNullable<MediaAttachmentRef['role']>> = {
  [MediaMentionType.Image]: 'reference_image',
  [MediaMentionType.Video]: 'reference_video',
  [MediaMentionType.Audio]: 'reference_audio',
};

const getFileExtension = (fileName: string): string => {
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex === -1) return '';
  return fileName.slice(dotIndex + 1).toLowerCase();
};

export function getMediaMentionType(attachment: DraftAttachment): MediaMentionType | null {
  if (attachment.isImage) return MediaMentionType.Image;

  const ext = getFileExtension(attachment.name);
  if (IMAGE_EXTENSIONS.has(ext)) return MediaMentionType.Image;
  if (VIDEO_EXTENSIONS.has(ext)) return MediaMentionType.Video;
  if (AUDIO_EXTENSIONS.has(ext)) return MediaMentionType.Audio;
  return null;
}

export function computeMediaLabels(attachments: DraftAttachment[]): MediaLabel[] {
  const counters: Record<MediaMentionType, number> = {
    [MediaMentionType.Image]: 0,
    [MediaMentionType.Video]: 0,
    [MediaMentionType.Audio]: 0,
  };
  const labelMap: Record<MediaMentionType, MediaMentionLabelPrefix> = {
    [MediaMentionType.Image]: MediaMentionLabelPrefix.Image,
    [MediaMentionType.Video]: MediaMentionLabelPrefix.Video,
    [MediaMentionType.Audio]: MediaMentionLabelPrefix.Audio,
  };
  const labels: MediaLabel[] = [];

  for (const attachment of attachments) {
    const mediaType = getMediaMentionType(attachment);
    if (!mediaType) continue;
    counters[mediaType] += 1;
    labels.push({
      attachment,
      label: `${labelMap[mediaType]}${counters[mediaType]}`,
      mediaType,
      index: counters[mediaType],
    });
  }

  return labels;
}

export function filterMediaLabels(items: MediaLabel[], filter: string): MediaLabel[] {
  const normalizedFilter = filter.trim().toLowerCase();
  if (!normalizedFilter) return items;

  return items.filter(item =>
    item.label.toLowerCase().includes(normalizedFilter) ||
    item.attachment.name.toLowerCase().includes(normalizedFilter)
  );
}

export function resolveMediaMentionTrigger(text: string, cursorPos: number): MediaMentionTrigger | null {
  const normalizedCursorPos = Math.min(Math.max(cursorPos, 0), text.length);
  const textBeforeCursor = text.slice(0, normalizedCursorPos);
  const atIndex = textBeforeCursor.lastIndexOf('@');
  if (atIndex === -1) return null;

  const filter = textBeforeCursor.slice(atIndex + 1);
  if (/\s/.test(filter)) return null;

  return {
    atIndex,
    cursorPos: normalizedCursorPos,
    filter,
  };
}

export function getMediaMentionMimeType(item: MediaLabel): string {
  const ext = getFileExtension(item.attachment.name);
  return MEDIA_MIME_BY_EXTENSION[ext] || `${item.mediaType}/*`;
}

export function extractMediaReferencesFromPrompt(
  prompt: string,
  mediaLabels: MediaLabel[],
): MediaAttachmentRef[] {
  if (!prompt || mediaLabels.length === 0) return [];

  const labelLookup = new Map(mediaLabels.map(item => [item.label, item]));
  const referencesByLabel = new Map<string, MediaAttachmentRef>();
  const mediaTokenPattern = /@(图片|视频|音频)(\d+)/g;
  let match: RegExpExecArray | null;

  while ((match = mediaTokenPattern.exec(prompt)) !== null) {
    const label = `${match[1]}${match[2]}`;
    if (referencesByLabel.has(label)) continue;

    const item = labelLookup.get(label);
    if (!item) continue;

    referencesByLabel.set(label, {
      token: match[0],
      mediaType: item.mediaType,
      index: item.index,
      fileId: item.attachment.path,
      fileName: item.attachment.name,
      mimeType: getMediaMentionMimeType(item),
      localPath: item.attachment.path.startsWith('inline:') ? undefined : item.attachment.path,
      dataUrl: item.attachment.dataUrl,
      role: MEDIA_ROLE_BY_TYPE[item.mediaType],
      ...(item.attachment.imageEdit ? { imageEdit: item.attachment.imageEdit } : {}),
    });
  }

  return [...referencesByLabel.values()];
}

export function buildMediaMentionSegments(
  text: string,
  mediaLabels: MediaLabel[],
): MediaMentionSegment[] {
  if (!text) return [{ kind: MediaMentionSegmentKind.Text, text: '' }];
  if (mediaLabels.length === 0) return [{ kind: MediaMentionSegmentKind.Text, text }];

  const labelLookup = new Set(mediaLabels.map(item => item.label));
  const segments: MediaMentionSegment[] = [];
  const mediaTokenPattern = /@(图片|视频|音频)(\d+)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = mediaTokenPattern.exec(text)) !== null) {
    const label = `${match[1]}${match[2]}`;
    if (!labelLookup.has(label)) continue;

    if (match.index > lastIndex) {
      segments.push({
        kind: MediaMentionSegmentKind.Text,
        text: text.slice(lastIndex, match.index),
      });
    }
    segments.push({
      kind: MediaMentionSegmentKind.Mention,
      text: match[0],
      label,
    });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({
      kind: MediaMentionSegmentKind.Text,
      text: text.slice(lastIndex),
    });
  }

  return segments.length > 0 ? segments : [{ kind: MediaMentionSegmentKind.Text, text }];
}
