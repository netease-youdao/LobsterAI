import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export type MinimaxH3MediaType = 'image' | 'video' | 'audio';

type FetchWithAuth = (url: string, options?: RequestInit) => Promise<Response>;

export interface MinimaxH3UploadOptions {
  serverBaseUrl: string;
  fetchWithAuth: FetchWithAuth;
}

const MB = 1024 * 1024;
const MAX_BYTES: Record<MinimaxH3MediaType, number> = {
  image: 30 * MB,
  video: 50 * MB,
  audio: 15 * MB,
};
const ALLOWED_EXTENSIONS: Record<MinimaxH3MediaType, Set<string>> = {
  image: new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']),
  video: new Set(['.mp4', '.mov']),
  audio: new Set(['.wav', '.mp3']),
};
const MIME_EXTENSION: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/mpeg': '.mp3',
};
const EXTENSION_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_EXTENSION).map(([mime, extension]) => [extension, mime]),
);

const typeLabel = (mediaType: MinimaxH3MediaType): string => (
  mediaType === 'image' ? '图片' : mediaType === 'video' ? '视频' : '音频'
);

const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value);

const isMinimaxH3 = (model: string): boolean => model.trim().toLowerCase() === 'minimax-h3';

const dataUrlPayload = (ref: string): { buffer: Buffer; mime: string; extension: string } => {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/i.exec(ref);
  if (!match) throw new Error('素材 Base64 数据格式无效');
  const mime = (match[1] || 'application/octet-stream').toLowerCase();
  const buffer = match[2]
    ? Buffer.from(match[3], 'base64')
    : Buffer.from(decodeURIComponent(match[3]), 'utf8');
  return { buffer, mime, extension: MIME_EXTENSION[mime] || '' };
};

const localFilePath = (ref: string): string => (
  ref.startsWith('file://') ? fileURLToPath(ref) : path.resolve(ref)
);

const assertSupportedExtension = (mediaType: MinimaxH3MediaType, extension: string): void => {
  if (!ALLOWED_EXTENSIONS[mediaType].has(extension.toLowerCase())) {
    const formats = [...ALLOWED_EXTENSIONS[mediaType]].map(value => value.slice(1).toUpperCase()).join('、');
    throw new Error(`${typeLabel(mediaType)}格式不支持，仅支持 ${formats}`);
  }
};

export const assertMinimaxH3MediaSize = (mediaType: MinimaxH3MediaType, sizeBytes: number): void => {
  if (sizeBytes <= 0) throw new Error('素材文件不能为空');
  if (sizeBytes > MAX_BYTES[mediaType]) {
    throw new Error(`${typeLabel(mediaType)}单文件不能超过 ${MAX_BYTES[mediaType] / MB} MB，请压缩、裁剪或重新选择文件`);
  }
};

const validateReference = async (ref: string, mediaType: MinimaxH3MediaType): Promise<void> => {
  if (!ref.trim()) throw new Error('素材地址不能为空');
  if (isHttpUrl(ref)) return;
  if (ref.startsWith('data:')) {
    const payload = dataUrlPayload(ref);
    assertSupportedExtension(mediaType, payload.extension);
    assertMinimaxH3MediaSize(mediaType, payload.buffer.length);
    return;
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(ref) && !ref.startsWith('file://')) {
    throw new Error('MiniMax-H3 素材仅支持本地文件或 HTTP(S) 公网地址');
  }
  const filePath = localFilePath(ref);
  const extension = path.extname(filePath).toLowerCase();
  assertSupportedExtension(mediaType, extension);
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error(`素材不是有效文件：${filePath}`);
  assertMinimaxH3MediaSize(mediaType, stat.size);
};

const stringValues = (value: unknown): string[] => {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map(item => item.trim());
};

type CollectedInputs = {
  firstFrames: Set<string>;
  lastFrames: Set<string>;
  referenceImages: Set<string>;
  videos: Set<string>;
  audios: Set<string>;
  refs: Array<{ ref: string; mediaType: MinimaxH3MediaType }>;
};

const createInputs = (): CollectedInputs => ({
  firstFrames: new Set(),
  lastFrames: new Set(),
  referenceImages: new Set(),
  videos: new Set(),
  audios: new Set(),
  refs: [],
});

const addRef = (inputs: CollectedInputs, ref: string, mediaType: MinimaxH3MediaType, role = ''): void => {
  inputs.refs.push({ ref, mediaType });
  if (mediaType === 'video') {
    inputs.videos.add(ref);
  } else if (mediaType === 'audio') {
    inputs.audios.add(ref);
  } else if (/last[_-]?frame/i.test(role)) {
    inputs.lastFrames.add(ref);
  } else if (/reference/i.test(role)) {
    inputs.referenceImages.add(ref);
  } else {
    inputs.firstFrames.add(ref);
  }
};

