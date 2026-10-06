import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  HtmlShareAccessMode,
  HtmlShareDisabledSource,
  HtmlShareErrorCode,
  HtmlShareFailureKind,
  HtmlShareSourceType,
  HtmlShareStatus,
} from '../../../shared/htmlShare/constants';
import {
  buildHtmlSharePublicUrl,
  createGeneratedVideoShare,
  deleteHtmlSharePermanently,
  getGeneratedVideoShareSource,
  getHtmlShareAnalytics,
  getHtmlShareBySource,
  getHtmlShareQuota,
  getPublishingTrialPolicy,
  resolveLegacyGeneratedVideoSource,
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
  test('creates a generated video share using only task provenance', async () => {
    let requestedUrl = '';
    let requestedBody = '';
    const result = await createGeneratedVideoShare(
      'https://lobsterai-server.inner.youdao.com',
      'https://lobsterai-server.inner.youdao.com/s',
      async (url, options) => {
        requestedUrl = url;
        requestedBody = String(options?.body || '');
        return new Response(JSON.stringify({
          code: 0,
          data: {
            state: 'ready',
            taskId: 123,
            outputIndex: 1,
            assetStatus: 'persisted',
            share: {
              shareId: 'shr_video',
              accessMode: HtmlShareAccessMode.Code,
              shareCode: 'V8D3O1',
              status: HtmlShareStatus.Live,
            },
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
      {
        taskId: '123',
        outputIndex: 1,
        sessionId: 'session-1',
        artifactId: 'artifact-video-1',
        title: 'Generated video',
        accessMode: HtmlShareAccessMode.Code,
      },
    );

    expect(requestedUrl).toBe(
      'https://lobsterai-server.inner.youdao.com/api/html-shares/generated-videos',
    );
    expect(JSON.parse(requestedBody)).toEqual({
      taskId: '123',
      outputIndex: 1,
      sessionId: 'session-1',
      artifactId: 'artifact-video-1',
      title: 'Generated video',
      accessMode: HtmlShareAccessMode.Code,
    });
    expect(result.success).toBe(true);
    expect(result.shareId).toBe('shr_video');
  });

  test('preserves the server video size limit for renderer messaging', async () => {
    const result = await createGeneratedVideoShare(
      'https://lobsterai-server.inner.youdao.com',
      'https://lobsterai-server.inner.youdao.com/s',
      async () => new Response(JSON.stringify({
        code: HtmlShareErrorCode.TooLarge,
        message: '分享视频超过文件大小限制',
        data: {
          limitBytes: 100 * 1024 * 1024,
          actualBytes: 101 * 1024 * 1024,
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      {
        taskId: '123',
        outputIndex: 0,
        sessionId: 'session-1',
        artifactId: 'artifact-video-1',
        title: 'Generated video',
      },
    );

    expect(result).toMatchObject({
      success: false,
      code: HtmlShareErrorCode.TooLarge,
      failureKind: HtmlShareFailureKind.FileTooLarge,
      details: {
        limitBytes: 100 * 1024 * 1024,
        actualBytes: 101 * 1024 * 1024,
      },
    });
  });

  test('looks up generated video share state by task and output', async () => {
    let requestedUrl = '';
    const result = await getGeneratedVideoShareSource(
      'https://lobsterai-server.inner.youdao.com',
      'https://lobsterai-server.inner.youdao.com/s',
      async url => {
        requestedUrl = url;
        return new Response(JSON.stringify({
          code: 0,
          data: {
            state: 'preparing',
            taskId: 123,
            outputIndex: 0,
            assetStatus: 'persisting',
            retryAfterMs: 1500,
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
      '123',
      0,
    );

    expect(requestedUrl).toBe(
      'https://lobsterai-server.inner.youdao.com/api/html-shares/generated-videos/source?taskId=123&outputIndex=0',
    );
    expect(result).toMatchObject({
      success: true,
      state: 'preparing',
      assetStatus: 'persisting',
      retryAfterMs: 1500,
    });
  });

  test('maps a background video download size failure to the shared file limit error', async () => {
    let requestCount = 0;
    const result = await createGeneratedVideoShare(
      'https://lobsterai-server.inner.youdao.com',
      'https://lobsterai-server.inner.youdao.com/s',
      async () => {
        requestCount += 1;
        if (requestCount === 1) {
          return new Response(JSON.stringify({
            code: 0,
            data: {
              state: 'preparing',
              taskId: 123,
              outputIndex: 0,
              assetStatus: 'persisting',
              retryAfterMs: 1,
            },
          }), { status: 202, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          code: 0,
          data: {
            state: 'checking',
            taskId: 123,
            outputIndex: 0,
            assetStatus: 'invalid',
            failureReason: 'too_large',
            limitBytes: 100 * 1024 * 1024,
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
      {
        taskId: '123',
        outputIndex: 0,
        sessionId: 'session-1',
        artifactId: 'artifact-video-1',
        title: 'Generated video',
      },
    );

    expect(requestCount).toBe(2);
    expect(result).toMatchObject({
      success: false,
      code: HtmlShareErrorCode.TooLarge,
      failureKind: HtmlShareFailureKind.FileTooLarge,
      details: { limitBytes: 100 * 1024 * 1024 },
    });
  });

  test('resolves legacy video provenance using a URL hash only', async () => {
    let requestedBody = '';
    const result = await resolveLegacyGeneratedVideoSource(
      'https://lobsterai-server.inner.youdao.com',
      async (_url, options) => {
        requestedBody = String(options?.body || '');
        return new Response(JSON.stringify({
          code: 0,
          data: { taskId: 456, outputIndex: 2 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
      'a'.repeat(64),
    );

    expect(JSON.parse(requestedBody)).toEqual({ resultUrlSha256: 'a'.repeat(64) });
    expect(result).toEqual({ success: true, taskId: '456', outputIndex: 2 });
  });

  test('permanently deletes a stopped shared file through the dedicated endpoint', async () => {
    let requestedUrl = '';
    let requestedMethod = '';
    const result = await deleteHtmlSharePermanently(
      'https://lobsterai-server.inner.youdao.com',
      async (url, options) => {
        requestedUrl = url;
        requestedMethod = options?.method || '';
        return new Response(JSON.stringify({ code: 0, data: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      'shr_file/with space',
    );

    expect(requestedUrl).toBe(
      'https://lobsterai-server.inner.youdao.com/api/html-shares/shr_file%2Fwith%20space/permanent',
    );
    expect(requestedMethod).toBe('DELETE');
    expect(result).toEqual({ success: true, httpStatus: 200 });
  });

  test('preserves server deletion errors for renderer recovery', async () => {
    const result = await deleteHtmlSharePermanently(
      'https://lobsterai-server.inner.youdao.com',
      async () => new Response(JSON.stringify({
        code: 41315,
        message: '请先停止分享，再永久删除',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      'shr_live',
    );

    expect(result).toEqual({
      success: false,
      error: '请先停止分享，再永久删除',
      code: 41315,
      httpStatus: 200,
    });
  });

  test('builds environment-specific public share URLs', () => {
    expect(buildHtmlSharePublicUrl('https://lobsterai-server.inner.youdao.com/s', 'shr_123')).toBe(
      'https://lobsterai-server.inner.youdao.com/s/shr_123/',
    );
    expect(buildHtmlSharePublicUrl('https://lobsterai-server.youdao.com/s/', 'shr_123')).toBe(
      'https://lobsterai-server.youdao.com/s/shr_123/',
    );
  });

  test('uses the server quota snapshot without client-side limit defaults', async () => {
    const result = await getHtmlShareQuota(
      'https://lobsterai-server.inner.youdao.com',
      async () => new Response(JSON.stringify({
        code: 0,
        data: {
          allowed: false,
          identityType: 'free',
          resourceKind: 'file',
          countMode: 'total',
          used: 3,
          limit: 3,
          remaining: 0,
          canReleaseByClosing: false,
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    expect(result).toEqual({
      success: true,
      data: {
        allowed: false,
        identityType: 'free',
        resourceKind: 'file',
        countMode: 'total',
        used: 3,
        limit: 3,
        remaining: 0,
        canReleaseByClosing: false,
      },
    });
  });

  test('loads free publishing limits and validity from the public server policy', async () => {
    let requestedUrl = '';
    let requestedOptions: RequestInit | undefined;
    const result = await getPublishingTrialPolicy(
      'https://lobsterai-server.inner.youdao.com',
      async (url, options) => {
        requestedUrl = url;
        requestedOptions = options;
        return new Response(JSON.stringify({
          code: 0,
          data: {
            identityType: 'free',
            file: {
              resourceKind: 'file',
              countMode: 'total',
              limit: 12,
              accessTtlSeconds: 10_800,
              canReleaseByClosing: false,
            },
            site: {
              resourceKind: 'site',
              countMode: 'total',
              limit: 2,
              accessTtlSeconds: 10_800,
              canReleaseByClosing: false,
            },
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    );

    expect(requestedUrl).toBe(
      'https://lobsterai-server.inner.youdao.com/api/publishing/trial-policy',
    );
    expect(requestedOptions).toEqual({ cache: 'no-store' });
    expect(result).toEqual({
      success: true,
      data: {
        identityType: 'free',
        file: {
          resourceKind: 'file',
          countMode: 'total',
          limit: 12,
          accessTtlSeconds: 10_800,
          canReleaseByClosing: false,
        },
        site: {
          resourceKind: 'site',
          countMode: 'total',
          limit: 2,
          accessTtlSeconds: 10_800,
          canReleaseByClosing: false,
        },
      },
    });
  });

  test('loads owner analytics for the requested date range', async () => {
    let requestedUrl = '';
    const result = await getHtmlShareAnalytics(
      'https://lobsterai-server.inner.youdao.com',
      async url => {
        requestedUrl = url;
        return new Response(JSON.stringify({
          code: 0,
          data: {
            summary: { accesses: 8, uniqueVisitors: 3 },
            trend: [{ date: '2026-08-19', accesses: 8, uniqueVisitors: 3 }],
            meta: {
              from: '2026-08-13',
              to: '2026-08-19',
              granularity: 'day',
              timeZone: 'Asia/Shanghai',
              dataScope: 'share_lifetime',
              visitorMetric: 'ip_hash_estimate',
              retentionDays: 180,
              dataAvailableFrom: '2026-08-01',
            },
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
      'shr_123',
      { from: '2026-08-13', to: '2026-08-19' },
    );

    expect(requestedUrl).toBe(
      'https://lobsterai-server.inner.youdao.com/api/html-shares/shr_123/analytics?from=2026-08-13&to=2026-08-19',
    );
    expect(result.success).toBe(true);
    expect(result.analytics?.summary.accesses).toBe(8);
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

  test('preserves missing and explicit null access expiry from share lookup responses', async () => {
    const lookup = (data: Record<string, unknown>) => getHtmlShareBySource(
      'https://lobsterai-server.inner.youdao.com',
      'https://lobsterai-server.inner.youdao.com/s',
      async () => new Response(
        JSON.stringify({ code: 0, data }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
      HtmlShareSourceType.HtmlFile,
      'source-key',
    );

    const missingResult = await lookup({
      shareId: 'shr_missing_expiry',
      status: HtmlShareStatus.Disabled,
    });
    const nullResult = await lookup({
      shareId: 'shr_null_expiry',
      status: HtmlShareStatus.Live,
      accessExpiresAt: null,
    });

    expect(Object.prototype.hasOwnProperty.call(missingResult.share, 'accessExpiresAt')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(nullResult.share, 'accessExpiresAt')).toBe(true);
    expect(nullResult.share?.accessExpiresAt).toBeNull();
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
