import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { SettingsRuntime } from '../../../openclaw-extensions/lobster-agent-settings/coordinator';

let temporary: string;
let plugin: { register(api: any): void };
beforeAll(async () => {
  temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'settings-plugin-test-'));
  const output = path.join(temporary, 'plugin.mjs');
  await build({ entryPoints: [path.resolve('openclaw-extensions/lobster-agent-settings/index.ts')], outfile: output,
    bundle: true, platform: 'node', target: 'node24', format: 'esm', plugins: [{ name: 'test-agent-catalog', setup(builder) {
      builder.onResolve({ filter: /^openclaw\/plugin-sdk\/agent-scope-runtime$/u }, () => ({ path: 'agent-catalog', namespace: 'test-sdk' }));
      builder.onLoad({ filter: /.*/u, namespace: 'test-sdk' }, () => ({ contents: 'export const listAgentIds = config => Object.keys(config.agents.entries);', loader: 'js' }));
    } }] });
  plugin = (await import(pathToFileURL(output).href)).default;
});
afterAll(() => { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); });

const run = { agentId: 'main', sessionKey: 'agent:main:lobsterai:session1', runId: 'remote-run' };
function fixture() {
  const methods = new Map<string, { handler: (request: any) => unknown; options: { scope: string } }>();
  const hooks = new Map<string, (event: any, context: any) => unknown>();
  let factory!: (context: any) => any;
  let policy!: { evaluate(event: any, context: any): any };
  plugin.register({ pluginConfig: { callbackUrl: 'http://127.0.0.1:12345/agent-settings/tool', secret: 'test-only' },
    runtime: { config: { current: () => ({ agents: { entries: { main: {}, agent1: {} } } }) }, agent: { resolveAgentWorkspaceDir: () => '/unused' } },
    registerGatewayMethod: (name: string, handler: (request: any) => unknown, options: { scope: string }) => methods.set(name, { handler, options }),
    registerTrustedToolPolicy: (value: typeof policy) => { policy = value; },
    registerTool: (value: typeof factory) => { factory = value; },
    on: (name: string, handler: (event: any, context: any) => unknown) => hooks.set(name, handler),
  });
  const bind = async (params: unknown) => {
    let response!: { ok: boolean; data: unknown; error: unknown };
    const method = methods.get(SettingsRuntime.BindRun)!;
    expect(method.options.scope).toBe('operator.admin');
    await method.handler({ params, respond: (ok: boolean, data: unknown, error: unknown) => { response = { ok, data, error }; } });
    return response;
  };
  return { factory, policy, hooks, bind };
}

test('local and legacy factory contexts stay hidden, and a rejected local call does not block local tools', () => {
  const f = fixture();
  expect(f.factory(run)).toBeNull();
  expect(f.factory({ agentId: run.agentId, sessionKey: run.sessionKey })).toBeNull();
  const context = { ...run, toolCallId: 'call1' };
  expect(f.policy.evaluate({ toolName: SettingsRuntime.Tool }, context)).toMatchObject({ block: true });
  expect(f.policy.evaluate({ toolName: 'exec' }, { ...context, toolCallId: 'call2' })).toBeUndefined();
});

test('only an exact registered remote run sees the tool; agent_end removes visibility and protection', async () => {
  const f = fixture(); expect(await f.bind(run)).toMatchObject({ ok: true, data: { bound: true } });
  expect(f.factory(run)?.name).toBe(SettingsRuntime.Tool);
  expect(f.factory({ ...run, runId: 'local-next-run' })).toBeNull();
  expect(f.factory({ ...run, sessionKey: 'agent:main:lobsterai:other' })).toBeNull();
  expect(f.factory({ agentId: run.agentId, sessionKey: run.sessionKey })).toBeNull();
  const context = { ...run, toolCallId: 'call1' };
  expect(f.policy.evaluate({ toolName: SettingsRuntime.Tool }, context)).toBeUndefined();
  expect(f.policy.evaluate({ toolName: 'exec' }, { ...context, toolCallId: 'fallback' })).toMatchObject({ block: true });
  await f.hooks.get('agent_end')!({}, run);
  expect(f.factory(run)).toBeNull();
  expect(f.policy.evaluate({ toolName: 'exec' }, { ...context, toolCallId: 'local-again' })).toBeUndefined();
});

test('bindRun rejects extra fields, unknown agents, cross-agent sessions and unsafe identifiers', async () => {
  const f = fixture();
  for (const request of [{ ...run, owner: 'forged' }, { ...run, agentId: 'missing', sessionKey: 'agent:missing:lobsterai:s' },
    { ...run, sessionKey: 'agent:agent1:lobsterai:session1' }, { ...run, sessionKey: 'agent:main:lobsterai:../escape' },
    { ...run, runId: 'unsafe\n' }, { ...run, sessionKey: 'agent:main:cron:session1' }]) {
    expect(await f.bind(request)).toMatchObject({ ok: false });
  }
  expect(f.factory(run)).toBeNull();
});
