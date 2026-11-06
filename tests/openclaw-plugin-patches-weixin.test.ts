import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const {
  assertWeixinPluginVersion,
  patchWeixinLazyInboundSdk,
  patchWeixinLazyOutboundHooks,
  patchWeixinLongPollAbortApi,
  patchWeixinLongPollAbortMonitor,
  patchWeixinNarrowSdkImports,
} = require('../scripts/openclaw-plugin-patches/weixin.cjs');

// Shapes of openclaw-weixin 2.4.3 dist/src/api/api.js and dist/src/monitor/monitor.js.
const WEIXIN_API_JS = [
  'export async function apiGetFetch(params) {',
  '    const controller = params.timeoutMs != null ? new AbortController() : undefined;',
  '    const res = await fetch(params.url, {',
  '            method: "GET",',
  '            ...(controller ? { signal: controller.signal } : {}),',
  '        });',
  '    return res.text();',
  '}',
  'export async function apiPostFetch(params) {',
  '    const url = new URL(params.endpoint, params.baseUrl);',
  '    const controller = params.timeoutMs !== undefined ? new AbortController() : undefined;',
  '    const t = controller != null && params.timeoutMs !== undefined',
  '        ? setTimeout(() => controller.abort(), params.timeoutMs)',
  '        : undefined;',
  '    try {',
  '        const res = await fetch(url.toString(), {',
  '            method: "POST",',
  '            body: params.body,',
  '            ...(controller ? { signal: controller.signal } : {}),',
  '        });',
  '        if (t !== undefined)',
  '            clearTimeout(t);',
  '        return await res.text();',
  '    }',
  '    catch (err) {',
  '        if (t !== undefined)',
  '            clearTimeout(t);',
  '        throw err;',
  '    }',
  '}',
  'export async function getUpdates(params) {',
  '    const timeout = params.timeoutMs ?? 35000;',
  '    try {',
  '        const rawText = await apiPostFetch({',
  '            baseUrl: params.baseUrl,',
  '            endpoint: "ilink/bot/getupdates",',
  '            body: JSON.stringify({ get_updates_buf: params.get_updates_buf ?? "" }),',
  '            timeoutMs: timeout,',
  '            label: "getUpdates",',
  '        });',
  '        return JSON.parse(rawText);',
  '    }',
  '    catch (err) {',
  '        if (err instanceof Error && err.name === "AbortError") {',
  '            return { ret: 0, msgs: [], get_updates_buf: params.get_updates_buf };',
  '        }',
  '        throw err;',
  '    }',
  '}',
  '',
].join('\n');

const WEIXIN_MONITOR_JS = [
  'export async function monitorWeixinProvider(opts) {',
  '    const { abortSignal } = opts;',
  '    while (!abortSignal?.aborted) {',
  '            const resp = await getUpdates({',
  '                baseUrl,',
  '                token,',
  '                get_updates_buf: getUpdatesBuf,',
  '                timeoutMs: nextTimeoutMs,',
  '            });',
  '    }',
  '}',
  '',
].join('\n');

/** Evaluates the patched fixture so the test exercises the patched fetch call. */
function loadGetUpdates(apiSource: string): (params: Record<string, unknown>) => Promise<unknown> {
  const body = apiSource.replaceAll('export async function', 'async function');
  return new Function(`${body}\nreturn getUpdates;`)();
}

