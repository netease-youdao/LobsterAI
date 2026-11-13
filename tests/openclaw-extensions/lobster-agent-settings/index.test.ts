import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';

import { SettingsRuntime } from '../../../openclaw-extensions/lobster-agent-settings/coordinator';

let temporary: string;
let plugin: { register(api: any): void };
let separatePlugin: typeof plugin;
beforeAll(async () => {
  temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'settings-plugin-test-'));
  const output = path.join(temporary, 'plugin.mjs');
  await build({ entryPoints: [path.resolve('openclaw-extensions/lobster-agent-settings/index.ts')], outfile: output,
    bundle: true, platform: 'node', target: 'node24', format: 'esm', plugins: [{ name: 'test-agent-catalog', setup(builder) {
      builder.onResolve({ filter: /^openclaw\/plugin-sdk\/agent-scope-runtime$/u }, () => ({ path: 'agent-catalog', namespace: 'test-sdk' }));
      builder.onLoad({ filter: /.*/u, namespace: 'test-sdk' }, () => ({ contents: 'export const listAgentIds = config => Object.keys(config.agents.entries);', loader: 'js' }));
    } }] });
  plugin = (await import(pathToFileURL(output).href)).default;
  separatePlugin = (await import(`${pathToFileURL(output).href}?discovery-copy`)).default;
});
afterEach(() => {
  const runtime = globalThis as unknown as Record<symbol, unknown>;
  delete runtime[Symbol.for(SettingsRuntime.SharedState)]; delete runtime[Symbol.for(SettingsRuntime.MemoryLock)];
  vi.unstubAllGlobals();
});
afterAll(() => { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); });

const run = { agentId: 'main', sessionKey: 'agent:main:lobsterai:session1', runId: 'remote-run' };
function fixture(options: { implementation?: typeof plugin; mode?: string; secret?: string; callbackUrl?: string } = {}) {
  const methods = new Map<string, { handler: (request: any) => unknown; options: { scope: string } }>();
  const hooks = new Map<string, (event: any, context: any) => unknown>();
  let factory!: (context: any) => any;
  let policy!: { evaluate(event: any, context: any): any };
  (options.implementation ?? plugin).register({ registrationMode: options.mode ?? 'full',
    pluginConfig: { callbackUrl: options.callbackUrl ?? 'http://127.0.0.1:12345/agent-settings/tool', secret: options.secret ?? 'test-only' },
    runtime: { config: { current: () => ({ agents: { entries: { main: {}, agent1: {} } } }) }, agent: { resolveAgentWorkspaceDir: () => '/unused' } },
    registerGatewayMethod: (name: string, handler: (request: any) => unknown, options: { scope: string }) => methods.set(name, { handler, options }),
    registerTrustedToolPolicy: (value: typeof policy) => { policy = value; },
    registerTool: (value: typeof factory) => { factory = value; },
    on: (name: string, handler: (event: any, context: any) => unknown) => hooks.set(name, handler),
  });
  const invoke = async (name: string, params: unknown) => {
    let response!: { ok: boolean; data: unknown; error: unknown };
    const method = methods.get(name)!;
    expect(method.options.scope).toBe('operator.admin');
    await method.handler({ params, respond: (ok: boolean, data: unknown, error: unknown) => { response = { ok, data, error }; } });
    return response;
  };
  return { factory, policy, hooks, invoke, bind: (params: unknown) => invoke(SettingsRuntime.BindRun, params) };
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

test('gateway bindings, tool calls and writer leases are shared across independently loaded discovery copies', async () => {
  const gateway = fixture();
  const tools = fixture({ implementation: separatePlugin, mode: 'tool-discovery' });
  const agentRun = { agentId: 'agent1', sessionKey: 'agent:agent1:lobsterai:session1', runId: 'remote-run' };
  expect(await gateway.bind(agentRun)).toMatchObject({ ok: true });
  const tool = tools.factory(agentRun);
  expect(tool?.name).toBe(SettingsRuntime.Tool);
  const context = { ...agentRun, toolCallId: 'call1' };
  expect(gateway.policy.evaluate({ toolName: SettingsRuntime.Tool }, context)).toBeUndefined();
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'verified' }] }) }));
  vi.stubGlobal('fetch', fetch);
  await expect(tool.execute('call1', { action: 'read', section: 'identity' })).resolves.toMatchObject({ content: [{ text: 'verified' }] });
  expect(JSON.parse((fetch.mock.calls[0] as unknown as [string, { body: string }])[1].body).context).toEqual(context);
  (globalThis as unknown as Record<symbol, unknown>)[Symbol.for(SettingsRuntime.MemoryLock)] = async (_workspace: string, action: () => Promise<unknown>) => action();
  const lease = await gateway.invoke(SettingsRuntime.Acquire, context);
  expect(lease).toMatchObject({ ok: true });
  const token = (lease.data as { token: string }).token;
  expect(tools.policy.evaluate({ toolName: 'exec' }, { ...context, runId: 'other', toolCallId: 'writer' })).toMatchObject({ block: true });
  expect(await tools.invoke(SettingsRuntime.Release, { agentId: agentRun.agentId, token })).toMatchObject({ data: { released: true } });
  await Promise.resolve();
  tools.hooks.get('after_tool_call')!({}, context);
  await expect(tool.execute('call1', {})).resolves.toMatchObject({ isError: true });
  tools.hooks.get('agent_end')!({}, agentRun);
  expect(gateway.factory(agentRun)).toBeNull();
  expect(tools.factory(agentRun)).toBeNull();
});

