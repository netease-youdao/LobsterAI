import { isIP } from 'node:net';

export const MAX_INBOUND_MEDIA_BYTES = 15 * 1024 * 1024;
export const DEFAULT_MEDIA_DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_MEDIA_REDIRECTS = 5;
const REDIRECT_HTTP_STATUSES = new Set([301, 302, 303, 307, 308]);
const SAFE_PUBLIC_HOSTNAME_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const SAFE_PORT_RE = /^[0-9]{1,5}$/;
const SAFE_PATHNAME_RE = /^\/[A-Za-z0-9._~:@!$&'()*+,;=%[\]/-]*$/;
const SAFE_QUERY_RE = /^[!"$-~]*$/;

function isPrivateOrReservedIpv4(hostname) {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function isBlockedMediaHostname(hostname) {
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.home.arpa') ||
    hostname.endsWith('.localdomain')
  ) {
    return true;
  }
  const ipVersion = isIP(hostname);
  if (ipVersion === 6) return true;
  if (ipVersion === 4) return isPrivateOrReservedIpv4(hostname);
  return false;
}

function hasUnsafePathSegments(pathname) {
  for (const segment of pathname.split('/')) {
    if (!segment) continue;
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    if (
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('\\') ||
      decoded.includes('\0')
    ) {
      return true;
    }
  }
  return false;
}

export function validateMediaDownloadUrl(rawUrl) {
  const resolvedUrl = normalizeMediaUrl(rawUrl);
  if (!resolvedUrl) {
    throw new Error('Media download URL is empty');
  }
  let parsed;
  try {
    parsed = new URL(resolvedUrl);
  } catch {
    throw new Error('Media download URL is invalid');
  }
  const protocol =
    parsed.protocol === 'https:'
      ? 'https:'
      : parsed.protocol === 'http:'
        ? 'http:'
        : '';
  if (!protocol) {
    throw new Error(`Unsupported media download protocol: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('Media download URL must not contain credentials');
  }
  const rawHost = parsed.hostname.toLowerCase();
  let hostEnd = rawHost.length;
  while (hostEnd > 0 && rawHost.charCodeAt(hostEnd - 1) === 46) {
    hostEnd -= 1;
  }
  const hostname = rawHost.slice(0, hostEnd);
  if (!SAFE_PUBLIC_HOSTNAME_RE.test(hostname)) {
    throw new Error('Media download URL host is not allowed');
  }
  if (isBlockedMediaHostname(hostname)) {
    throw new Error('Media download URL host is not allowed');
  }
  let portSuffix = '';
  const rawPort = parsed.port;
  if (rawPort) {
    if (!SAFE_PORT_RE.test(rawPort)) {
      throw new Error('Media download URL port is invalid');
    }
    const portNum = Number(rawPort);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      throw new Error('Media download URL port is out of range');
    }
    portSuffix = `:${rawPort}`;
  }
  const withoutQueryOrHash = resolvedUrl.split(/[?#]/, 1)[0];
  const schemeEnd = withoutQueryOrHash.indexOf('://');
  const rawPathStart = schemeEnd >= 0 ? withoutQueryOrHash.indexOf('/', schemeEnd + 3) : -1;
  const rawPath = rawPathStart >= 0 ? withoutQueryOrHash.slice(rawPathStart) : '';
  if (rawPath && hasUnsafePathSegments(rawPath)) {
    throw new Error('Media download URL path is not allowed');
  }
  const pathname = parsed.pathname || '/';
  if (!SAFE_PATHNAME_RE.test(pathname)) {
    throw new Error('Media download URL path is not allowed');
  }
  if (hasUnsafePathSegments(pathname)) {
    throw new Error('Media download URL path is not allowed');
  }
  const safeBase = `${protocol}//${hostname}${portSuffix}${pathname}`;
  const query = parsed.search.startsWith('?') ? parsed.search.slice(1) : '';
  if (query) {
    if (!SAFE_QUERY_RE.test(query)) {
      throw new Error('Media download URL query is not allowed');
    }
    return `${safeBase}?${query}`;
  }
  return safeBase;
}

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
  let currentUrl = validateMediaDownloadUrl(url);
  const timeoutMs = options.timeoutMs ?? DEFAULT_MEDIA_DOWNLOAD_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_INBOUND_MEDIA_BYTES;
  const reqAbort = createTimeoutSignal(timeoutMs, options.signal);
  let method = options.method || 'GET';
  let headers = options.headers;
  let body = options.body;
  try {
    let res;
    for (let redirectCount = 0; redirectCount <= MAX_MEDIA_REDIRECTS; redirectCount += 1) {
      res = await fetch(currentUrl, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: reqAbort.signal,
      });
      if (!REDIRECT_HTTP_STATUSES.has(res.status)) {
        break;
      }
      const location = res.headers.get('location');
      if (!location) {
        throw new Error(`Media download redirect missing Location header (HTTP ${res.status})`);
      }
      if (redirectCount === MAX_MEDIA_REDIRECTS) {
        throw new Error('Media download exceeded maximum redirect limit');
      }
      const prevOrigin = new URL(currentUrl).origin;
      const nextRawUrl = new URL(location, currentUrl).href;
      currentUrl = validateMediaDownloadUrl(nextRawUrl);
      if (new URL(currentUrl).origin !== prevOrigin && headers) {
        const nextHeaders = new Headers(headers);
        nextHeaders.delete('authorization');
        nextHeaders.delete('cookie');
        headers = nextHeaders;
      }
      if (
        res.status === 303 ||
        ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')
      ) {
        method = 'GET';
        body = undefined;
      }
    }
    if (!res || !res.ok) {
      throw new Error(`Media download failed (HTTP ${res?.status ?? 'unknown'})`);
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
