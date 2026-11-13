import { getEventListeners } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, test, vi } from 'vitest';

const {
  LONG_POLL_ABORT_MARKER,
  patchWeixinLongPollAbortApi,
  patchWeixinLongPollAbortMonitor,
} = require('../scripts/openclaw-plugin-patches/weixin-long-poll-abort.cjs');

// apiPostFetch/getUpdates as shipped in dist/ of plugin 2.4.3 after the send-receipt patch.
const DIST_API_FIXTURE = [
  'const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;',
  'const logger = { debug() {} };',
  'function ensureTrailingSlash(url) { return url.endsWith("/") ? url : `${url}/`; }',
  'function buildHeaders() { return {}; }',
  'function redactUrl(url) { return url; }',
  'function redactBody(body) { return body; }',
  'function buildBaseInfo() { return {}; }',
  'export async function apiPostFetch(params) {',
  '    const base = ensureTrailingSlash(params.baseUrl);',
  '    const url = new URL(params.endpoint, base);',
  '    const hdrs = buildHeaders({ token: params.token });',
  '    if (params.label !== "sendMessage") logger.debug(`POST ${redactUrl(url.toString())} body=${redactBody(params.body)}`);',
  '    const controller = params.timeoutMs !== undefined ? new AbortController() : undefined;',
  '    const t = controller != null && params.timeoutMs !== undefined',
  '        ? setTimeout(() => controller.abort(), params.timeoutMs)',
  '        : undefined;',
  '    try {',
  '        const res = await fetch(url.toString(), {',
  '            method: "POST",',
  '            headers: hdrs,',
  '            body: params.body,',
  '            ...(controller ? { signal: controller.signal } : {}),',
  '        });',
  '        if (t !== undefined)',
  '            clearTimeout(t);',
  '        const rawText = await res.text();',
  '        if (params.label !== "sendMessage") logger.debug(`${params.label} status=${res.status} raw=${redactBody(rawText)}`);',
  '        if (!res.ok) {',
  '            if (params.label === "sendMessage") throw new Error(`WEIXIN_SEND_HTTP_ERROR status=${res.status}`);',
  '      throw new Error(`${params.label} ${res.status}: ${rawText}`);',
  '        }',
  '        return rawText;',
  '    }',
  '    catch (err) {',
  '        if (t !== undefined)',
  '            clearTimeout(t);',
  '        throw err;',
  '    }',
  '}',
  '/**',
  ' * Long-poll getUpdates. Server should hold the request until new messages or timeout.',
  ' */',
  'export async function getUpdates(params) {',
  '    const timeout = params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;',
  '    try {',
  '        const rawText = await apiPostFetch({',
  '            baseUrl: params.baseUrl,',
  '            endpoint: "ilink/bot/getupdates",',
  '            body: JSON.stringify({',
  '                get_updates_buf: params.get_updates_buf ?? "",',
  '                base_info: buildBaseInfo(),',
  '            }),',
  '            token: params.token,',
  '            timeoutMs: timeout,',
  '            label: "getUpdates",',
  '        });',
  '        const resp = JSON.parse(rawText);',
  '        return resp;',
  '    }',
  '    catch (err) {',
  '        // Long-poll timeout is normal; return empty response so caller can retry',
  '        if (err instanceof Error && err.name === "AbortError") {',
  '            logger.debug(`getUpdates: client-side timeout after ${timeout}ms, returning empty response`);',
  '            return { ret: 0, msgs: [], get_updates_buf: params.get_updates_buf };',
  '        }',
  '        throw err;',
  '    }',
  '}',
  '',
].join('\n');

const SRC_API_FIXTURE = [
  'export async function apiPostFetch(params: {',
  '  baseUrl: string;',
  '  endpoint: string;',
  '  body: string;',
  '  token?: string;',
  '  timeoutMs?: number;',
  '  label: string;',
  '}): Promise<string> {',
  '  const controller =',
  '    params.timeoutMs !== undefined ? new AbortController() : undefined;',
  '  const t = undefined;',
  '  try {',
  '    const res = await fetch("https://example.invalid", {',
  '      ...(controller ? { signal: controller.signal } : {}),',
  '    });',
  '    return await res.text();',
  '  } catch (err) {',
  '    if (t !== undefined) clearTimeout(t);',
  '    throw err;',
  '  }',
  '}',
  '',
  'export async function getUpdates(',
  '  params: GetUpdatesReq & {',
  '    baseUrl: string;',
  '    token?: string;',
  '    timeoutMs?: number;',
  '  },',
  '): Promise<GetUpdatesResp> {',
  '  const timeout = params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;',
  '  try {',
  '    const rawText = await apiPostFetch({',
  '      timeoutMs: timeout,',
  '      label: "getUpdates",',
  '    });',
  '    return JSON.parse(rawText);',
  '  } catch (err) {',
  '    if (err instanceof Error && err.name === "AbortError") {',
  '      logger.debug(`getUpdates: client-side timeout after ${timeout}ms, returning empty response`);',
  '      return { ret: 0, msgs: [], get_updates_buf: params.get_updates_buf };',
  '    }',
  '    throw err;',
  '  }',
  '}',
  '',
].join('\n');

