import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { InAppBrowserBridge } from '../SKILLs/web-search/server/inApp/bridge';

const SECRET = 'bridge-test-secret';

describe('web-search in-app browser bridge', () => {
  let tmpDir: string;
  let bridgeFile: string;
  let server: http.Server;
  let received: Array<{ secret: unknown; body: Record<string, unknown> }>;
  let respond: (body: Record<string, unknown>) => Record<string, unknown>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-search-bridge-'));
    bridgeFile = path.join(tmpDir, 'web-search-bridge.json');
    received = [];
    respond = () => ({ success: true, data: { active: true } });
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        received.push({ secret: req.headers['x-mcp-bridge-secret'], body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(respond(body)));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const writeBridgeFile = (bridgeUrl: string) => {
    fs.writeFileSync(bridgeFile, JSON.stringify({ version: 1, bridgeUrl, bridgeSecret: SECRET }));
  };
  const serverUrl = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/web-search/page`;

  test('is inactive without an endpoint file', async () => {
    await expect(new InAppBrowserBridge(undefined).isActive()).resolves.toBe(false);
    await expect(new InAppBrowserBridge(bridgeFile).isActive()).resolves.toBe(false);
  });

  test('is inactive when the app is gone or reports the mode as off', async () => {
    writeBridgeFile('http://127.0.0.1:1/web-search/page');
    await expect(new InAppBrowserBridge(bridgeFile).isActive()).resolves.toBe(false);

    writeBridgeFile(serverUrl());
    respond = () => ({ success: false, code: 'in-app-disabled', error: 'off' });
    await expect(new InAppBrowserBridge(bridgeFile).isActive()).resolves.toBe(false);
  });

  test('never sends the secret to a non-loopback endpoint', async () => {
    writeBridgeFile('http://example.com/web-search/page');
    await expect(new InAppBrowserBridge(bridgeFile).isActive()).resolves.toBe(false);
  });

  test('authenticates and forwards operations, re-reading the endpoint each time', async () => {
    const bridge = new InAppBrowserBridge(bridgeFile);
    await expect(bridge.isActive()).resolves.toBe(false);

    writeBridgeFile(serverUrl());
    await expect(bridge.isActive()).resolves.toBe(true);

    respond = body => ({ success: true, data: { query: body.query, results: [] } });
    await expect(bridge.request('search', { engine: 'bing', query: '龙虾' }))
      .resolves.toEqual({ query: '龙虾', results: [] });
    expect(received.at(-1)).toEqual({
      secret: SECRET,
      body: { op: 'search', engine: 'bing', query: '龙虾' },
    });

    respond = () => ({ success: false, error: 'Google returned no parsable results' });
    await expect(bridge.request('search', { engine: 'google', query: 'x' }))
      .rejects.toThrow('Google returned no parsable results');
  });
});
