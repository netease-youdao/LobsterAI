import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import ts from 'typescript';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { WeixinDeliveryError } from '../src/shared/im/weixin';

const { patchWeixinSendReceipt, patchWeixinDeliveryLog } = require('../scripts/openclaw-plugin-patches/weixin-send-receipt.cjs');
const tempDirs: string[] = [];
afterEach(() => tempDirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

// Pinned 2.4.3 send shape. Execute the patched output with intercepted HTTP,
// including the compiled JS path used by the packaged runtime.
const fixture = `
export async function apiPostFetch(params: {
  baseUrl: string;
  endpoint: string;
  label: string;
  body: string;
}): Promise<string> {
  const url = new URL(params.endpoint, params.baseUrl);
  logger.debug(\`POST \${redactUrl(url.toString())} body=\${redactBody(params.body)}\`);
  const res = await fetch(url, { method: 'POST', body: params.body });
  const rawText = await res.text();
  logger.debug(\`\${params.label} status=\${res.status} raw=\${redactBody(rawText)}\`);
  if (!res.ok) {
    throw new Error(\`\${params.label} \${res.status}: \${rawText}\`);
  }
  return rawText;
}
export async function sendMessage(params: any): Promise<void> {
  await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    label: "sendMessage",
  });
}
`;

function compile(source: string, module = ts.ModuleKind.CommonJS): string {
  return ts.transpileModule(source, { compilerOptions: { module, target: ts.ScriptTarget.ES2022 } }).outputText;
}

function loadPatched(extension: string, raw: string, status = 200) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-receipt-'));
  tempDirs.push(dir);
  const file = path.join(dir, `api.${extension}`);
  fs.writeFileSync(file, extension === 'ts' ? fixture : compile(fixture, ts.ModuleKind.ES2022));
  patchWeixinSendReceipt(file, 'fixture', () => {});
  const patched = fs.readFileSync(file, 'utf8');
  patchWeixinSendReceipt(file, 'fixture', () => {});
  expect(fs.readFileSync(file, 'utf8')).toBe(patched);
  const fetch = vi.fn(async () => new Response(raw, { status }));
  const logger = { debug: vi.fn() };
  const exports = {} as { sendMessage: (params: unknown) => Promise<void> };
  new Function('exports', 'fetch', 'logger', 'buildBaseInfo', 'DEFAULT_API_TIMEOUT_MS', 'redactUrl', 'redactBody', compile(patched))(
    exports, fetch, logger, () => ({}), 15000, String, String,
  );
  return {
    send: () => exports.sendMessage({ baseUrl: 'https://weixin.invalid/', token: 'secret-token', body: { msg: { text: 'private-report' } } }),
    fetch, logger,
  };
}

describe.each(['ts', 'js'])('Weixin %s business receipts', extension => {
  test.each(['{"ret":0}', '{}', '{"ret":0,"errcode":0}'])('accepts the protocol success receipt %s', async raw => {
    const { send, fetch } = loadPatched(extension, raw);
    await expect(send()).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test.each([
    [{ ret: -2, errmsg: 'rejected secret-token private-report' }, `${WeixinDeliveryError.Rejected} ret=-2 errcode=0`],
    [{ ret: -2, errmsg: 'context_token expired: secret-token' }, `${WeixinDeliveryError.ContextExpired} ret=-2 errcode=0`],
    [{ ret: 0, errcode: -14, errmsg: 'token secret-token' }, `${WeixinDeliveryError.AccountExpired} ret=0 errcode=-14`],
  ])('propagates a redacted rejection, without guessing from ret alone', async (response, message) => {
    const { send, logger } = loadPatched(extension, JSON.stringify(response));
    await expect(send()).rejects.toThrow(message);
    expect(logger.debug).not.toHaveBeenCalled();
  });

  test.each(['not JSON secret-token', 'null', '[]', 'true', '{"ret":"0"}', '{"ret":null}', '{"errcode":[]}'])('rejects an invalid receipt %s', async raw => {
    const { send } = loadPatched(extension, raw);
    await expect(send()).rejects.toThrow(WeixinDeliveryError.InvalidResponse);
  });

  test('preserves HTTP failure without returning the server body', async () => {
    const { send } = loadPatched(extension, 'secret-token private-report', 503);
    await expect(send()).rejects.toThrow(`${WeixinDeliveryError.HttpError} status=503`);
  });
});

test('refuses a drifted send implementation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-receipt-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'api.ts');
  fs.writeFileSync(file, 'export async function sendMessage() {}');
  expect(() => patchWeixinSendReceipt(file, 'fixture', () => {})).toThrow('expected sendMessage');
});

test('delivery outcome logs contain stable hashes and codes, never raw identity or content', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-receipt-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'channel.ts');
  fs.writeFileSync(file, `export function emitWeixinMessageSent(params: any) {
  void loadWeixinOutboundHooks().then(() => {});
}`);
  patchWeixinDeliveryLog(file, 'fixture', () => {});
  const source = fs.readFileSync(file, 'utf8');
  patchWeixinDeliveryLog(file, 'fixture', () => {});
  expect(fs.readFileSync(file, 'utf8')).toBe(source);
  const logger = { info: vi.fn(), error: vi.fn() };
  const exports = {} as { emitWeixinMessageSent: (params: unknown) => void };
  new Function('exports', 'require', 'logger', 'loadWeixinOutboundHooks', compile(source))(
    exports, require, logger, () => Promise.resolve({}),
  );
  for (const success of [true, false]) {
    exports.emitWeixinMessageSent({ accountId: 'private-account', to: 'private-peer', content: 'private-report', success,
      error: `${WeixinDeliveryError.Rejected} ret=-2 errcode=0 secret-token` });
  }
  const output = JSON.stringify([logger.info.mock.calls, logger.error.mock.calls]);
  expect(output).toContain('outcome=accepted');
  expect(output).toContain('outcome=failed');
  expect(output).toContain('ret=-2');
  for (const secret of ['private-account', 'private-peer', 'private-report', 'secret-token']) {
    expect(output).not.toContain(secret);
  }
});
