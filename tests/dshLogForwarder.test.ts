import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, expect, test, vi } from 'vitest';

import * as plugin from '../dsh-bundles/lobsterai-host/plugins/log-forwarder.mjs';

afterEach(() => vi.restoreAllMocks());

function capture(...args: unknown[]): string {
  const exporter = vi.fn();
  plugin.apply({ logger: { exporter } });
  const [options] = exporter.mock.calls[0];
  expect(options).toMatchObject({ levels: { default: 2 }, colors: 0 });
  const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  options.export({ type: 'warn', name: 'probe', args });
  return String(write.mock.lastCall?.[0]);
}

test('formats Cordis placeholders, circular objects and Error stacks as one plain line', () => {
  const circular: { self?: unknown } = {};
  circular.self = circular;
  const error = new Error('failed');
  error.stack = 'Error: failed\n    at probe';
  const line = capture('%C %s %d %%C %o', '\x1b[34mpath\x1b[0m', 'count', 3, circular, error);
  expect(line).toMatch(/^\[dsh-logger\]\[warn\]\[probe\] path count 3 %C .*Circular.*Error: failed.*at probe\n$/);
  expect(line.trimEnd()).not.toMatch(/[\r\n\x1b]/);
});

test.each([
  ['https://localhost/?token=private-value'],
  ['Bearer private-value'],
  [{ headers: { 'x-api-key': 'private-value' } }],
  ['%j', { refreshToken: 'private-value' }],
  ['authorization: Basic private-value'],
  ['sk-private-value'],
  ['API key %s', 'private-value'],
  ['--token private-value'],
  ['eyJwcm9iZQ.eyJwcm9iZQ.signature'],
])('suppresses credentials before writing the record', (...args) => {
  expect(capture(...args)).toBe('[dsh-logger][warn][probe] [redacted]\n');
});

test('caps the complete line by UTF-8 bytes without splitting a character', () => {
  const line = capture('中🙂'.repeat(2000)).trimEnd();
  expect(Buffer.byteLength(line)).toBeLessThanOrEqual(2048);
  expect(line).toMatch(/(?:中|🙂)\.\.\.$/u);
});

const cordis = path.resolve('vendor/dsh-runtime/current/node_modules/@deepseek-ai/cordis/lib/index.js');
test.skipIf(!existsSync(cordis))('Cordis filters debug and disposes the exporter when the plugin unloads', async () => {
  const { Context } = await import(/* @vite-ignore */ pathToFileURL(cordis).href);
  const ctx = new Context();
  const fiber = await ctx.plugin(plugin);
  const logger = ctx.logger('probe');
  const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    logger.info('visible');
    logger.debug('hidden');
  } finally {
    await fiber.dispose();
  }
  logger.warn('unloaded');
  expect(write.mock.calls.map(([line]) => line)).toEqual(['[dsh-logger][info][probe] visible\n']);
});