test('discovery cannot create binding authority before gateway activation', () => {
  const tools = fixture({ implementation: separatePlugin, mode: 'tool-discovery' });
  expect(tools.factory).toBeUndefined();
  const gateway = fixture();
  expect(gateway.factory(run)).toBeNull();
});

test.each([{ secret: 'rotated-secret' }, { callbackUrl: 'http://127.0.0.1:54321/agent-settings/tool' }])('configuration rotation revokes old factories and rejects stale discovery: %j', async rotated => {
  const gateway = fixture();
  const tools = fixture({ implementation: separatePlugin, mode: 'tool-discovery' });
  await gateway.bind(run);
  const context = { ...run, toolCallId: 'call1' }, oldTool = tools.factory(run);
  gateway.policy.evaluate({ toolName: SettingsRuntime.Tool }, context);
  const next = fixture(rotated);
  expect(next.factory(run)).toBeNull();
  expect(await gateway.bind(run)).toMatchObject({ ok: false });
  expect(await gateway.invoke(SettingsRuntime.Status, {})).toMatchObject({ data: { ready: false } });
  const stale = fixture({ implementation: separatePlugin, mode: 'tool-discovery' });
  expect(stale.factory).toBeUndefined();
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(oldTool.execute('call1', {})).resolves.toMatchObject({ isError: true });
  expect(fetch).not.toHaveBeenCalled();
  expect(await next.bind(run)).toMatchObject({ ok: false });
  tools.hooks.get('after_tool_call')!({}, context);
  expect(await next.bind(run)).toMatchObject({ ok: true });
  expect(next.factory(run)?.name).toBe(SettingsRuntime.Tool);
  tools.hooks.get('agent_end')!({}, run);
  expect(next.factory(run)?.name).toBe(SettingsRuntime.Tool);
});

test('an untracked writer in a discovery registry blocks settings writes in the gateway registry', async () => {
  const gateway = fixture(), tools = fixture({ implementation: separatePlugin, mode: 'tool-discovery' });
  (globalThis as unknown as Record<symbol, unknown>)[Symbol.for(SettingsRuntime.MemoryLock)] = async (_workspace: string, action: () => Promise<unknown>) => action();
  expect(await gateway.invoke(SettingsRuntime.Status, {})).toMatchObject({ data: { ready: true } });
  tools.policy.evaluate({ toolName: 'exec' }, {});
  expect(await gateway.invoke(SettingsRuntime.Status, {})).toMatchObject({ data: { ready: false } });
  expect(await gateway.invoke(SettingsRuntime.Acquire, { agentId: 'main' })).toMatchObject({ ok: false });
});

test('configuration rotation while awaiting the memory lock cannot grant a stale writer lease', async () => {
  const gateway = fixture();
  let enter!: () => Promise<unknown>;
  (globalThis as unknown as Record<symbol, unknown>)[Symbol.for(SettingsRuntime.MemoryLock)] = async (_workspace: string, action: () => Promise<unknown>) => {
    return await new Promise((resolve, reject) => { enter = () => action().then(resolve, reject); });
  };
  const pending = gateway.invoke(SettingsRuntime.Acquire, { agentId: 'main' });
  fixture({ secret: 'rotated-secret' });
  const entered = enter();
  expect(await pending).toMatchObject({ ok: false });
  await entered;
});

