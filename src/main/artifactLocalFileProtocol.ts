import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';

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
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

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
  if (url.host && process.platform !== 'win32') {
    filePath = stripMediaTokenPrefix(`/${safeDecodeURIComponent(url.host)}${filePath}`);
  }
  if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(filePath)) {
    filePath = filePath.slice(1);
  }
  return filePath;
}

export function getLocalFileMimeType(filePath: string): string {
  return LOCAL_FILE_MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
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
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'Content-Disposition': `inline; filename*=UTF-8''${filename}`,
    'Content-Length': String(size),
    'Content-Type': mimeType,
  };
}

export async function createLocalFileProtocolResponse(request: Request): Promise<Response> {
  try {
    const filePath = getLocalFileProtocolPath(request.url);
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) {
      return new Response('Not found', { status: 404 });
    }

    const mimeType = getLocalFileMimeType(filePath);
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
          : Readable.toWeb(fs.createReadStream(filePath, { start: range.start, end: range.end })) as BodyInit,
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
        : Readable.toWeb(fs.createReadStream(filePath)) as BodyInit,
      {
        status: 200,
        headers: baseHeaders,
      },
    );
  } catch (error) {
    console.warn('[ArtifactPreview] local file request failed:', error);
    return new Response('Not found', { status: 404 });
  }
}
