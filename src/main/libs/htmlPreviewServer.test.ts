import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  createOfficePreviewSession,
  createPreviewSession,
  destroyPreviewSession,
  revalidatePreviewSessions,
  stopHtmlPreviewServer,
} from './htmlPreviewServer';

let tempDir: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await stopHtmlPreviewServer();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function fixture(extension = 'html'): string {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-scoped-preview-')));
  const filePath = path.join(tempDir, `preview.${extension}`);
  fs.writeFileSync(filePath, 'preview content');
  return filePath;
}

function resourceUrl(url: string, resource: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${parsed.pathname.split('/')[1]}/${resource}`;
  return parsed.href;
}

describe('scoped artifact preview server', () => {
  test('serves ordinary previews and relative resources with no-store', async () => {
    const filePath = fixture();
    fs.writeFileSync(path.join(tempDir!, 'style.css'), 'body {}');
    const { url } = await createPreviewSession(filePath);
    const entry = await fetch(url);
    expect(entry.status).toBe(200);
    expect(entry.headers.get('cache-control')).toContain('no-store');
    expect(await entry.text()).toBe('preview content');
    const asset = await fetch(resourceUrl(url, 'style.css'));
    expect(await asset.text()).toBe('body {}');
  });

  test('checks both indexed entry and requested resource and permanently revokes denied sessions', async () => {
    const filePath = fixture();
    const allowedAsset = path.join(tempDir!, 'allowed.css');
    const hiddenAsset = path.join(tempDir!, 'hidden.css');
    fs.writeFileSync(allowedAsset, 'allowed');
    fs.writeFileSync(hiddenAsset, 'secret');
    const assertAccess = vi.fn((target: string) => {
      if (target === hiddenAsset) throw new Error('Not found');
    });
    const { url } = await createPreviewSession(filePath, assertAccess);
    const allowed = await fetch(resourceUrl(url, 'allowed.css'));
    expect(await allowed.text()).toBe('allowed');
    expect(assertAccess).toHaveBeenCalledWith(filePath);
    expect(assertAccess).toHaveBeenCalledWith(allowedAsset);
    const denied = await fetch(resourceUrl(url, 'hidden.css'));
    expect(denied.status).toBe(404);
    expect(denied.headers.get('cache-control')).toContain('no-store');
    expect(await denied.text()).toBe('Not Found');
    expect((await fetch(url)).status).toBe(404);
  });

  test('rejects symlink traversal outside the preview directory', async () => {
    const filePath = fixture();
    const outside = path.join(tempDir!, 'outside');
    const inside = path.join(tempDir!, 'inside');
    fs.mkdirSync(outside);
    fs.mkdirSync(inside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    const entry = path.join(inside, path.basename(filePath));
    fs.copyFileSync(filePath, entry);
    fs.symlinkSync(outside, path.join(inside, 'escape'));
    const { url } = await createPreviewSession(entry);
    const response = await fetch(resourceUrl(url, 'escape/secret.txt'));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not Found');
  });

  test.each([createPreviewSession, createOfficePreviewSession])('previews a symlink entry from its canonical directory', async (createSession) => {
    const entry = fixture('pptx');
    const aliasDir = path.join(tempDir!, 'aliases');
    fs.mkdirSync(aliasDir);
    const alias = path.join(aliasDir, 'linked.pptx');
    fs.symlinkSync(entry, alias);
    fs.writeFileSync(path.join(tempDir!, 'style.css'), 'canonical asset');
    const assertAccess = vi.fn();
    const { url } = await createSession(alias, assertAccess);
    const sourceUrl = createSession === createOfficePreviewSession
      ? resourceUrl(url, '__office_preview__/source.pptx') : url;
    const response = await fetch(sourceUrl);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('preview content');
    expect(assertAccess).toHaveBeenCalledWith(alias);
    expect(assertAccess).toHaveBeenCalledWith(entry);
    const asset = await fetch(resourceUrl(url, 'style.css'));
    expect(await asset.text()).toBe('canonical asset');
  });

  test.each([createPreviewSession, createOfficePreviewSession])('rejects creation when access changes while stat is pending', async (createSession) => {
    const filePath = fixture();
    const originalStat = fs.promises.stat.bind(fs.promises);
    let allowed = true;
    vi.spyOn(fs.promises, 'stat').mockImplementationOnce(async (target) => {
      const stat = await originalStat(target);
      allowed = false;
      return stat;
    });
    await expect(createSession(filePath, () => {
      if (!allowed) throw new Error('Not found');
    })).rejects.toThrow('Not found');
  });

  test('an old token stays invalid after an account A to B to A transition', async () => {
    const filePath = fixture();
    let account = 'A';
    let epoch = 1;
    const { url } = await createPreviewSession(filePath, () => {
      if (account !== 'A' || epoch !== 1) throw new Error('Not found');
    });
    account = 'B';
    epoch++;
    revalidatePreviewSessions();
    account = 'A';
    epoch++;
    const response = await fetch(url);
    expect(response.status).toBe(404);
  });

  test('rechecks access after request stat completes before streaming any bytes', async () => {
    const filePath = fixture();
    let allowed = true;
    const { url } = await createPreviewSession(filePath, () => {
      if (!allowed) throw new Error('Not found');
    });
    const originalStat = fs.stat.bind(fs);
    let releaseStat: (() => void) | undefined;
    let notifyStat: (() => void) | undefined;
    const statStarted = new Promise<void>(resolve => { notifyStat = resolve; });
    vi.spyOn(fs, 'stat').mockImplementationOnce((target, callback) => {
      releaseStat = () => originalStat(target, callback);
      notifyStat!();
    });
    syncBuiltinESMExports();
    const pendingResponse = fetch(url);
    await statStarted;
    allowed = false;
    releaseStat!();
    const response = await pendingResponse;
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not Found');
  });

  test('office page, source and bundled runtime all require the entry grant', async () => {
    const filePath = fixture('pptx');
    let allowed = true;
    const assertAccess = vi.fn((target: string) => {
      expect(target).toBe(filePath);
      if (!allowed) throw new Error('Not found');
    });
    const { url } = await createOfficePreviewSession(filePath, assertAccess);
    expect((await fetch(url)).status).toBe(200);
    const source = await fetch(resourceUrl(url, '__office_preview__/source.pptx'));
    expect(await source.text()).toBe('preview content');
    const vendor = await fetch(resourceUrl(url, '__office_preview__/pptx-preview.umd.js'));
    expect(vendor.status).toBe(200);
    await vendor.arrayBuffer();
    allowed = false;
    for (const resource of ['index.html', 'source.pptx', 'pptx-preview.umd.js']) {
      expect((await fetch(resourceUrl(url, `__office_preview__/${resource}`))).status).toBe(404);
    }
  });

  test('revoking access terminates an already active response', async () => {
    const filePath = fixture();
    fs.writeFileSync(filePath, Buffer.alloc(16 * 1024 * 1024, 'a'));
    let allowed = true;
    const { url } = await createPreviewSession(filePath, () => {
      if (!allowed) throw new Error('Not found');
    });
    const response = await fetch(url);
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    allowed = false;
    revalidatePreviewSessions();
    await expect((async () => {
      while (!(await reader.read()).done) { /* Drain buffered bytes until the aborted stream reports its error. */ }
    })()).rejects.toThrow();
    expect((await fetch(url)).status).toBe(404);
  });

  test('destroying a preview session invalidates its token', async () => {
    const { sessionId, url } = await createPreviewSession(fixture());
    destroyPreviewSession(sessionId);
    expect((await fetch(url)).status).toBe(404);
  });
});