const mediaTypeFromItem = (item: Record<string, unknown>): MinimaxH3MediaType | null => {
  const type = String(item.type || item.role || '').toLowerCase();
  if (type.includes('video')) return 'video';
  if (type.includes('audio')) return 'audio';
  if (type.includes('image') || type.includes('frame')) return 'image';
  if (item.video_url) return 'video';
  if (item.audio_url) return 'audio';
  if (item.image_url) return 'image';
  return null;
};

const nestedUrl = (value: unknown): string | null => {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const url = (value as Record<string, unknown>).url;
    return typeof url === 'string' ? url : null;
  }
  return null;
};

const inferMediaTypeFromRef = (ref: string): MinimaxH3MediaType => {
  const lower = ref.toLowerCase();
  if (lower.startsWith('data:video/') || ['.mp4', '.mov', '.webm'].some(extension => lower.includes(extension))) return 'video';
  if (lower.startsWith('data:audio/') || ['.wav', '.mp3'].some(extension => lower.includes(extension))) return 'audio';
  return 'image';
};

const collectMediaItems = (inputs: CollectedInputs, raw: unknown): void => {
  if (!Array.isArray(raw)) return;
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const mediaType = mediaTypeFromItem(record);
    if (!mediaType) continue;
    const ref = nestedUrl(record.url)
      || nestedUrl(record[`${mediaType}_url`]);
    if (ref) addRef(inputs, ref, mediaType, String(record.role || record.type || ''));
  }
};

const collectInputs = (params: Record<string, unknown>): CollectedInputs => {
  const inputs = createInputs();
  stringValues(params.firstFrame).forEach(ref => addRef(inputs, ref, 'image', 'first_frame'));
  stringValues(params.lastFrame).forEach(ref => addRef(inputs, ref, 'image', 'last_frame'));
  stringValues(params.referenceImages).forEach(ref => addRef(inputs, ref, 'image', 'reference_image'));
  for (const key of ['referenceVideos', 'videos', 'video', 'videoUrl']) {
    stringValues(params[key]).forEach(ref => addRef(inputs, ref, 'video', 'reference_video'));
  }
  for (const key of ['referenceAudios', 'audios', 'audioUrl']) {
    stringValues(params[key]).forEach(ref => addRef(inputs, ref, 'audio', 'reference_audio'));
  }
  collectMediaItems(inputs, params.media);
  collectMediaItems(inputs, params.content);
  const providerOptions = params.providerOptions;
  if (providerOptions && typeof providerOptions === 'object' && !Array.isArray(providerOptions)) {
    collectMediaItems(inputs, (providerOptions as Record<string, unknown>).media);
  }
  const genericImages = stringValues(params.images);
  const imageRoles = stringValues(params.imageRoles);
  const referenceMode = inputs.referenceImages.size > 0 || inputs.videos.size > 0 || inputs.audios.size > 0;
  genericImages.forEach((ref, index) => {
    const role = imageRoles[index] || (referenceMode ? 'reference_image' : index === 0 ? 'first_frame' : 'last_frame');
    addRef(inputs, ref, 'image', role);
  });
  return inputs;
};

export const validateMinimaxH3MediaParams = async (params: Record<string, unknown>): Promise<void> => {
  const inputs = collectInputs(params);
  if (inputs.videos.size > 3) throw new Error('MiniMax-H3 参考视频最多 3 个');
  if (inputs.audios.size > 3) throw new Error('MiniMax-H3 参考音频最多 3 个');
  const referenceMode = inputs.referenceImages.size > 0 || inputs.videos.size > 0 || inputs.audios.size > 0;
  if (referenceMode && (inputs.firstFrames.size > 0 || inputs.lastFrames.size > 0)) {
    throw new Error('MiniMax-H3 首尾帧模式与多模态参考模式不能混用');
  }
  if (inputs.referenceImages.size > 9) throw new Error('MiniMax-H3 参考图片最多 9 张');
  if (!referenceMode && inputs.firstFrames.size > 1) throw new Error('MiniMax-H3 首帧图片最多 1 张');
  if (!referenceMode && inputs.lastFrames.size > 1) throw new Error('MiniMax-H3 尾帧图片最多 1 张');
  await Promise.all(inputs.refs.map(({ ref, mediaType }) => validateReference(ref, mediaType)));
};

const uploadReference = async (
  ref: string,
  mediaType: MinimaxH3MediaType,
  options: MinimaxH3UploadOptions,
): Promise<string> => {
  if (isHttpUrl(ref)) return ref;
  await validateReference(ref, mediaType);

  let buffer: Buffer;
  let filename: string;
  let mime: string;
  if (ref.startsWith('data:')) {
    const payload = dataUrlPayload(ref);
    buffer = payload.buffer;
    filename = `input${payload.extension}`;
    mime = payload.mime;
  } else {
    const filePath = localFilePath(ref);
    buffer = await fs.promises.readFile(filePath);
    filename = path.basename(filePath);
    mime = EXTENSION_MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  }

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), filename);
  form.append('mediaType', mediaType);
  form.append('model', 'MiniMax-H3');
  const response = await options.fetchWithAuth(`${options.serverBaseUrl}/api/media/uploads`, {
    method: 'POST',
    body: form,
  });
  const body = await response.json() as { code?: number; message?: string; data?: { url?: string } };
  if (!response.ok || body.code !== 0 || !body.data?.url || !isHttpUrl(body.data.url)) {
    throw new Error(body.message || `素材上传失败（HTTP ${response.status}）`);
  }
  return body.data.url;
};

