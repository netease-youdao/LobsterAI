export const MAX_INBOUND_MEDIA_BYTES = 15 * 1024 * 1024;
export const DEFAULT_MEDIA_DOWNLOAD_TIMEOUT_MS = 30_000;

export function createTimeoutSignal(timeoutMs, parentSignal) {
  const controller = new AbortController();
  const onParentAbort = () => {
    controller.abort(parentSignal?.reason ?? new Error('Aborted'));
  };

  if (parentSignal) {
    if (parentSignal.aborted) {
      onParentAbort();
    } else {
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
  }

  const timer =
    typeof timeoutMs === 'number' && timeoutMs > 0
      ? setTimeout(() => {
          controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
        }, timeoutMs)
      : null;
  timer?.unref?.();

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer !== null) clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onParentAbort);
    },
  };
}

export function normalizeMediaUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  return trimmed;
}

export async function fetchBinaryWithLimit(url, options = {}) {
  const resolvedUrl = normalizeMediaUrl(url);
  if (!resolvedUrl) {
    throw new Error('Media download URL is empty');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_MEDIA_DOWNLOAD_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_INBOUND_MEDIA_BYTES;
  const reqAbort = createTimeoutSignal(timeoutMs, options.signal);
  try {
    const res = await fetch(resolvedUrl, {
      method: options.method || 'GET',
      headers: options.headers,
      body: options.body,
      signal: reqAbort.signal,
    });
    if (!res.ok) {
      throw new Error(`Media download failed (HTTP ${res.status})`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0) {
      throw new Error('Downloaded media payload is empty');
    }
    if (buf.byteLength > maxBytes) {
      throw new Error(`Downloaded media exceeds limit (${buf.byteLength} > ${maxBytes} bytes)`);
    }
    return {
      buffer: buf,
      contentType: (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(),
    };
  } finally {
    reqAbort.cleanup();
  }
}

export function detectImageMime(buf, fallbackMime = 'image/jpeg') {
  if (buf.byteLength >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { mimeType: 'image/png', ext: 'png' };
  }
  if (buf.byteLength >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mimeType: 'image/jpeg', ext: 'jpg' };
  }
  if (buf.byteLength >= 4 && buf.subarray(0, 4).toString('ascii') === 'GIF8') {
    return { mimeType: 'image/gif', ext: 'gif' };
  }
  if (
    buf.byteLength >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mimeType: 'image/webp', ext: 'webp' };
  }
  if (buf.byteLength >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return { mimeType: 'image/bmp', ext: 'bmp' };
  }
  const normalized = String(fallbackMime || '').toLowerCase();
  if (normalized.startsWith('image/png')) return { mimeType: 'image/png', ext: 'png' };
  if (normalized.startsWith('image/gif')) return { mimeType: 'image/gif', ext: 'gif' };
  if (normalized.startsWith('image/webp')) return { mimeType: 'image/webp', ext: 'webp' };
  if (normalized.startsWith('image/bmp')) return { mimeType: 'image/bmp', ext: 'bmp' };
  if (normalized.startsWith('image/avif')) return { mimeType: 'image/avif', ext: 'avif' };
  return { mimeType: 'image/jpeg', ext: 'jpg' };
}

const AUDIO_EXT_RE = /\.(silk|slk|amr|awb|ogg|oga|opus|mp3|wav|m4a|aac|mp4|webm|flac|spx|pcm)(?:[?#].*)?$/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|avif)(?:[?#].*)?$/i;

export function isAudioAttachment(contentType, fileName) {
  const mime = String(contentType || '').toLowerCase().split(';')[0].trim();
  if (mime.startsWith('audio/') || mime === 'voice' || mime === 'application/ogg') {
    return true;
  }
  return AUDIO_EXT_RE.test(String(fileName || ''));
}

export function isImageAttachment(contentType, fileName) {
  const mime = String(contentType || '').toLowerCase().split(';')[0].trim();
  if (mime.startsWith('image/') || mime === 'image') {
    return true;
  }
  return IMAGE_EXT_RE.test(String(fileName || ''));
}
