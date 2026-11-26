import fs from 'fs';
import path from 'path';
import { Readable, Transform } from 'stream';

import type { ArtifactFileAccess } from '../shared/artifactPreview/types';

type CaptureFileAccess = (
  filePath: string,
  access?: ArtifactFileAccess,
) => { assertAllowed: (filePath?: string) => void };

const activeStreams = new Map<Transform, () => void>();

export function revalidateLocalFileProtocolStreams(): void {
  for (const [stream, assertAllowed] of activeStreams) {
    try {
      assertAllowed();
    } catch {
      stream.destroy(new Error('Not found'));
    }
  }
}

function createCheckedFileStream(filePath: string, range: ByteRange | null, assertAllowed: () => void): BodyInit {
  const stream = fs.createReadStream(filePath, range ?? undefined);
  const checkedStream = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        assertAllowed();
        callback(null, chunk);
      } catch {
        callback(new Error('Not found'));
      }
    },
  });
  activeStreams.set(checkedStream, assertAllowed);
  stream.on('error', error => checkedStream.destroy(error));
  checkedStream.once('close', () => {
    activeStreams.delete(checkedStream);
    stream.destroy();
  });
  return Readable.toWeb(stream.pipe(checkedStream)) as BodyInit;
}

function notFoundResponse(): Response {
  return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
}

import { ArtifactPreviewHost } from '../shared/artifactPreview/constants';
import {
  LOCAL_FILE_THUMBNAIL_FIT_PARAM,
  LOCAL_FILE_THUMBNAIL_PARAM,
  type LocalFileThumbnailFit,
  parseLocalFileThumbnailFit,
} from '../shared/artifactPreview/localFileThumbnail';
import { sniffImageMimeType } from '../shared/cowork/imageAttachments';

// Only media files, which is all the app displays through this scheme (conversation images, media
// artifacts, the image editor). Any other type is refused, documents included.
const LOCAL_FILE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
};

// The scheme serves files from anywhere on disk, and a page with its origin could fetch every one
// of them. A served file can still be framed or opened as a page (an SVG runs script that way), so
// `sandbox` gives it an opaque origin with scripts off. <img>, <video> and <audio> ignore it.
const LOCAL_FILE_SECURITY_HEADERS = {
  'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
  'X-Content-Type-Options': 'nosniff',
} as const;

export type ByteRange = {
  start: number;
  end: number;
};

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stripMediaTokenPrefix(filePath: string): string {
  const mediaMatch = filePath.match(/(?:^|[\\/])MEDIA:\s*(.+)$/i);
  if (mediaMatch) {
    return mediaMatch[1].trim();
  }
  return filePath.replace(/^MEDIA:\s*/i, '').trim();
}

export function getLocalFileProtocolPath(requestUrl: string): string {
  const url = new URL(requestUrl);
  let filePath = safeDecodeURIComponent(url.pathname);
  filePath = stripMediaTokenPrefix(filePath);
  if (process.platform === 'win32' && /^[A-Za-z]$/.test(url.host) && filePath.startsWith('/')) {
    return `${url.host}:${filePath}`;
  }
  if (url.host && url.host !== ArtifactPreviewHost.LocalFile && process.platform !== 'win32') {
    filePath = stripMediaTokenPrefix(`/${safeDecodeURIComponent(url.host)}${filePath}`);
  }
  if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(filePath)) {
    filePath = filePath.slice(1);
  }
  return filePath;
}

/** The served type for a file, or null when the scheme does not serve that kind of file. */
export function getLocalFileMimeType(filePath: string): string | null {
  return LOCAL_FILE_MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? null;
}

const IMAGE_SNIFF_HEADER_BYTES = 16;

/**
 * Sniffs raster image magic bytes for extensionless files (such as DSH
 * content-addressed attachment objects under `attachments/v1/objects/`).
 * Files with an explicit non-media extension are never sniffed.
 */
async function sniffExtensionlessLocalImageMimeType(filePath: string): Promise<string | null> {
  if (path.extname(filePath) !== '') return null;
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const header = Buffer.alloc(IMAGE_SNIFF_HEADER_BYTES);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead <= 0) return null;
    return sniffImageMimeType(header.subarray(0, bytesRead)) ?? null;
  } finally {
    await handle.close();
  }
}

/**
 * The absolute path on a local disk that a request names, or null. On Windows only drive-letter
 * paths pass: UNC (`\\host\share`, `//host/share`) and device (`\\?\`, `\\.\`) paths would make
 * the main process open a network share, sending the user's credentials to it.
 */
export function resolveServableLocalPath(filePath: string): string | null {
  if (!filePath || filePath.includes('\0')) return null;
  if (process.platform === 'win32') {
    const resolved = path.win32.resolve(filePath);
    return /^[A-Za-z]:\\/.test(resolved) ? resolved : null;
  }
  return filePath.startsWith('/') ? path.posix.resolve(filePath) : null;
}

function parseSingleByteRange(rangeText: string, fileSize: number): ByteRange | null {
  const match = rangeText.match(/^(\d*)\s*-\s*(\d*)$/);
  if (!match) return null;

  const [, startText, endText] = match;
  if (!startText && !endText) return null;

  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    return {
      start: Math.max(fileSize - suffixLength, 0),
      end: fileSize - 1,
    };
  }

  const start = Number(startText);
  const end = endText ? Number(endText) : fileSize - 1;
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < start ||
    start >= fileSize
  ) {
    return null;
  }

  return {
    start,
    end: Math.min(end, fileSize - 1),
  };
}