test('the same tool call id in different bound runs remains isolated across shared registries', async () => {
  const gateway = fixture(), tools = fixture({ implementation: separatePlugin, mode: 'tool-discovery' });
  const next = { ...run, runId: 'next-run' };
  await gateway.bind(run); await gateway.bind(next);
  const previousCall = { ...run, toolCallId: 'repeated-id' }, nextCall = { ...next, toolCallId: 'repeated-id' };
  gateway.policy.evaluate({ toolName: SettingsRuntime.Tool }, previousCall);
  gateway.policy.evaluate({ toolName: SettingsRuntime.Tool }, nextCall);
  tools.hooks.get('after_tool_call')!({}, previousCall);
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'current-run' }] }) }));
  vi.stubGlobal('fetch', fetch);
  await expect(tools.factory(next).execute('repeated-id', { action: 'read', section: 'identity' })).resolves.toMatchObject({ content: [{ text: 'current-run' }] });
  expect(JSON.parse((fetch.mock.calls[0] as unknown as [string, { body: string }])[1].body).context).toEqual(nextCall);
});

test('new settings and ordinary writers wait for a retiring ordinary tool even through repeated rotations', async () => {
  const previous = fixture(), writer = { ...run, toolCallId: 'writer' };
  previous.policy.evaluate({ toolName: 'exec' }, writer);
  fixture({ secret: 'second' });
  const current = fixture({ secret: 'third' });
  const nextWriter = { ...writer, runId: 'next-run' };
  expect(current.policy.evaluate({ toolName: 'write' }, nextWriter)).toMatchObject({ block: true });
  expect(await current.invoke(SettingsRuntime.Acquire, { agentId: 'main' })).toMatchObject({ ok: false });
  expect(await current.bind(run)).toMatchObject({ ok: false });
  previous.hooks.get('after_tool_call')!({}, writer);
  expect(current.policy.evaluate({ toolName: 'write' }, nextWriter)).toBeUndefined();
  expect(await current.bind(run)).toMatchObject({ ok: true });
});

test('a retiring settings lease still fences new ordinary tools until its physical memory lock exits', async () => {
  const previous = fixture();
  let lockHeld = false;
  (globalThis as unknown as Record<symbol, unknown>)[Symbol.for(SettingsRuntime.MemoryLock)] = async (_workspace: string, action: () => Promise<unknown>) => {
    lockHeld = true; try { return await action(); } finally { lockHeld = false; }
  };
  const lease = await previous.invoke(SettingsRuntime.Acquire, { agentId: 'main' });
  expect(lease).toMatchObject({ ok: true }); expect(lockHeld).toBe(true);
  const current = fixture({ secret: 'second' }), writer = { ...run, toolCallId: 'writer' };
  expect(current.policy.evaluate({ toolName: 'write' }, writer)).toMatchObject({ block: true });
  expect(await current.invoke(SettingsRuntime.Acquire, { agentId: 'main' })).toMatchObject({ ok: false });
  expect(await previous.invoke(SettingsRuntime.Release, { agentId: 'main', token: (lease.data as { token: string }).token })).toMatchObject({ data: { released: true } });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(lockHeld).toBe(false);
  expect(current.policy.evaluate({ toolName: 'write' }, writer)).toBeUndefined();
});

test('a response body arriving after configuration rotation cannot report a successful tool result', async () => {
  const gateway = fixture(); await gateway.bind(run);
  const context = { ...run, toolCallId: 'call1' };
  gateway.policy.evaluate({ toolName: SettingsRuntime.Tool }, context);
  let finish!: (result: unknown) => void;
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: () => new Promise(resolve => { finish = resolve; }) })));
  const pending = gateway.factory(run).execute('call1', { action: 'read', section: 'identity' });
  await Promise.resolve();
  fixture({ secret: 'second' });
  finish({ content: [{ type: 'text', text: 'stale success' }] });
  await expect(pending).resolves.toMatchObject({ isError: true });
  gateway.hooks.get('after_tool_call')!({}, context);
});
