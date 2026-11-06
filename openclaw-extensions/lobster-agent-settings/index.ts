import { Type } from '@sinclair/typebox';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { listAgentIds } from 'openclaw/plugin-sdk/agent-scope-runtime';

import { isSettingsRunIdentity, type SettingsRunIdentity, SettingsRuntime, SettingsWriterCoordinator, type ToolIdentity } from './coordinator';
import { settingsTranscriptMessage } from './privacy';

type MemoryLock = <T>(workspace: string, action: () => Promise<T>) => Promise<T>;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const memoryLock = (): MemoryLock | undefined => (globalThis as unknown as Record<symbol, MemoryLock>)[Symbol.for(SettingsRuntime.MemoryLock)];
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;

export default {
  id: SettingsRuntime.Plugin,
  name: 'Lobster Agent Settings',
  register(api: OpenClawPluginApi) {
    const config = object(api.pluginConfig);
    if (typeof config.callbackUrl !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+\/agent-settings\/tool$/u.test(config.callbackUrl)
      || typeof config.secret !== 'string' || !config.secret) return;
    const callbackUrl = config.callbackUrl, secret = config.secret;
    const coordinator = new SettingsWriterCoordinator();
    const calls = new Map<string, ToolIdentity>();
    let untrackedWriter = false;
    const key = (sessionKey: string, toolCallId: string): string => JSON.stringify([sessionKey, toolCallId]);

    api.registerTrustedToolPolicy({
      id: SettingsRuntime.Policy,
      description: 'Serialize settings against gateway tools and prevent tool fallback within a settings run.',
      evaluate: (event, context) => {
        const identity = { agentId: context.agentId ?? '', sessionKey: context.sessionKey ?? '', runId: context.runId ?? event.runId ?? '', toolCallId: context.toolCallId ?? event.toolCallId ?? '' };
        // Unsupported harnesses cannot use settings; their presence is not treated as a writer lease.
        if (Object.values(identity).some(value => !identifier(value))) {
          if (event.toolName === SettingsRuntime.Tool) return { block: true, blockReason: 'CONVERSATION_SOURCE_INVALID' };
          untrackedWriter = true;
          return;
        }
        if (event.toolName === SettingsRuntime.Tool && !coordinator.hasRun(identity)) return { block: true, blockReason: 'CONVERSATION_SOURCE_INVALID' };
        if (!coordinator.enter(identity, event.toolName)) return { block: true, blockReason: 'SETTINGS_WRITE_COORDINATION_REQUIRED' };
        if (event.toolName === SettingsRuntime.Tool) calls.set(key(identity.sessionKey, identity.toolCallId), identity);
      },
    });
    api.on('before_message_write', event => ({ message: settingsTranscriptMessage(event.message) }));
    api.on('tool_result_persist', event => ({ message: settingsTranscriptMessage(event.message) }));
    api.on('after_tool_call', (event, context) => {
      const identity = { agentId: context.agentId ?? '', sessionKey: context.sessionKey ?? '', runId: context.runId ?? event.runId ?? '', toolCallId: context.toolCallId ?? event.toolCallId ?? '' };
      coordinator.exit(identity);
      calls.delete(key(identity.sessionKey, identity.toolCallId));
    });
    api.on('agent_end', (_event, context) => {
      if (context.sessionKey && context.runId) {
        coordinator.end({ sessionKey: context.sessionKey, runId: context.runId });
        for (const [callKey, call] of calls) if (call.sessionKey === context.sessionKey && call.runId === context.runId) calls.delete(callKey);
      }
    });
    api.registerGatewayMethod(SettingsRuntime.Status, ({ respond }) => respond(true, { schemaVersion: 1, ready: !untrackedWriter && typeof memoryLock() === 'function' }), { scope: 'operator.admin' });
    api.registerGatewayMethod(SettingsRuntime.BindRun, ({ params, respond }) => {
      try {
        const input = object(params);
        if (Object.keys(input).some(field => !['agentId', 'sessionKey', 'runId'].includes(field))
          || !isSettingsRunIdentity(input)) throw new Error('CONVERSATION_SOURCE_INVALID');
        if (!listAgentIds(api.runtime.config.current()).includes(input.agentId)) throw new Error('AGENT_UNAVAILABLE');
        coordinator.bindRun(input);
        respond(true, { bound: true });
      } catch (error) {
        const reason = error instanceof Error && ['CONVERSATION_SOURCE_INVALID', 'AGENT_UNAVAILABLE', 'SETTINGS_RATE_LIMITED'].includes(error.message)
          ? error.message : 'CONVERSATION_SOURCE_INVALID';
        respond(false, undefined, { code: 'INVALID_REQUEST', message: reason });
      }
    }, { scope: 'operator.admin' });
    api.registerGatewayMethod(SettingsRuntime.Acquire, async ({ params, respond }) => {
      try {
        const input = object(params), lock = memoryLock();
        if (untrackedWriter || !lock || !identifier(input.agentId) || Object.keys(input).some(k => !['agentId', 'sessionKey', 'runId', 'toolCallId'].includes(k))) throw new Error('CONVERSATION_CHANGE_UNAVAILABLE');
        const current = api.runtime.config.current();
        if (!listAgentIds(current).includes(input.agentId)) throw new Error('AGENT_UNAVAILABLE');
        const workspace = api.runtime.agent.resolveAgentWorkspaceDir(current, input.agentId);
        let own: ToolIdentity | undefined;
        if (input.toolCallId !== undefined) {
          if (!identifier(input.sessionKey) || !identifier(input.runId) || !identifier(input.toolCallId)) throw new Error('CONVERSATION_SOURCE_INVALID');
          own = { agentId: input.agentId, sessionKey: input.sessionKey, runId: input.runId, toolCallId: input.toolCallId };
        }
        respond(true, await coordinator.acquire(input.agentId, workspace, lock, own));
      } catch { respond(false, undefined, { code: 'INVALID_REQUEST', message: 'SETTINGS_WRITE_COORDINATION_REQUIRED' }); }
    }, { scope: 'operator.admin' });
    api.registerGatewayMethod(SettingsRuntime.Release, ({ params, respond }) => {
      const input = object(params);
      respond(true, { released: identifier(input.agentId) && identifier(input.token) && coordinator.release(input.agentId, input.token) });
    }, { scope: 'operator.admin' });
    api.registerTool(ctx => {
      // Older runtimes omit runId from tool factories. Hide the tool; never fall back to session-wide authority.
      const run: Partial<SettingsRunIdentity> = { agentId: ctx.agentId, sessionKey: ctx.sessionKey, runId: (ctx as { runId?: string }).runId };
      if (!coordinator.hasRun(run)) return null;
      const sessionKey = run.sessionKey!;
      return {
        name: SettingsRuntime.Tool, label: 'Agent settings',
        description: 'Read or propose a change to this agent identity, long-term memory, or user profile. Use only for an explicit user request. Read the current revision first; preserve unrelated content. Changes require a real confirmation and return a durable receipt. Do not use file, shell, delegation or other tools as a fallback. An unavailable or reconciling result has an unknown outcome; do not claim success or failure and do not repeat the change.',
        parameters: Type.Object({
          action: Type.Union([Type.Literal('read'), Type.Literal('update')]),
          section: Type.Union([Type.Literal('identity'), Type.Literal('memory'), Type.Literal('userProfile')]),
          expectedRevision: Type.Optional(Type.String({ maxLength: 256 })),
          text: Type.Optional(Type.String({ maxLength: 65536 })),
          selection: Type.Optional(Type.Object({ start: Type.Integer({ minimum: 0 }), end: Type.Integer({ minimum: 0 }), expectedText: Type.String({ maxLength: 65536 }) }, { additionalProperties: false })),
          changeKind: Type.Optional(Type.Union([Type.Literal('append'), Type.Literal('replace_selection'), Type.Literal('replace_all'), Type.Literal('clear')])),
        }, { additionalProperties: false }),
        async execute(id: string, params: unknown, signal?: AbortSignal) {
          const context = calls.get(key(sessionKey, id));
          if (!context || context.agentId !== run.agentId || context.runId !== run.runId || !coordinator.hasCall(context)) return { content: [{ type: 'text', text: 'CONVERSATION_SOURCE_INVALID' }], isError: true };
          const timeout = AbortSignal.timeout(150_000);
          try {
            const response = await fetch(callbackUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mcp-bridge-secret': secret },
              body: JSON.stringify({ args: params, context }), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
            if (!response.ok) throw new Error('SETTINGS_UNAVAILABLE');
            return await response.json();
          } catch { return { content: [{ type: 'text', text: 'SETTINGS_UNAVAILABLE: do not claim success or retry through file tools.' }], isError: true }; }
        },
      };
    });
  },
};
