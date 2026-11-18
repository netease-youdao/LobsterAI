import { describe, expect, test, vi } from 'vitest';

import plugin from '../../../openclaw-extensions/lobster-model-routing';
import {
  resolveSpawnModel,
  SESSIONS_SPAWN_TOOL_NAME,
  SPAWN_MODEL_DEFAULT,
} from '../../../openclaw-extensions/lobster-model-routing/spawnModel';

const SESSION_MODEL = 'lobsterai-server/deepseek-v4-flash';

describe('resolveSpawnModel', () => {
  test('same-agent children inherit the requesting run model', () => {
    expect(resolveSpawnModel({
      spawnParams: { task: 'x' },
      requesterAgentId: 'main',
      requesterModel: SESSION_MODEL,
    })).toBe(SESSION_MODEL);
    expect(resolveSpawnModel({
      spawnParams: { agentId: ' Main ', model: 'lobsterai-server/kimi-k2.7-code' },
      requesterAgentId: 'main',
      requesterModel: SESSION_MODEL,
    })).toBe(SESSION_MODEL);
  });

  test('cross-agent children drop the requested model for the target agent model', () => {
    expect(resolveSpawnModel({
      spawnParams: { agentId: 'writer', model: 'lobsterai-server/kimi-k2.7-code' },
      requesterAgentId: 'main',
      requesterModel: SESSION_MODEL,
    })).toBe(SPAWN_MODEL_DEFAULT);
  });

  test('without a known requester model the agent default applies', () => {
    expect(resolveSpawnModel({
      spawnParams: { model: 'moonshot/kimi-k2.6' },
      requesterAgentId: 'main',
    })).toBe(SPAWN_MODEL_DEFAULT);
  });

  test('leaves calls that already carry the right model unchanged', () => {
    expect(resolveSpawnModel({
      spawnParams: { model: SESSION_MODEL },
      requesterAgentId: 'main',
      requesterModel: SESSION_MODEL,
    })).toBeUndefined();
    expect(resolveSpawnModel({ spawnParams: { agentId: 'writer' }, requesterAgentId: 'main' })).toBeUndefined();
    expect(resolveSpawnModel({ spawnParams: { agentId: 'writer', model: 'Default' } })).toBeUndefined();
  });

  test('leaves ACP harness spawns alone', () => {
    expect(resolveSpawnModel({
      spawnParams: { runtime: 'acp', model: 'codex/gpt-5.5' },
      requesterAgentId: 'main',
      requesterModel: SESSION_MODEL,
    })).toBeUndefined();
  });
});

describe('sessions_spawn hook', () => {
  const register = (pluginConfig?: Record<string, unknown>) => {
    const hooks = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    plugin.register({
      pluginConfig,
      on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      logger: { info: vi.fn(), warn: vi.fn() },
    } as unknown as Parameters<typeof plugin.register>[0]);
    return (name: string) => hooks.get(name)![0];
  };

  test('rewrites the spawn model to the virtual preset the run selected, even without the proxy', async () => {
    const hook = register();
    await hook('before_model_resolve')({ prompt: 'hi' }, {
      runId: 'run-1', agentId: 'main', modelProviderId: 'lobsterai-server', modelId: 'yd-fast',
    });
    expect(await hook('before_tool_call')({
      toolName: SESSIONS_SPAWN_TOOL_NAME,
      params: { task: 'x', model: 'lobsterai-server/kimi-k2.7-code' },
    }, { runId: 'run-1', agentId: 'main', toolName: SESSIONS_SPAWN_TOOL_NAME })).toEqual({
      params: { model: 'lobsterai-server/yd-fast' },
    });
  });

  test('ignores other tools', async () => {
    const hook = register();
    expect(await hook('before_tool_call')({ toolName: 'exec', params: { model: 'x' } }, { runId: 'r' })).toBeUndefined();
  });
});
