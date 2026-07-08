import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  HtmlShareAccessMode,
  HtmlShareDisabledSource,
  HtmlShareSourceType,
  HtmlShareStatus,
} from '../../../shared/htmlShare/constants';
import {
  buildHtmlSharePublicUrl,
  getHtmlShareBySource,
  updateHtmlShare,
  updateHtmlShareAccessMode,
  updateHtmlShareStatus,
  uploadHtmlShare,
} from './htmlShareClient';

const tempRoots: string[] = [];

const createArchiveFile = async (): Promise<string> => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lobster-html-share-client-test-'));
  tempRoots.push(root);
  const archivePath = path.join(root, 'share.zip');
  await fs.promises.writeFile(archivePath, 'zip-content');
  return archivePath;
};

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(root => fs.promises.rm(root, { recursive: true, force: true })),
  );
});

describe('htmlShareClient', () => {
  test('builds environment-specific public share URLs', () => {
    expect(buildHtmlSharePublicUrl('https://lobsterai-server.inner.youdao.com/s', 'shr_123')).toBe(
      'https://lobsterai-server.inner.youdao.com/s/shr_123/',
    );
    expect(buildHtmlSharePublicUrl('https://lobsterai-server.youdao.com/s/', 'shr_123')).toBe(
      'https://lobsterai-server.youdao.com/s/shr_123/',
    );
  });

  test('uploads to the selected server and returns the server share URL', async () => {
    const archivePath = await createArchiveFile();
    let requestedUrl = '';
    let requestedForm: FormData | null = null;

    const result = await uploadHtmlShare(
      'https://lobsterai-server.inner.youdao.com',
      'https://lobsterai-server.inner.youdao.com/s',
      async (url, options) => {
        requestedUrl = url;
        if (options?.body instanceof FormData) requestedForm = options.body;
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              shareId: 'shr_test',
              url: 'https://lobsterai-server.youdao.com/s/shr_test/',
              accessMode: HtmlShareAccessMode.Code,
              shareCode: 'K7Q9P2',
              status: HtmlShareStatus.Live,
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      },
      {
        archivePath,
        sourceType: HtmlShareSourceType.HtmlFile,
        clientSourceKey: 'source-key',
        sessionId: 'session-1',
        artifactId: 'artifact-1',
        title: 'Preview',
        entryFile: 'index.html',
        accessMode: HtmlShareAccessMode.Public,
        sourceSha256: 'hash',
      },
    );

    expect(requestedUrl).toBe('https://lobsterai-server.inner.youdao.com/api/html-shares');
    expect(requestedForm).not.toBeNull();
    expect(requestedForm!.get('sourceType')).toBe(HtmlShareSourceType.HtmlFile);
    expect(requestedForm!.get('accessMode')).toBe(HtmlShareAccessMode.Public);
    expect(result.success).toBe(true);
    expect(result.url).toBe('https://lobsterai-server.youdao.com/s/shr_test/');
    expect(result.shareCode).toBe('K7Q9P2');
  });

  test('falls back to the selected public base URL when the server omits the share URL', async () => {
    const archivePath = await createArchiveFile();

    const result = await uploadHtmlShare(
      'https://lobsterai-server.inner.youdao.com',
      'https://lobsterai-server.inner.youdao.com/s',
      async () =>
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              shareId: 'shr_test',
              accessMode: HtmlShareAccessMode.Code,
              status: HtmlShareStatus.Live,
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      {
        archivePath,
        sourceType: HtmlShareSourceType.HtmlFile,
        clientSourceKey: 'source-key',
        title: 'Preview',
        entryFile: 'index.html',
        accessMode: HtmlShareAccessMode.Code,
        sourceSha256: 'hash',
      },
    );

    expect(result.success).toBe(true);
    expect(result.url).toBe('https://lobsterai-server.inner.youdao.com/s/shr_test/');
  });

  test('updates an existing share with PUT and keeps the server share URL', async () => {
    const archivePath = await createArchiveFile();
    let requestedUrl = '';
    let requestedMethod = '';
    let requestedForm: FormData | null = null;

    const result = await updateHtmlShare(
      'https://lobsterai-server.inner.youdao.com',
      'https://lobsterai-server.inner.youdao.com/s',
      async (url, options) => {
        requestedUrl = url;
        requestedMethod = options?.method || '';
        if (options?.body instanceof FormData) requestedForm = options.body;
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              shareId: 'shr_test',
              url: 'https://lobsterai-server.youdao.com/s/shr_test/',
              accessMode: HtmlShareAccessMode.Code,
              status: HtmlShareStatus.Live,
              restoredByUpdate: true,
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      },
      'shr_test',
      {
        archivePath,
        sourceType: HtmlShareSourceType.HtmlFile,
        clientSourceKey: 'source-key',
        title: 'Preview',
        entryFile: 'index.html',
        accessMode: HtmlShareAccessMode.Code,
        sourceSha256: 'hash',
      },
    );

    expect(requestedUrl).toBe('https://lobsterai-server.inner.youdao.com/api/html-shares/shr_test');
    expect(requestedMethod).toBe('PUT');
    expect(requestedForm).not.toBeNull();
    expect(requestedForm!.get('sourceType')).toBe(HtmlShareSourceType.HtmlFile);
    expect(requestedForm!.get('accessMode')).toBe(HtmlShareAccessMode.Code);
    expect(result.success).toBe(true);
    expect(result.url).toBe('https://lobsterai-server.youdao.com/s/shr_test/');
    expect(result.restoredByUpdate).toBe(true);
  });

  test('updates an artifact image share with source type and access mode', async () => {
    const archivePath = await createArchiveFile();
    let requestedForm: FormData | null = null;

    const result = await updateHtmlShare(
      'https://lobsterai-server.inner.youdao.com',
      'https://lobsterai-server.inner.youdao.com/s',
      async (_url, options) => {
        if (options?.body instanceof FormData) requestedForm = options.body;
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              shareId: 'shr_image',
              url: 'https://lobsterai-server.youdao.com/s/shr_image/',
              accessMode: HtmlShareAccessMode.Public,
              status: HtmlShareStatus.Live,
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      },
      'shr_image',
      {
        archivePath,
        sourceType: HtmlShareSourceType.ImageFile,
        clientSourceKey: 'image-source-key',
        sessionId: 'session-1',
        artifactId: 'artifact-image-1',
        title: 'Image',
        entryFile: 'image.png',
        accessMode: HtmlShareAccessMode.Public,
        sourceSha256: 'hash',
      },
    );

    expect(requestedForm).not.toBeNull();
    expect(requestedForm!.get('sourceType')).toBe(HtmlShareSourceType.ImageFile);
    expect(requestedForm!.get('accessMode')).toBe(HtmlShareAccessMode.Public);
    expect(requestedForm!.get('entryFile')).toBe('image.png');
    expect(result.success).toBe(true);
    expect(result.accessMode).toBe(HtmlShareAccessMode.Public);
  });

  test('updates share access mode without uploading files', async () => {
    let requestedUrl = '';
    let requestedMethod = '';
    let requestedBody = '';
    let requestedContentType = '';

    const result = await updateHtmlShareAccessMode(
      'https://lobsterai-server.inner.youdao.com',
      'https://lobsterai-server.inner.youdao.com/s',
      async (url, options) => {
        requestedUrl = url;
        requestedMethod = options?.method || '';
        requestedBody = String(options?.body || '');
        requestedContentType = String(
          (options?.headers as Record<string, string>)?.['Content-Type'] || '',
        );
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              shareId: 'shr_test',
              accessMode: HtmlShareAccessMode.Public,
              status: HtmlShareStatus.Live,
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      },
      'shr_test',
      HtmlShareAccessMode.Public,
    );

    expect(requestedUrl).toBe(
      'https://lobsterai-server.inner.youdao.com/api/html-shares/shr_test/access-mode',
    );
    expect(requestedMethod).toBe('PUT');
    expect(requestedContentType).toBe('application/json');
    expect(requestedBody).toBe(JSON.stringify({ accessMode: HtmlShareAccessMode.Public }));
    expect(result.success).toBe(true);
    expect(result.accessMode).toBe(HtmlShareAccessMode.Public);
  });

  test('updates an existing share status with PATCH', async () => {
    let requestedUrl = '';
    let requestedMethod = '';
    let requestedBody = '';
    let requestedContentType = '';

    const result = await updateHtmlShareStatus(
      'https://lobsterai-server.inner.youdao.com',
      'https://lobsterai-server.inner.youdao.com/s',
      async (url, options) => {
        requestedUrl = url;
        requestedMethod = options?.method || '';
        requestedBody = String(options?.body || '');
        requestedContentType = String(
          (options?.headers as Record<string, string>)?.['Content-Type'] || '',
        );
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              shareId: 'shr_test',
              url: 'https://lobsterai-server.youdao.com/s/shr_test/',
              status: HtmlShareStatus.Disabled,
              disabledAt: '2026-06-01T12:00:00',
              disabledReason: 'user',
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      },
      'shr_test',
      HtmlShareStatus.Disabled,
    );

    expect(requestedUrl).toBe(
      'https://lobsterai-server.inner.youdao.com/api/html-shares/shr_test/status',
    );
    expect(requestedMethod).toBe('PATCH');
    expect(requestedContentType).toBe('application/json');
    expect(requestedBody).toBe(JSON.stringify({ status: HtmlShareStatus.Disabled }));
    expect(result.success).toBe(true);
    expect(result.status).toBe(HtmlShareStatus.Disabled);
    expect(result.disabledAt).toBe('2026-06-01T12:00:00');
  });

  test('loads an existing share by source key', async () => {
    let requestedUrl = '';

    const result = await getHtmlShareBySource(
      'https://lobsterai-server.inner.youdao.com',
      'https://lobsterai-server.inner.youdao.com/s',
      async url => {
        requestedUrl = url;
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              shareId: 'shr_test',
              accessMode: HtmlShareAccessMode.Code,
              shareCode: 'K7Q9P2',
              status: HtmlShareStatus.Disabled,
              disabledReason: 'active share limit exceeded',
              disabledSource: HtmlShareDisabledSource.ActiveLimit,
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      },
      HtmlShareSourceType.HtmlFile,
      'source-key',
    );

    expect(requestedUrl).toBe(
      'https://lobsterai-server.inner.youdao.com/api/html-shares/source?sourceType=html_file&clientSourceKey=source-key&includeDisabled=true',
    );
    expect(result.success).toBe(true);
    expect(result.share?.url).toBe('https://lobsterai-server.inner.youdao.com/s/shr_test/');
    expect(result.share?.shareCode).toBe('K7Q9P2');
    expect(result.share?.status).toBe(HtmlShareStatus.Disabled);
    expect(result.share?.disabledSource).toBe(HtmlShareDisabledSource.ActiveLimit);
  });

  test('falls back to my shares when source lookup omits a disabled share', async () => {
    const requestedUrls: string[] = [];

    const result = await getHtmlShareBySource(
      'https://lobsterai-server.inner.youdao.com',
      'https://lobsterai-server.inner.youdao.com/s',
      async url => {
        requestedUrls.push(url);
        if (url.includes('/api/html-shares/source?')) {
          return new Response(
            JSON.stringify({
              code: 0,
              data: null,
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          );
        }
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              items: [
                {
                  shareId: 'shr_disabled',
                  sourceType: HtmlShareSourceType.HtmlFile,
                  clientSourceKey: 'source-key',
                  status: HtmlShareStatus.Disabled,
                  shareCodeUnavailable: true,
                },
              ],
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      },
      HtmlShareSourceType.HtmlFile,
      'source-key',
    );

    expect(requestedUrls).toEqual([
      'https://lobsterai-server.inner.youdao.com/api/html-shares/source?sourceType=html_file&clientSourceKey=source-key&includeDisabled=true',
      'https://lobsterai-server.inner.youdao.com/api/html-shares/my',
    ]);
    expect(result.success).toBe(true);
    expect(result.share?.shareId).toBe('shr_disabled');
    expect(result.share?.url).toBe('https://lobsterai-server.inner.youdao.com/s/shr_disabled/');
    expect(result.share?.status).toBe(HtmlShareStatus.Disabled);
  });
});
