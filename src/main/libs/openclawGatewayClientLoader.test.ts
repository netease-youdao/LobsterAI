import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  clearGatewayClientCtorCacheForTests,
  loadGatewayClientCtor,
  resolveGatewayClientChunk,
} from './openclawGatewayClientLoader';

class FakeGatewayClient {
  start(): void {}
  stop(): void {}
  request(): void {}
}

const BARREL_SOURCE = [
  'import { r as isGatewayTransportError } from "../transport-error-D_LRKgla.js";',
  'import { f as isGatewayClientRequestError } from "../call-DPN6iu8q.js";',
  'import { t as GatewayClient } from "../client-BRtMXpmK.js";',
  'export { GatewayClient, isGatewayClientRequestError, isGatewayTransportError };',
].join('\n');

let distDir: string;
let barrelPath: string;
let chunkPath: string;

beforeEach(() => {
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-client-loader-'));
  fs.mkdirSync(path.join(distDir, 'plugin-sdk'));
  barrelPath = path.join(distDir, 'plugin-sdk', 'gateway-runtime.js');
  chunkPath = path.join(distDir, 'client-BRtMXpmK.js');
  fs.writeFileSync(barrelPath, BARREL_SOURCE);
  fs.writeFileSync(chunkPath, '');
  clearGatewayClientCtorCacheForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(distDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('resolveGatewayClientChunk', () => {
  test('finds the chunk and minified export the barrel imports GatewayClient from', () => {
    expect(resolveGatewayClientChunk(barrelPath, BARREL_SOURCE)).toEqual({
      modulePath: chunkPath,
      exportName: 't',
    });
  });

  test('accepts an unaliased import among other specifiers', () => {
    const source = 'import { a as x, GatewayClient, b } from "./client.js";';
    expect(resolveGatewayClientChunk(barrelPath, source)).toEqual({
      modulePath: path.join(distDir, 'plugin-sdk', 'client.js'),
      exportName: 'GatewayClient',
    });
  });

  test('ignores similarly named exports and bare-package imports', () => {
    const source = [
      'import { t as GatewayClientOptions } from "../options.js";',
      'import { GatewayClient } from "openclaw";',
    ].join('\n');
    expect(resolveGatewayClientChunk(barrelPath, source)).toBeNull();
  });
});

describe('loadGatewayClientCtor', () => {
  test('loads only the GatewayClient chunk when it exports the client class', async () => {
    const load = vi.fn((modulePath: string) => (modulePath === chunkPath ? { t: FakeGatewayClient } : {}));
    await expect(loadGatewayClientCtor(barrelPath, load)).resolves.toBe(FakeGatewayClient);
    expect(load.mock.calls).toEqual([[chunkPath]]);
  });

  test('falls back to the barrel when the chunk export is not the client class', async () => {
    const load = vi.fn((modulePath: string) => (
      modulePath === chunkPath ? { t: () => undefined } : { GatewayClient: FakeGatewayClient }
    ));
    await expect(loadGatewayClientCtor(barrelPath, load)).resolves.toBe(FakeGatewayClient);
    expect(load.mock.calls).toEqual([[chunkPath], [barrelPath]]);
  });

  test('falls back to the barrel when the chunk fails to load or is missing', async () => {
    const throwing = vi.fn((modulePath: string) => {
      if (modulePath === chunkPath) throw new Error('chunk evaluation failed');
      return { GatewayClient: FakeGatewayClient };
    });
    await expect(loadGatewayClientCtor(barrelPath, throwing)).resolves.toBe(FakeGatewayClient);

    clearGatewayClientCtorCacheForTests();
    fs.rmSync(chunkPath);
    const load = vi.fn(() => ({ GatewayClient: FakeGatewayClient }));
    await expect(loadGatewayClientCtor(barrelPath, load)).resolves.toBe(FakeGatewayClient);
    expect(load.mock.calls).toEqual([[barrelPath]]);
  });

  test('still finds a duck-typed client in the barrel exports', async () => {
    fs.writeFileSync(barrelPath, 'export { n, r, t } from "../shared.js";');
    const load = vi.fn(() => ({ n: 1, r: () => undefined, t: FakeGatewayClient }));
    await expect(loadGatewayClientCtor(barrelPath, load)).resolves.toBe(FakeGatewayClient);
  });

  test('loads once per entry and retries after a failed load', async () => {
    const load = vi.fn((modulePath: string) => (modulePath === chunkPath ? { t: FakeGatewayClient } : {}));
    await Promise.all([loadGatewayClientCtor(barrelPath, load), loadGatewayClientCtor(barrelPath, load)]);
    expect(load).toHaveBeenCalledOnce();

    const otherEntry = path.join(distDir, 'gateway', 'client.js');
    const failing = vi.fn(() => ({ unrelated: 1 }));
    await expect(loadGatewayClientCtor(otherEntry, failing)).rejects.toThrow('Invalid OpenClaw gateway client module');
    const recovered = vi.fn(() => ({ GatewayClient: FakeGatewayClient }));
    await expect(loadGatewayClientCtor(otherEntry, recovered)).resolves.toBe(FakeGatewayClient);
  });
});

const runtimeBarrel = path.resolve('vendor', 'openclaw-runtime', 'current', 'dist', 'plugin-sdk', 'gateway-runtime.js');

describe.skipIf(!fs.existsSync(runtimeBarrel))('built OpenClaw runtime', () => {
  test('the plugin-sdk barrel still imports GatewayClient from a resolvable chunk', () => {
    const chunk = resolveGatewayClientChunk(runtimeBarrel, fs.readFileSync(runtimeBarrel, 'utf8'));
    expect(chunk).not.toBeNull();
    const chunkSource = fs.readFileSync(chunk!.modulePath, 'utf8');
    expect(chunkSource).toMatch(new RegExp(`\\bGatewayClient as ${chunk!.exportName}\\b`));
  });
});
