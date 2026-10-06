import {
  SkinAssetMimeType,
  SkinAssetSlot,
} from '@shared/skin/constants';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  buildSkinAssetUrl,
  createSkinProtocolHandler,
  createSkinProtocolResponse,
  parseSkinProtocolUrl,
} from './skinProtocol';

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function createManagedAsset(): {
  rootDir: string;
  relativePath: string;
  contentHash: string;
  content: Buffer;
} {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-skin-protocol-'));
  tempDirs.push(rootDir);
  const relativePath = 'skin-one/assets/workspace-backdrop.png';
  const filePath = path.join(rootDir, ...relativePath.split('/'));
  const content = Buffer.from('managed image bytes');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return {
    rootDir,
    relativePath,
    content,
    contentHash: createHash('sha256').update(content).digest('hex'),
  };
}

describe('skin protocol URL', () => {
  test('round-trips allowlisted skin ids, slots, and content hashes', () => {
    const hash = 'a'.repeat(64);
    const url = buildSkinAssetUrl('skin-one', SkinAssetSlot.WorkspaceBackdrop, hash);
    expect(parseSkinProtocolUrl(url)).toEqual({
      skinId: 'skin-one',
      slot: SkinAssetSlot.WorkspaceBackdrop,
      contentHash: hash,
    });
  });

  test('rejects unsupported hosts, slots, traversal, credentials, and query parameters', () => {
    expect(parseSkinProtocolUrl('https://asset/skin-one/workspace.backdrop')).toBeNull();
    expect(parseSkinProtocolUrl('lobster-skin://other/skin-one/workspace.backdrop')).toBeNull();
    expect(parseSkinProtocolUrl('lobster-skin://asset/skin-one/unknown.slot')).toBeNull();
    expect(parseSkinProtocolUrl('lobster-skin://asset/%2e%2e/workspace.backdrop')).toBeNull();
    expect(parseSkinProtocolUrl('lobster-skin://asset/skin-one/workspace%2fbackdrop')).toBeNull();
    expect(parseSkinProtocolUrl('lobster-skin://user@asset/skin-one/workspace.backdrop')).toBeNull();
    expect(parseSkinProtocolUrl('lobster-skin://asset/skin-one/workspace.backdrop?path=local')).toBeNull();
  });
});

describe('skin protocol response', () => {
  test('streams only a resolver-registered file with defensive image headers', async () => {
    const asset = createManagedAsset();
    const resolveAsset = vi.fn(async () => ({
      relativePath: asset.relativePath,
      mimeType: SkinAssetMimeType.Png,
      contentHash: asset.contentHash,
    }));
    const handler = createSkinProtocolHandler({ rootDir: asset.rootDir, resolveAsset });
    const url = buildSkinAssetUrl('skin-one', SkinAssetSlot.WorkspaceBackdrop, asset.contentHash);

    const response = await handler(new Request(url));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(SkinAssetMimeType.Png);
    expect(response.headers.get('content-length')).toBe(String(asset.content.length));
    expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('etag')).toBe(`"sha256-${asset.contentHash}"`);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(asset.content);
    expect(resolveAsset).toHaveBeenCalledWith('skin-one', SkinAssetSlot.WorkspaceBackdrop);
  });

  test('supports HEAD and rejects unsupported methods', async () => {
    const asset = createManagedAsset();
    const options = {
      rootDir: asset.rootDir,
      resolveAsset: async () => ({
        relativePath: asset.relativePath,
        mimeType: SkinAssetMimeType.Png,
        contentHash: asset.contentHash,
      }),
    };
    const url = buildSkinAssetUrl('skin-one', SkinAssetSlot.WorkspaceBackdrop);

    const headResponse = await createSkinProtocolResponse(new Request(url, { method: 'HEAD' }), options);
    expect(headResponse.status).toBe(200);
    expect(headResponse.headers.get('cache-control')).toBe('no-store');
    expect(await headResponse.text()).toBe('');
    const postResponse = await createSkinProtocolResponse(new Request(url, { method: 'POST' }), options);
    expect(postResponse.status).toBe(405);
    expect(postResponse.headers.get('allow')).toBe('GET, HEAD');
  });

  test('rejects stale hashes and resolver paths outside the managed root', async () => {
    const asset = createManagedAsset();
    const staleUrl = buildSkinAssetUrl('skin-one', SkinAssetSlot.WorkspaceBackdrop, 'b'.repeat(64));
    const registeredAsset = {
      relativePath: asset.relativePath,
      mimeType: SkinAssetMimeType.Png,
      contentHash: asset.contentHash,
    };
    const staleResponse = await createSkinProtocolResponse(new Request(staleUrl), {
      rootDir: asset.rootDir,
      resolveAsset: async () => registeredAsset,
    });
    expect(staleResponse.status).toBe(404);

    const traversalResponse = await createSkinProtocolResponse(
      new Request(buildSkinAssetUrl('skin-one', SkinAssetSlot.WorkspaceBackdrop)),
      {
        rootDir: asset.rootDir,
        resolveAsset: async () => ({ ...registeredAsset, relativePath: '../outside.png' }),
      },
    );
    expect(traversalResponse.status).toBe(404);
  });
});
