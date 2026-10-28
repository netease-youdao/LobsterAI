import { afterEach, expect, test, vi } from 'vitest';

import plugin from '../../../openclaw-extensions/lobster-media-generation/index';
import { MediaConfirmationPolicy } from '../../../src/shared/media/confirmation';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('video confirmation uses the configured retention budget and propagates an explicit stop', async () => {
  vi.useFakeTimers();
  const factories: Array<
    (context: {
      sessionKey: string;
    }) => {
      name: string;
      execute: (id: string, args: unknown, signal: AbortSignal) => Promise<unknown>;
    } | null
  > = [];
  let bridgeSignal: AbortSignal | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          bridgeSignal = options.signal;
          bridgeSignal!.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    ),
  );
  plugin.register({
    pluginConfig: {
      callbackUrl: 'http://127.0.0.1/media',
      secret: 'test',
      confirmationTimeoutMs: MediaConfirmationPolicy.RetentionMs,
    },
    logger: { info: vi.fn() },
    on: vi.fn(),
    registerTool: (factory: (typeof factories)[number]) => factories.push(factory),
  } as never);
  const video = factories
    .map(factory => factory({ sessionKey: 'agent:main:lobsterai:session-test' }))
    .find(tool => tool?.name === 'lobsterai_video_generate')!;
  const controller = new AbortController();
  const pending = video.execute('call', { action: 'generate' }, controller.signal);
  await vi.advanceTimersByTimeAsync(270_001);
  expect(bridgeSignal?.aborted).toBe(false);
  controller.abort();
  await expect(pending).resolves.toMatchObject({ isError: true });
  expect(bridgeSignal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