const MONITOR_FIXTURE = [
  'export async function monitorWeixinProvider(opts) {',
  '    const { abortSignal } = opts;',
  '    while (!abortSignal?.aborted) {',
  '        const resp = await getUpdates({',
  '            baseUrl,',
  '            token,',
  '            get_updates_buf: getUpdatesBuf,',
  '            timeoutMs: nextTimeoutMs,',
  '        });',
  '    }',
  '}',
  '',
].join('\n');

const tempDirs: string[] = [];
const noopLog = () => {};

function writeFixture(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-long-poll-abort-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

// Mirrors undici: a pending long-poll rejects with AbortError once its signal aborts.
function hangingFetch(seenSignals: AbortSignal[]) {
  return (_url: string, init: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
    const signal = init.signal;
    if (!signal) return;
    seenSignals.push(signal);
    signal.addEventListener('abort', () => {
      const error = new Error('This operation was aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('openclaw Weixin long-poll abort patch', () => {
  test('channel stop aborts the in-flight getUpdates long-poll and releases its listener', async () => {
    const apiPath = writeFixture('api.mjs', DIST_API_FIXTURE);
    patchWeixinLongPollAbortApi(apiPath, 'fixture', noopLog);
    const api = await import(pathToFileURL(apiPath).href);

    const seenSignals: AbortSignal[] = [];
    vi.stubGlobal('fetch', hangingFetch(seenSignals));
    const stop = new AbortController();
    const pending = api.getUpdates({
      baseUrl: 'https://example.invalid',
      get_updates_buf: 'buf',
      timeoutMs: 30_000,
      abortSignal: stop.signal,
    });
    await vi.waitFor(() => expect(seenSignals).toHaveLength(1));
    expect(getEventListeners(stop.signal, 'abort')).toHaveLength(1);

    stop.abort();

    await expect(pending).resolves.toEqual({ ret: 0, msgs: [], get_updates_buf: 'buf' });
    expect(seenSignals[0].aborted).toBe(true);
    expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0);
  });

  test('a completed long-poll removes its listener from the channel signal', async () => {
    const apiPath = writeFixture('api.mjs', DIST_API_FIXTURE);
    patchWeixinLongPollAbortApi(apiPath, 'fixture', noopLog);
    const api = await import(pathToFileURL(apiPath).href);

    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ret: 0, msgs: [], get_updates_buf: 'next' }),
    }));
    const stop = new AbortController();

    await expect(api.getUpdates({
      baseUrl: 'https://example.invalid',
      timeoutMs: 30_000,
      abortSignal: stop.signal,
    })).resolves.toEqual({ ret: 0, msgs: [], get_updates_buf: 'next' });
    expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0);
  });

  test('patches TypeScript sources and the monitor call idempotently', () => {
    const apiPath = writeFixture('api.ts', SRC_API_FIXTURE);
    const monitorPath = writeFixture('monitor.js', MONITOR_FIXTURE);

    for (let i = 0; i < 2; i += 1) {
      patchWeixinLongPollAbortApi(apiPath, 'fixture', noopLog);
      patchWeixinLongPollAbortMonitor(monitorPath, 'fixture', noopLog);
    }

    const api = fs.readFileSync(apiPath, 'utf8');
    expect(api.split(LONG_POLL_ABORT_MARKER)).toHaveLength(2);
    expect(api).toContain('  label: string;\n  abortSignal?: AbortSignal;\n}): Promise<string> {');
    expect(api).toContain('    timeoutMs?: number;\n    abortSignal?: AbortSignal;\n  },');
    expect(api).toContain('      abortSignal: params.abortSignal,\n');
    expect(api).toContain('  } finally {\n    cleanup();\n  }\n}');
    expect(api).not.toContain('controller.signal } : {})');

    const monitor = fs.readFileSync(monitorPath, 'utf8');
    expect(monitor.split(LONG_POLL_ABORT_MARKER)).toHaveLength(2);
    expect(monitor).toContain('            timeoutMs: nextTimeoutMs,\n            // lobster_weixin_long_poll_abort_v1');
    expect(monitor).toContain('            abortSignal,\n        });');
  });

  test('fails loudly when the pinned implementation changes', () => {
    const apiPath = writeFixture('api.js', 'export async function apiPostFetch(params) {\n  return "";\n}\n');
    expect(() => patchWeixinLongPollAbortApi(apiPath, 'fixture', noopLog))
      .toThrow('fixture: expected apiPostFetch try block was not found');

    const monitorPath = writeFixture('monitor.js', 'export async function monitor() {}\n');
    expect(() => patchWeixinLongPollAbortMonitor(monitorPath, 'fixture', noopLog))
      .toThrow('fixture: expected monitor getUpdates call was not found');
  });
});
