import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { ArtifactPreviewHost, ArtifactPreviewProtocol } from '../shared/artifactPreview/constants';
import {
  createLocalFileProtocolResponse,
  getLocalFileProtocolPath,
  parseByteRange,
  revalidateLocalFileProtocolStreams,
} from './artifactLocalFileProtocol';

let tempDir: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

function createTempFile(fileName: string, content: string): string {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-localfile-'));
  const filePath = path.join(tempDir, fileName);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function toLocalFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const pathForUrl = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return `localfile://${pathForUrl.split('/').map(encodeURIComponent).join('/')}`;
}

describe('artifact local file protocol', () => {
  test('parses Chromium-friendly byte ranges for media files', () => {
    expect(parseByteRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange('bytes=-25', 100)).toEqual({ start: 75, end: 99 });
    expect(parseByteRange('bytes=10-20', 100)).toEqual({ start: 10, end: 20 });
    expect(parseByteRange('bytes= 0 - 1 , 90-99', 100)).toEqual({ start: 0, end: 1 });
    expect(parseByteRange('bytes=200-210, 90-99', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=100-200', 100)).toBeNull();
  });

  test('resolves localfile URLs back to absolute file paths', () => {
    const filePath = createTempFile('generated video.mp4', '0123456789');
    expect(path.normalize(getLocalFileProtocolPath(toLocalFileUrl(filePath)))).toBe(path.normalize(filePath));
  });

  test('serves media through a standard URL with an explicit local authority', async () => {
    const filePath = createTempFile('generated video.mp4', '0123456789');
    const encodedPath = `/${filePath.replace(/\\/g, '/').replace(/^\//, '')}`.split('/').map(encodeURIComponent).join('/');
    const url = `${ArtifactPreviewProtocol.LocalFile}://${ArtifactPreviewHost.LocalFile}${encodedPath}?v=1`;
    expect(path.normalize(getLocalFileProtocolPath(url))).toBe(path.normalize(filePath));
    const response = await createLocalFileProtocolResponse(new Request(url, { headers: { Range: 'bytes=2-5' } }));
    expect(response.status).toBe(206);
    expect(await response.text()).toBe('2345');
  });

  test('recovers paths that were previously prefixed with cwd and MEDIA marker', () => {
    const url = 'localfile:///users/admin/work/test/test0623/MEDIA%3A/Users/admin/work/test/test0623/generated-video.mp4';
    expect(getLocalFileProtocolPath(url)).toBe('/Users/admin/work/test/test0623/generated-video.mp4');
  });

  test('returns partial content with video headers for range requests', async () => {
    const filePath = createTempFile('generated-video.mp4', '0123456789');
    const response = await createLocalFileProtocolResponse(
      new Request(toLocalFileUrl(filePath), {
        headers: {
          Range: 'bytes=2-5',
        },
      }),
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(response.headers.get('content-length')).toBe('4');
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(await response.text()).toBe('2345');
  });

  test('supports HEAD requests without streaming a body', async () => {
    const filePath = createTempFile('generated-video.mp4', '0123456789');
    const response = await createLocalFileProtocolResponse(
      new Request(toLocalFileUrl(filePath), { method: 'HEAD' }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('10');
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(await response.text()).toBe('');
  });

  test('preserves encoded query/hash characters in filenames while parsing the access grant', async () => {
    const filePath = createTempFile('preview?#.mp4', '0123456789');
    const access = { itemId: 'item-a', accountEpoch: 'epoch-a' };
    const url = `${toLocalFileUrl(filePath)}?access=${encodeURIComponent(JSON.stringify(access))}`;
    const assertAllowed = vi.fn();
    const captureAccess = vi.fn(() => ({ assertAllowed }));
    expect(getLocalFileProtocolPath(url)).toBe(filePath);
    const response = await createLocalFileProtocolResponse(new Request(url, {
      headers: { Range: 'bytes=2-5' },
    }), { captureAccess });
    expect(response.status).toBe(206);
    expect(await response.text()).toBe('2345');
    expect(captureAccess).toHaveBeenCalledWith(filePath, access);
    expect(assertAllowed).toHaveBeenCalledWith(filePath);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  test.each(['GET', 'HEAD'])('denies hidden files before exposing metadata for %s requests', async (method) => {
    const filePath = createTempFile('hidden.mp4', 'secret');
    const captureAccess = () => { throw new Error('Not found'); };
    const response = await createLocalFileProtocolResponse(new Request(toLocalFileUrl(filePath), {
      method, headers: { Range: 'bytes=0-1' },
    }), { captureAccess });
    expect(response.status).toBe(404);
    expect(response.headers.get('content-range')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('Not found');
  });

  test('rejects invalid access JSON without exposing file content', async () => {
    const filePath = createTempFile('hidden.mp4', 'secret');
    const captureAccess = vi.fn(() => ({ assertAllowed: vi.fn() }));
    const response = await createLocalFileProtocolResponse(new Request(`${toLocalFileUrl(filePath)}?access=invalid`), { captureAccess });
    expect(response.status).toBe(404);
    expect(captureAccess).not.toHaveBeenCalled();
  });

  test('revalidates a captured grant after asynchronous file metadata lookup', async () => {
    const filePath = createTempFile('preview.mp4', 'secret');
    const originalStat = fs.promises.stat.bind(fs.promises);
    let allowed = true;
    vi.spyOn(fs.promises, 'stat').mockImplementationOnce(async (target) => {
      const stat = await originalStat(target);
      allowed = false;
      return stat;
    });
    const response = await createLocalFileProtocolResponse(new Request(toLocalFileUrl(filePath)), { captureAccess: () => ({
      assertAllowed: () => {
        if (!allowed) throw new Error('Not found');
      },
    }) });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
  });

  test('account changes terminate an in-flight localfile stream', async () => {
    const filePath = createTempFile('preview.mp4', '');
    fs.writeFileSync(filePath, Buffer.alloc(16 * 1024 * 1024, 'a'));
    let epoch = 1;
    const response = await createLocalFileProtocolResponse(new Request(toLocalFileUrl(filePath)), { captureAccess: () => ({
      assertAllowed: () => {
        if (epoch !== 1) throw new Error('Not found');
      },
    }) });
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    epoch++;
    revalidateLocalFileProtocolStreams();
    await expect((async () => {
      while (!(await reader.read()).done) { /* Drain bytes already delivered before revocation. */ }
    })()).rejects.toThrow('Not found');
  });

  test('serves a thumbnail only when one is asked for and available', async () => {
    const filePath = createTempFile('generated.png', 'original-bytes');
    const thumbnailPath = path.join(tempDir!, 'thumbnail.jpg');
    fs.writeFileSync(thumbnailPath, 'thumb');
    const resolveThumbnail = vi.fn(async (_file: string, _stat: fs.Stats, edge: number, _fit: string) => (edge === 512 ? thumbnailPath : null));
    const request = (query: string) => createLocalFileProtocolResponse(new Request(`${toLocalFileUrl(filePath)}${query}`), { resolveThumbnail });

    const thumbnail = await request('?v=1&thumb=512');
    expect(thumbnail.headers.get('content-type')).toBe('image/jpeg');
    expect(await thumbnail.text()).toBe('thumb');
    expect(resolveThumbnail).toHaveBeenLastCalledWith(filePath, expect.anything(), 512, 'contain');
    await request('?v=1&thumb=512&thumbFit=cover');
    expect(resolveThumbnail).toHaveBeenLastCalledWith(filePath, expect.anything(), 512, 'cover');

    expect(await (await request('?v=1&thumb=2048')).text()).toBe('original-bytes');
    expect(await (await request('?v=1')).text()).toBe('original-bytes');
    expect(resolveThumbnail).toHaveBeenCalledTimes(3);

    resolveThumbnail.mockRejectedValueOnce(new Error('thumbnailer crashed'));
    const failed = await request('?v=1&thumb=512');
    expect(failed.headers.get('content-type')).toBe('image/png');
    expect(await failed.text()).toBe('original-bytes');
  });

  test.each(['GET', 'HEAD'])('denies a thumbnail before generation when the source grant is hidden: %s', async method => {
    const filePath = createTempFile('hidden.png', 'private');
    const resolveThumbnail = vi.fn();
    const response = await createLocalFileProtocolResponse(new Request(`${toLocalFileUrl(filePath)}?thumb=512`, { method }), {
      captureAccess: () => { throw new Error('Not found'); },
      resolveThumbnail,
    });
    expect(response.status).toBe(404);
    expect(resolveThumbnail).not.toHaveBeenCalled();
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  test.each([false, true])('revocation during thumbnail generation denies both success and fallback (failure: %s)', async fail => {
    const filePath = createTempFile('private.png', 'private-original');
    const thumbnailPath = path.join(tempDir!, 'thumb.jpg');
    fs.writeFileSync(thumbnailPath, 'private-thumbnail');
    let allowed = true;
    const response = await createLocalFileProtocolResponse(new Request(`${toLocalFileUrl(filePath)}?thumb=512`), {
      captureAccess: () => ({ assertAllowed: () => { if (!allowed) throw new Error('Not found'); } }),
      resolveThumbnail: async () => {
        allowed = false;
        if (fail) throw new Error('thumbnailer failed');
        return thumbnailPath;
      },
    });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
  });

  test('thumbnail streams retain the source file grant and stop after account revocation', async () => {
    const filePath = createTempFile('private.png', 'original');
    const thumbnailPath = path.join(tempDir!, 'thumb.jpg');
    fs.writeFileSync(thumbnailPath, Buffer.alloc(16 * 1024 * 1024, 'a'));
    let allowed = true;
    const assertAllowed = vi.fn((target: string | undefined) => {
      expect(target).toBe(filePath);
      if (!allowed) throw new Error('Not found');
    });
    const response = await createLocalFileProtocolResponse(new Request(`${toLocalFileUrl(filePath)}?thumb=512`), {
      captureAccess: () => ({ assertAllowed }),
      resolveThumbnail: async () => thumbnailPath,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    allowed = false;
    revalidateLocalFileProtocolStreams();
    await expect((async () => {
      while (!(await reader.read()).done) { /* Drain bytes queued before revocation. */ }
    })()).rejects.toThrow('Not found');
  });
});
