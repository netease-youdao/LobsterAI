import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterEach, expect, test } from 'vitest';

import { createPreviewSession, destroyPreviewSession, stopHtmlPreviewServer } from './htmlPreviewServer';

let work: string | null = null;

afterEach(async () => {
  await stopHtmlPreviewServer();
  if (work) {
    fs.rmSync(work, { recursive: true, force: true });
    work = null;
  }
});

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }).on('error', reject);
  });
}

// Node's URL class (used internally by http.get(urlString)) normalizes ".."
// path segments before the request is even sent, which would collapse
// sessionId/../foo into just /foo and hit the "unknown session" branch
// instead of exercising the server's own traversal check. Sending the raw
// path directly bypasses that client-side normalization.
function getRawPath(port: number, rawPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: rawPath }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }).on('error', reject);
  });
}

test('a symlink inside the preview directory cannot be used to read a file outside it', async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-preview-poc-'));
  const previewDir = path.join(work, 'preview');
  fs.mkdirSync(previewDir, { recursive: true });
  const indexPath = path.join(previewDir, 'index.html');
  fs.writeFileSync(indexPath, '<html>preview</html>');

  const sentinelDir = path.join(work, 'outside-preview-root');
  fs.mkdirSync(sentinelDir, { recursive: true });
  fs.writeFileSync(path.join(sentinelDir, 'secret.txt'), 'POC_SECRET');
  fs.symlinkSync(path.join(sentinelDir, 'secret.txt'), path.join(previewDir, 'leak.txt'));

  const { url, sessionId } = await createPreviewSession(indexPath);
  const base = url.slice(0, url.lastIndexOf('/'));
  const token = new URL(url).searchParams.get('token');

  const leaked = await get(`${base}/leak.txt?token=${token}`);
  expect(leaked.status).toBe(403);
  expect(leaked.body).not.toContain('POC_SECRET');

  // The legitimate file the session was created for must still be servable.
  const legit = await get(url);
  expect(legit.status).toBe(200);
  expect(legit.body).toContain('preview');

  destroyPreviewSession(sessionId);
});

test('ordinary textual traversal outside the preview root is still rejected', async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-preview-poc-'));
  const previewDir = path.join(work, 'preview');
  fs.mkdirSync(previewDir, { recursive: true });
  const indexPath = path.join(previewDir, 'index.html');
  fs.writeFileSync(indexPath, '<html>preview</html>');

  const sentinelDir = path.join(work, 'outside-preview-root');
  fs.mkdirSync(sentinelDir, { recursive: true });
  fs.writeFileSync(path.join(sentinelDir, 'secret.txt'), 'POC_SECRET');

  const { url, sessionId } = await createPreviewSession(indexPath);
  const parsed = new URL(url);
  const token = parsed.searchParams.get('token');
  const sessionPath = parsed.pathname.split('/').slice(0, 2).join('/'); // /<sessionId>

  // The server parses req.url through the WHATWG URL class (handleRequest's
  // `new URL(req.url, base)`), which normalizes ".." segments before the
  // explicit rootDir containment check ever runs. That collapses
  // "<sessionId>/.." down to nothing, so this lands on "session not found"
  // (404) rather than the containment check's own 403 - either way, nothing
  // outside the preview root is ever served.
  const traversed = await getRawPath(
    Number(parsed.port),
    `${sessionPath}/../outside-preview-root/secret.txt?token=${token}`,
  );
  expect(traversed.status).toBe(404);
  expect(traversed.body).not.toContain('POC_SECRET');

  destroyPreviewSession(sessionId);
});
