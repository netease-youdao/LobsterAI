import { afterEach, expect, test, vi } from 'vitest';

import plugin from '../openclaw-extensions/lobster-model-routing';

afterEach(() => vi.unstubAllGlobals());

test('registers original input before model dispatch and ignores the decorated prompt', async () => {
  const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  plugin.register({
    pluginConfig: { proxyUrl: 'http://127.0.0.1:1234', token: 'test' },
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => hooks.set(name, handler),
    logger: { warn: vi.fn() },
  } as unknown as Parameters<typeof plugin.register>[0]);
  let acknowledge!: (response: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>((resolve) => { acknowledge = resolve; }));
  vi.stubGlobal('fetch', fetch);
  let finished = false;
  const pending = Promise.resolve(hooks.get('before_prompt_build')!({ prompt: 'OpenClaw runtime context for the active user request' }, {
    runId: 'run', trace: { traceId: '1'.repeat(32) }, sessionId: 'sid',
    sessionKey: 'agent:main:telegram:direct:123', trigger: 'user',
    usageUserMessage: '原始消息', modelId: 'deepseek-flash',
  })).then(() => { finished = true; });
  expect(finished).toBe(false);
  expect(JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ userMessage: '原始消息', sessionId: 'sid' });
  acknowledge(new Response(null, { status: 204 }));
  await pending;
  expect(finished).toBe(true);
});