describe('openclaw Weixin plugin startup patches', () => {
  test('uses narrow SDK entry points and defers message-only runtime imports', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-plugin-patch-'));
    const processMessagePath = path.join(tempDir, 'process-message.ts');
    fs.writeFileSync(processMessagePath, [
      'import { createTypingCallbacks } from "openclaw/plugin-sdk/channel-runtime";',
      'import {',
      '  resolveSenderCommandAuthorizationWithRuntime,',
      '  resolveDirectDmAuthorizationOutcome,',
      '} from "openclaw/plugin-sdk/command-auth";',
      'import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/infra-runtime";',
      'import { logger } from "../util/logger.js";',
      'import { applyWeixinMessageSendingHook, emitWeixinMessageSent } from "./outbound-hooks.js";',
      'const MEDIA_OUTBOUND_TEMP_DIR = resolvePreferredOpenClawTmpDir();',
      'export async function processOneMessage() {',
      '  const { senderAllowedForCommands, commandAuthorized } =',
      '    await resolveSenderCommandAuthorizationWithRuntime({});',
      '  const directDmOutcome = resolveDirectDmAuthorizationOutcome({ senderAllowedForCommands });',
      '  const typingCallbacks = createTypingCallbacks({});',
      '  const sendingResult = await applyWeixinMessageSendingHook({ to: "to", text: "text" });',
      '  emitWeixinMessageSent({ to: "to", content: sendingResult.text, success: true });',
      '  return { commandAuthorized, directDmOutcome, typingCallbacks, MEDIA_OUTBOUND_TEMP_DIR };',
      '}',
      '',
    ].join('\n'));

    const log = () => {};
    patchWeixinNarrowSdkImports(processMessagePath, 'fixture', log);
    patchWeixinLazyOutboundHooks(
      processMessagePath,
      'fixture',
      './outbound-hooks.js',
      'const MEDIA_OUTBOUND_TEMP_DIR',
      log,
    );
    patchWeixinLazyInboundSdk(processMessagePath, 'fixture', log);
    patchWeixinLazyOutboundHooks(
      processMessagePath,
      'fixture',
      './outbound-hooks.js',
      'const MEDIA_OUTBOUND_TEMP_DIR',
      log,
    );
    patchWeixinLazyInboundSdk(processMessagePath, 'fixture', log);

    const patched = fs.readFileSync(processMessagePath, 'utf8');
    expect(patched).toContain('from "openclaw/plugin-sdk/temp-path"');
    expect(patched).not.toContain('openclaw/plugin-sdk/infra-runtime');
    expect(patched).not.toContain('openclaw/plugin-sdk/channel-runtime');
    expect(patched).not.toContain('from "openclaw/plugin-sdk/command-auth"');
    expect(patched).toContain('await import("openclaw/plugin-sdk/command-auth")');
    expect(patched).toContain('await import("openclaw/plugin-sdk/channel-reply-pipeline")');
    expect(patched).not.toContain(
      'import { applyWeixinMessageSendingHook, emitWeixinMessageSent }',
    );
    expect(patched.match(/lobster_weixin_lazy_outbound_hooks/g)).toHaveLength(1);
    expect(patched.match(/lobster_weixin_lazy_inbound_sdk/g)).toHaveLength(1);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('routes file locking to the narrow SDK entry point', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-plugin-patch-'));
    const pairingPath = path.join(tempDir, 'pairing.ts');
    fs.writeFileSync(
      pairingPath,
      'import { withFileLock } from "openclaw/plugin-sdk/infra-runtime";\n',
    );

    patchWeixinNarrowSdkImports(pairingPath, 'fixture', () => {});

    expect(fs.readFileSync(pairingPath, 'utf8'))
      .toContain('from "openclaw/plugin-sdk/file-lock"');
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('lets the channel abort signal end the getUpdates long poll', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-plugin-patch-'));
    const apiPath = path.join(tempDir, 'api.js');
    const monitorPath = path.join(tempDir, 'monitor.js');
    fs.writeFileSync(apiPath, WEIXIN_API_JS);
    fs.writeFileSync(monitorPath, WEIXIN_MONITOR_JS);

    patchWeixinLongPollAbortApi(apiPath, 'fixture', () => {});
    patchWeixinLongPollAbortMonitor(monitorPath, 'fixture', () => {});
    patchWeixinLongPollAbortApi(apiPath, 'fixture', () => {});
    patchWeixinLongPollAbortMonitor(monitorPath, 'fixture', () => {});

    const patchedApi = fs.readFileSync(apiPath, 'utf8');
    expect(patchedApi.match(/lobster_weixin_longpoll_abort/g)).toHaveLength(1);
    expect(patchedApi).toContain('abortSignal: params.abortSignal,');
    // The GET wrapper is not part of the long poll and keeps its own signal.
    expect(patchedApi.indexOf('...(controller ? { signal: controller.signal } : {}),'))
      .toBeLessThan(patchedApi.indexOf('export async function apiPostFetch'));
    expect(fs.readFileSync(monitorPath, 'utf8')).toContain('abortSignal, // lobster_weixin_longpoll_abort');

    const server = http.createServer((_req, res) => {
      setTimeout(() => res.end('{"ret":0,"msgs":[]}'), 10_000);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const getUpdates = loadGetUpdates(patchedApi);
      const controller = new AbortController();
      const startedAt = Date.now();
      setTimeout(() => controller.abort(), 50);
      await expect(getUpdates({ baseUrl, get_updates_buf: 'buf', timeoutMs: 35_000, abortSignal: controller.signal }))
        .resolves.toEqual({ ret: 0, msgs: [], get_updates_buf: 'buf' });
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      server.closeAllConnections();
      server.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('fails loudly when the long-poll code no longer matches', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-plugin-patch-'));
    const apiPath = path.join(tempDir, 'api.js');
    fs.writeFileSync(apiPath, WEIXIN_API_JS.replace('label: "getUpdates",', 'label: "poll",'));

    expect(() => patchWeixinLongPollAbortApi(apiPath, 'fixture', () => {})).toThrow('fixture: expected');
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('fails closed when the pinned plugin version changes', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-plugin-patch-'));
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ version: '2.5.0' }));

    expect(() => assertWeixinPluginVersion(tempDir)).toThrow(
      'openclaw-weixin startup patch expects 2.4.3, found 2.5.0',
    );
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
