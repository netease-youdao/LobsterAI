import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  createLocalFileProtocolResponse,
  getLocalFileProtocolPath,
  parseByteRange,
} from './artifactLocalFileProtocol';

let tempDir: string | undefined;

afterEach(() => {
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
});
