import { afterEach, expect, test, vi } from 'vitest';

import plugin from '../../../openclaw-extensions/lobster-media-generation/index';
import { MediaRunAccountScopes, MediaRunLifecycle } from '../../../src/main/mediaRunAccountScopes';

afterEach(() => vi.unstubAllGlobals());

test.each([
  ['agent:main:feishu:direct:user-1', 'lobsterai_image_generate'],
  ['agent:main:cron:job-1:run:execution-1', 'lobsterai_video_generate'],
])('native media bridge keeps the captured owner for %s', async (sessionKey, toolName) => {
  const hooks = new Map<string, (...args: any[]) => Promise<any>>();
  const factories: Array<(ctx: any) => any> = [];
  const scopes = new MediaRunAccountScopes();
  let account = { ownerAccountKey: 'personal:1', accountGeneration: 1 };
  const requests: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    let isError = false;
    if (request.tool === MediaRunLifecycle.Tool) {
      if (request.args.action === MediaRunLifecycle.Begin) scopes.begin(request.context, account);
      else scopes.end(request.context);
    } else {
      isError = scopes.resolve(request.context, account) === null;
    }
    return new Response(JSON.stringify({
      content: [], isError, details: { status: 'succeeded' },
    }));
  }));
  plugin.register({
    pluginConfig: { callbackUrl: 'http://127.0.0.1/media', secret: 'test-secret' },
    logger: { info: vi.fn() },
    on: (name: string, handler: (...args: any[]) => Promise<any>) => hooks.set(name, handler),
    registerTool: (factory: (ctx: any) => any) => factories.push(factory),
  } as never);

  const context = { sessionKey, runId: 'run-1' };
  const tools = factories.map(factory => factory({ sessionKey })).filter(Boolean);
  expect(tools.map(tool => tool.name)).toEqual(['lobsterai_image_generate', 'lobsterai_video_generate']);
  const tool = tools.find(tool => tool.name === toolName);
  // A missing lifecycle cannot be replaced by model-supplied identifiers.
  expect(await hooks.get('before_tool_call')!({ toolName, toolCallId: 'early' }, context)).toMatchObject({ block: true });
  expect((await tool.execute('early', { action: 'generate', runId: 'forged' })).isError).toBe(true);
  expect(requests).toHaveLength(0);

  await hooks.get('before_model_resolve')!({ prompt: 'generate media' }, context);
  expect(await hooks.get('before_tool_call')!({ toolName, toolCallId: 'call-1' }, context)).toBeUndefined();
  expect((await tool.execute('call-1', { action: 'generate', model: 'test-model', runId: 'forged' })).isError).toBe(false);
  expect(requests.at(-1).context).toEqual({ ...context, toolCallId: 'call-1' });
  await hooks.get('agent_end')!({ success: false }, context);
  expect(scopes.resolve(context, account)).toEqual(account);

  // Repeated hooks and later calls do not migrate the old run to the new owner.
  account = { ownerAccountKey: 'enterprise:2:1', accountGeneration: 2 };
  await hooks.get('before_model_resolve')!({}, context);
  await hooks.get('before_tool_call')!({ toolName, toolCallId: 'late-call' }, context);
  expect((await tool.execute('late-call', { action: 'list' })).isError).toBe(true);

  const next = { ...context, runId: 'run-2' };
  await hooks.get('before_model_resolve')!({}, next);
  await hooks.get('before_tool_call')!({ toolName, toolCallId: 'new-call' }, next);
  expect((await tool.execute('new-call', { action: 'list' })).isError).toBe(false);
  await hooks.get('agent_end')!({ success: true }, context);
  expect(scopes.resolve(next, account)).toEqual(account);
  await hooks.get('agent_end')!({ success: true }, next);
  expect(scopes.resolve(next, account)).toBeNull();
});