export function parseByteRange(rangeHeader: string | null, fileSize: number): ByteRange | null {
  if (!rangeHeader || fileSize <= 0) return null;
  const separatorIndex = rangeHeader.indexOf('=');
  if (separatorIndex < 0) return null;

  const unit = rangeHeader.slice(0, separatorIndex).trim().toLowerCase();
  if (unit !== 'bytes') return null;

  const rangeSet = rangeHeader.slice(separatorIndex + 1);
  const rangeTexts = rangeSet.split(',').map(range => range.trim()).filter(Boolean);
  for (const rangeText of rangeTexts) {
    const range = parseSingleByteRange(rangeText, fileSize);
    if (range) return range;
  }
  return null;
}

function buildLocalFileBaseHeaders(filePath: string, size: number, mimeType: string): Record<string, string> {
  const filename = encodeURIComponent(path.basename(filePath));
  return {
    ...LOCAL_FILE_SECURITY_HEADERS,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Disposition': `inline; filename*=UTF-8''${filename}`,
    'Content-Length': String(size),
    'Content-Type': mimeType,
  };
}

export interface LocalFileProtocolOptions {
  captureAccess?: CaptureFileAccess;
  /** A downscaled copy to serve for a `thumb` request, or null to serve the file itself. */
  resolveThumbnail?: (filePath: string, stat: fs.Stats, edge: number, fit: LocalFileThumbnailFit) => Promise<string | null>;
}

/** Swaps in a thumbnail when one is asked for and can be had; any failure falls back to the file. */
async function resolveThumbnailFile(
  requestUrl: string,
  filePath: string,
  stat: fs.Stats,
  options: LocalFileProtocolOptions | undefined,
): Promise<{ filePath: string; stat: fs.Stats }> {
  const params = new URL(requestUrl).searchParams;
  const edge = Number(params.get(LOCAL_FILE_THUMBNAIL_PARAM));
  if (!options?.resolveThumbnail || !Number.isFinite(edge) || edge <= 0) return { filePath, stat };
  try {
    const fit = parseLocalFileThumbnailFit(params.get(LOCAL_FILE_THUMBNAIL_FIT_PARAM));
    const thumbnailPath = await options.resolveThumbnail(filePath, stat, edge, fit);
    const thumbnailStat = thumbnailPath ? await fs.promises.stat(thumbnailPath) : null;
    return thumbnailPath && thumbnailStat?.isFile() ? { filePath: thumbnailPath, stat: thumbnailStat } : { filePath, stat };
  } catch (error) {
    console.warn('[ArtifactPreview] local file thumbnail failed; serving the original:', error);
    return { filePath, stat };
  }
}

export async function createLocalFileProtocolResponse(
  request: Request,
  options?: LocalFileProtocolOptions,
): Promise<Response> {
  try {
    const sourcePath = resolveServableLocalPath(getLocalFileProtocolPath(request.url));
    const extensionMime = sourcePath ? getLocalFileMimeType(sourcePath) : null;
    if (!sourcePath || (!extensionMime && path.extname(sourcePath) !== '')) {
      console.warn('[ArtifactPreview] refused local file request: not a served media file on a local disk');
      return new Response('Forbidden', { status: 403 });
    }
    const serialized = new URL(request.url).searchParams.get('access');
    const access = serialized === null ? undefined : JSON.parse(serialized) as ArtifactFileAccess;
    const captured = options?.captureAccess?.(sourcePath, access);
    const assertAllowed = (): void => { captured?.assertAllowed(sourcePath); };
    assertAllowed();
    const sourceStat = await fs.promises.stat(sourcePath);
    assertAllowed();
    if (!sourceStat.isFile()) {
      return notFoundResponse();
    }
    const sourceMime = extensionMime ?? await sniffExtensionlessLocalImageMimeType(sourcePath);
    if (!sourceMime) {
      console.warn('[ArtifactPreview] refused local file request: not a served media file on a local disk');
      return new Response('Forbidden', { status: 403 });
    }
    const { filePath, stat } = await resolveThumbnailFile(request.url, sourcePath, sourceStat, options);
    // Thumbnails inherit the original file grant, including revocation during generation or streaming.
    assertAllowed();

    const mimeType = getLocalFileMimeType(filePath)
      ?? (filePath === sourcePath ? sourceMime : await sniffExtensionlessLocalImageMimeType(filePath));
    if (!mimeType) {
      return new Response('Forbidden', { status: 403 });
    }
    const baseHeaders = buildLocalFileBaseHeaders(filePath, stat.size, mimeType);
    const rangeHeader = request.headers.get('range');
    const range = parseByteRange(rangeHeader, stat.size);

    if (rangeHeader && !range) {
      return new Response(null, {
        status: 416,
        headers: {
          ...baseHeaders,
          'Content-Length': '0',
          'Content-Range': `bytes */${stat.size}`,
        },
      });
    }

    if (range) {
      const contentLength = range.end - range.start + 1;
      return new Response(
        request.method === 'HEAD'
          ? null
          : createCheckedFileStream(filePath, range, assertAllowed),
        {
          status: 206,
          headers: {
            ...baseHeaders,
            'Content-Length': String(contentLength),
            'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
          },
        },
      );
    }

    return new Response(
      request.method === 'HEAD'
        ? null
        : createCheckedFileStream(filePath, null, assertAllowed),
      {
        status: 200,
        headers: baseHeaders,
      },
    );
  } catch (error) {
    console.warn('[ArtifactPreview] local file request failed:', error);
    return notFoundResponse();
  }
}
