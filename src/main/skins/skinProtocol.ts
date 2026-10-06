import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';

import {
  SKIN_ASSET_SLOTS,
  SkinAssetMimeType,
  SkinAssetSlot,
  SkinProtocol,
} from '../../shared/skin/constants';
import type { ResolvedSkinProtocolAsset } from './skinStore';

export interface ParsedSkinProtocolUrl {
  skinId: string;
  slot: SkinAssetSlot;
  contentHash?: string;
}

export interface SkinProtocolHandlerOptions {
  rootDir: string;
  resolveAsset: (
    skinId: string,
    slot: SkinAssetSlot,
  ) => ResolvedSkinProtocolAsset | null | Promise<ResolvedSkinProtocolAsset | null>;
}

const SkinProtocolMethod = {
  Get: 'GET',
  Head: 'HEAD',
} as const;

const SKIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const ALLOWED_MIME_TYPES = new Set<string>(Object.values(SkinAssetMimeType));

function isSkinAssetSlot(value: string): value is SkinAssetSlot {
  return SKIN_ASSET_SLOTS.includes(value as SkinAssetSlot);
}

function decodePathSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    if (
      decoded.length === 0 ||
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('/') ||
      decoded.includes('\\') ||
      decoded.includes('\0')
    ) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

export function buildSkinAssetUrl(skinId: string, slot: SkinAssetSlot, contentHash?: string): string {
  if (!SKIN_ID_PATTERN.test(skinId) || !isSkinAssetSlot(slot)) {
    throw new TypeError('Invalid skin protocol asset identity');
  }
  if (contentHash !== undefined && !CONTENT_HASH_PATTERN.test(contentHash)) {
    throw new TypeError('Invalid skin protocol content hash');
  }
  const url = new URL(`${SkinProtocol.Scheme}://${SkinProtocol.Host}`);
  url.pathname = `/${encodeURIComponent(skinId)}/${encodeURIComponent(slot)}`;
  if (contentHash) url.searchParams.set('v', contentHash);
  return url.toString();
}

export function parseSkinProtocolUrl(requestUrl: string): ParsedSkinProtocolUrl | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }

  if (
    url.protocol !== `${SkinProtocol.Scheme}:` ||
    url.hostname !== SkinProtocol.Host ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.hash !== ''
  ) {
    return null;
  }

  const pathSegments = url.pathname.split('/');
  if (pathSegments.length !== 3 || pathSegments[0] !== '') return null;
  const skinId = decodePathSegment(pathSegments[1]);
  const slot = decodePathSegment(pathSegments[2]);
  if (!skinId || !SKIN_ID_PATTERN.test(skinId) || !slot || !isSkinAssetSlot(slot)) return null;

  const queryEntries = [...url.searchParams.entries()];
  if (queryEntries.length > 1 || (queryEntries.length === 1 && queryEntries[0][0] !== 'v')) return null;
  const contentHash = queryEntries.length === 1 ? queryEntries[0][1] : undefined;
  if (contentHash !== undefined && !CONTENT_HASH_PATTERN.test(contentHash)) return null;

  return {
    skinId,
    slot,
    ...(contentHash === undefined ? {} : { contentHash }),
  };
}

function resolvePathWithinRoot(rootDir: string, relativePath: string): string | null {
  if (
    !path.isAbsolute(rootDir) ||
    path.isAbsolute(relativePath) ||
    relativePath.includes('\\') ||
    relativePath.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    return null;
  }
  const resolved = path.resolve(rootDir, ...relativePath.split('/'));
  const relative = path.relative(rootDir, resolved);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
}

function isPathWithinRoot(rootDir: string, filePath: string): boolean {
  const relative = path.relative(rootDir, filePath);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function notFoundResponse(): Response {
  return new Response(null, {
    status: 404,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function createSkinProtocolResponse(
  request: Request,
  options: SkinProtocolHandlerOptions,
): Promise<Response> {
  if (request.method !== SkinProtocolMethod.Get && request.method !== SkinProtocolMethod.Head) {
    return new Response(null, {
      status: 405,
      headers: {
        Allow: `${SkinProtocolMethod.Get}, ${SkinProtocolMethod.Head}`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  const parsed = parseSkinProtocolUrl(request.url);
  if (!parsed || !path.isAbsolute(options.rootDir)) return notFoundResponse();

  try {
    const asset = await options.resolveAsset(parsed.skinId, parsed.slot);
    if (
      !asset ||
      !CONTENT_HASH_PATTERN.test(asset.contentHash) ||
      !ALLOWED_MIME_TYPES.has(asset.mimeType) ||
      (parsed.contentHash !== undefined && parsed.contentHash !== asset.contentHash)
    ) {
      return notFoundResponse();
    }

    const rootDir = path.resolve(options.rootDir);
    const filePath = resolvePathWithinRoot(rootDir, asset.relativePath);
    if (!filePath) return notFoundResponse();

    const [realRootDir, fileStat] = await Promise.all([
      fs.promises.realpath(rootDir),
      fs.promises.lstat(filePath),
    ]);
    if (!fileStat.isFile()) return notFoundResponse();
    const realFilePath = await fs.promises.realpath(filePath);
    if (!isPathWithinRoot(realRootDir, realFilePath)) return notFoundResponse();

    const headers = {
      'Cache-Control': parsed.contentHash
        ? 'private, max-age=31536000, immutable'
        : 'no-store',
      'Content-Length': String(fileStat.size),
      'Content-Type': asset.mimeType,
      ETag: `"sha256-${asset.contentHash}"`,
      'X-Content-Type-Options': 'nosniff',
    };
    return new Response(
      request.method === SkinProtocolMethod.Head
        ? null
        : Readable.toWeb(fs.createReadStream(realFilePath)) as BodyInit,
      { status: 200, headers },
    );
  } catch {
    return notFoundResponse();
  }
}

export function createSkinProtocolHandler(
  options: SkinProtocolHandlerOptions,
): (request: Request) => Promise<Response> {
  return request => createSkinProtocolResponse(request, options);
}