const replaceString = async (
  value: unknown,
  mediaType: MinimaxH3MediaType,
  upload: (ref: string, type: MinimaxH3MediaType) => Promise<string>,
): Promise<unknown> => {
  if (typeof value === 'string') return upload(value, mediaType);
  if (!Array.isArray(value)) return value;
  return Promise.all(value.map(item => typeof item === 'string' ? upload(item, mediaType) : item));
};

const replaceMediaItems = async (
  raw: unknown,
  upload: (ref: string, type: MinimaxH3MediaType) => Promise<string>,
): Promise<unknown> => {
  if (!Array.isArray(raw)) return raw;
  return Promise.all(raw.map(async item => {
    if (typeof item === 'string') return upload(item, inferMediaTypeFromRef(item));
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const next = { ...(item as Record<string, unknown>) };
    const directUrl = nestedUrl(next.url);
    const mediaType = mediaTypeFromItem(next) || (directUrl ? inferMediaTypeFromRef(directUrl) : null);
    if (!mediaType) return next;
    if (typeof next.url === 'string') next.url = await upload(next.url, mediaType);
    const nestedKey = `${mediaType}_url`;
    if (typeof next[nestedKey] === 'string') {
      next[nestedKey] = await upload(next[nestedKey] as string, mediaType);
    } else if (next[nestedKey] && typeof next[nestedKey] === 'object' && !Array.isArray(next[nestedKey])) {
      const nested = next[nestedKey] as Record<string, unknown>;
      if (typeof nested.url === 'string') {
        next[nestedKey] = { ...nested, url: await upload(nested.url, mediaType) };
      }
    }
    return next;
  }));
};

export const uploadMinimaxH3MediaParams = async (
  params: Record<string, unknown>,
  options: MinimaxH3UploadOptions,
): Promise<Record<string, unknown>> => {
  await validateMinimaxH3MediaParams(params);
  const cache = new Map<string, Promise<string>>();
  const upload = (ref: string, mediaType: MinimaxH3MediaType): Promise<string> => {
    const key = `${mediaType}:${ref}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = uploadReference(ref, mediaType, options);
      cache.set(key, pending);
    }
    return pending;
  };
  const next: Record<string, unknown> = { ...params };
  for (const key of ['firstFrame', 'lastFrame', 'referenceImages', 'images']) {
    if (key in next) next[key] = await replaceString(next[key], 'image', upload);
  }
  for (const key of ['referenceVideos', 'videos', 'video', 'videoUrl']) {
    if (key in next) next[key] = await replaceString(next[key], 'video', upload);
  }
  for (const key of ['referenceAudios', 'audios', 'audioUrl']) {
    if (key in next) next[key] = await replaceString(next[key], 'audio', upload);
  }
  if ('media' in next) next.media = await replaceMediaItems(next.media, upload);
  if ('content' in next) next.content = await replaceMediaItems(next.content, upload);
  if (next.providerOptions && typeof next.providerOptions === 'object' && !Array.isArray(next.providerOptions)) {
    const providerOptions = { ...(next.providerOptions as Record<string, unknown>) };
    if ('media' in providerOptions) providerOptions.media = await replaceMediaItems(providerOptions.media, upload);
    next.providerOptions = providerOptions;
  }
  return next;
};

const LEGACY_MEDIA_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

export const resolveLegacyMediaGenerationReferences = async (
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const resolveRef = async (ref: string): Promise<string> => {
    if (!ref || isHttpUrl(ref) || ref.startsWith('oss://') || ref.startsWith('data:')) return ref;
    const filePath = localFilePath(ref);
    const buffer = await fs.promises.readFile(filePath);
    const mime = LEGACY_MEDIA_MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    return `data:${mime};base64,${buffer.toString('base64')}`;
  };
  const next: Record<string, unknown> = { ...params };
  const replaceLegacyString = async (value: unknown): Promise<unknown> => {
    if (typeof value === 'string') return resolveRef(value);
    if (!Array.isArray(value)) return value;
    return Promise.all(value.map(item => typeof item === 'string' ? resolveRef(item) : item));
  };
  for (const key of ['images', 'firstFrame', 'lastFrame', 'referenceImages', 'videos', 'referenceAudios', 'audios']) {
    if (key in next) next[key] = await replaceLegacyString(next[key]);
  }
  if ('media' in next) {
    const resolveAnyMedia = async (ref: string, _mediaType: MinimaxH3MediaType): Promise<string> => resolveRef(ref);
    next.media = await replaceMediaItems(next.media, resolveAnyMedia);
  }
  return next;
};

export const usesMinimaxH3NosUpload = (model: string): boolean => isMinimaxH3(model);
