import { describe, expect, test } from 'vitest';

import { OPENCLAW_MODEL_COMPAT_PLUGIN_ID } from '../../shared/openclawEngine/constants';
import {
  OpenClawModelRuntimeChange,
  type OpenClawModelRuntimeChangeInput,
  resolveOpenClawModelRuntimeChange,
} from './openclawConfigAdmission';

type Config = {
  models: { providers: Record<string, Record<string, unknown>> };
  agents: {
    defaults: { model: { primary: string }; models: Record<string, unknown> };
    entries: Record<string, { model: { primary: string } }>;
  };
  plugins: { entries: Record<string, Record<string, unknown>> };
  bindings?: unknown[];
};

const PLAN_MODEL = 'lobsterai-server/deepseek-flash-YoudaoInner';
const KIMI_MODEL = 'lobsterai-server/kimi-k3-YoudaoInner';
const QWEN_MODEL = 'qwen/qwen3.8-flash';

const baseConfig = (): Config => ({
  models: {
    providers: {
      qwen: {
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        api: 'openai-completions',
        apiKey: '${LOBSTER_APIKEY_QWEN}',
        models: [
          { id: 'qwen3.8-flash', input: ['text', 'image'], contextWindow: 1_000_000 },
          { id: 'qwen3.6-plus', input: ['text'], contextWindow: 1_000_000 },
        ],
      },
      'lobsterai-server': {
        baseUrl: 'http://127.0.0.1:54912/v1',
        api: OPENCLAW_MODEL_COMPAT_PLUGIN_ID,
        apiKey: '${LOBSTER_PROXY_TOKEN}',
        models: [
          { id: 'deepseek-flash-YoudaoInner', api: 'openai-completions' },
          { id: 'kimi-k3-YoudaoInner', api: 'openai-completions', maxTokens: 1_048_576 },
        ],
      },
      openrouter: {
        baseUrl: 'https://openrouter.ai/api',
        api: 'anthropic-messages',
        apiKey: '${LOBSTER_APIKEY_OPENROUTER}',
        models: [{ id: 'anthropic/claude-sonnet-4.6' }],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: PLAN_MODEL },
      models: { [PLAN_MODEL]: {}, [KIMI_MODEL]: {}, [QWEN_MODEL]: {} },
    },
    entries: {
      main: { model: { primary: PLAN_MODEL } },
      'agent-im': { model: { primary: 'qwen/qwen3.6-plus' } },
    },
  },
  plugins: {
    entries: {
      [OPENCLAW_MODEL_COMPAT_PLUGIN_ID]: {
        enabled: true,
        config: {
          modelProfiles: { [KIMI_MODEL]: 'moonshot-kimi-k3' },
          thinkingProfiles: { [PLAN_MODEL]: { levels: ['off', 'high'] } },
        },
      },
    },
  },
});

const env = (): Record<string, string> => ({
  LOBSTER_APIKEY_QWEN: 'qwen-key',
  LOBSTER_PROXY_TOKEN: 'proxy-token',
  LOBSTER_APIKEY_OPENROUTER: 'openrouter-key',
  LOBSTER_FEISHU_APP_SECRET: 'feishu-secret',
});

const resolve = (
  modelRef: string,
  edit: (pending: Config) => void = () => {},
  overrides: Partial<OpenClawModelRuntimeChangeInput> = {},
) => {
  const pending = baseConfig();
  edit(pending);
  return resolveOpenClawModelRuntimeChange({
    modelRef,
    appliedRaw: JSON.stringify(baseConfig()),
    pendingRaw: JSON.stringify(pending),
    appliedSecretEnv: env(),
    pendingSecretEnv: env(),
    ...overrides,
  });
};

describe('resolveOpenClawModelRuntimeChange', () => {
  test('an agent model switch held back by a channel reload does not affect a pinned task', () => {
    const switchAgentModel = (config: Config) => {
      config.agents.entries['agent-im'].model.primary = QWEN_MODEL;
    };
    expect(resolve(QWEN_MODEL, switchAgentModel)).toBe(OpenClawModelRuntimeChange.None);
    expect(resolve(PLAN_MODEL, switchAgentModel)).toBe(OpenClawModelRuntimeChange.None);
  });

  test('changes outside model runtime, such as bindings, admit every task', () => {
    expect(resolve(PLAN_MODEL, config => {
      config.bindings = [{ agentId: 'agent-im', match: { channel: 'telegram' } }];
    })).toBe(OpenClawModelRuntimeChange.None);
  });

  test('provider endpoint changes affect only that provider', () => {
    const moveProxy = (config: Config) => {
      config.models.providers['lobsterai-server'].baseUrl = 'http://127.0.0.1:60001/v1';
    };
    expect(resolve(PLAN_MODEL, moveProxy)).toBe(OpenClawModelRuntimeChange.Provider);
    expect(resolve(QWEN_MODEL, moveProxy)).toBe(OpenClawModelRuntimeChange.None);
  });

  test('model entry changes affect that model but not its siblings', () => {
    const editKimi = (config: Config) => {
      config.models.providers['lobsterai-server'].models = [
        { id: 'deepseek-flash-YoudaoInner', api: 'openai-completions' },
        { id: 'kimi-k3-YoudaoInner', api: 'openai-completions', maxTokens: 32_768 },
      ];
    };
    expect(resolve(KIMI_MODEL, editKimi)).toBe(OpenClawModelRuntimeChange.Model);
    expect(resolve(PLAN_MODEL, editKimi)).toBe(OpenClawModelRuntimeChange.None);
  });

  test('a model the running gateway does not know yet holds its task', () => {
    expect(resolve('qwen/qwen3.9-max', config => {
      (config.models.providers.qwen.models as unknown[]).push({ id: 'qwen3.9-max' });
    })).toBe(OpenClawModelRuntimeChange.Model);
  });

  test('a new provider holds only its own tasks', () => {
    const addProvider = (config: Config) => {
      config.models.providers.custom_1 = { baseUrl: 'https://example.test/v1', models: [{ id: 'm1' }] };
    };
    expect(resolve('custom_1/m1', addProvider)).toBe(OpenClawModelRuntimeChange.Provider);
    expect(resolve(QWEN_MODEL, addProvider)).toBe(OpenClawModelRuntimeChange.None);
  });

  test('per-model agent defaults affect only that model', () => {
    const cacheQwen = (config: Config) => {
      config.agents.defaults.models[QWEN_MODEL] = { params: { cacheRetention: 'short' } };
    };
    expect(resolve(QWEN_MODEL, cacheQwen)).toBe(OpenClawModelRuntimeChange.ModelDefaults);
    expect(resolve(PLAN_MODEL, cacheQwen)).toBe(OpenClawModelRuntimeChange.None);
  });

  test('compatibility profiles affect the profiled model', () => {
    const dropKimiProfile = (config: Config) => {
      const compat = config.plugins.entries[OPENCLAW_MODEL_COMPAT_PLUGIN_ID].config as Record<string, unknown>;
      compat.modelProfiles = {};
    };
    expect(resolve(KIMI_MODEL, dropKimiProfile)).toBe(OpenClawModelRuntimeChange.Compatibility);
    expect(resolve(PLAN_MODEL, dropKimiProfile)).toBe(OpenClawModelRuntimeChange.None);
  });

  test('toggling the compatibility plugin affects the providers it hooks', () => {
    const disableCompat = (config: Config) => {
      config.plugins.entries[OPENCLAW_MODEL_COMPAT_PLUGIN_ID].enabled = false;
    };
    expect(resolve(PLAN_MODEL, disableCompat)).toBe(OpenClawModelRuntimeChange.Compatibility);
    expect(resolve(QWEN_MODEL, disableCompat)).toBe(OpenClawModelRuntimeChange.None);
  });

  test('a changed secret affects only providers that reference it', () => {
    const rotatedQwenKey = { ...env(), LOBSTER_APIKEY_QWEN: 'new-qwen-key' };
    expect(resolve(QWEN_MODEL, undefined, { pendingSecretEnv: rotatedQwenKey }))
      .toBe(OpenClawModelRuntimeChange.Credentials);
    expect(resolve(PLAN_MODEL, undefined, { pendingSecretEnv: rotatedQwenKey }))
      .toBe(OpenClawModelRuntimeChange.None);
    const rotatedImSecret = { ...env(), LOBSTER_FEISHU_APP_SECRET: 'new-feishu-secret' };
    expect(resolve(QWEN_MODEL, undefined, { pendingSecretEnv: rotatedImSecret }))
      .toBe(OpenClawModelRuntimeChange.None);
  });

  test('a model ID with slashes is matched after the provider prefix', () => {
    expect(resolve('openrouter/anthropic/claude-sonnet-4.6', config => {
      config.models.providers.openrouter.models = [{ id: 'anthropic/claude-sonnet-4.6', maxTokens: 64_000 }];
    })).toBe(OpenClawModelRuntimeChange.Model);
  });

  test('an unmatched alias is compared against its whole provider', () => {
    expect(resolve('lobsterai-server/deepseek-flash')).toBe(OpenClawModelRuntimeChange.None);
    expect(resolve('lobsterai-server/deepseek-flash', config => {
      (config.models.providers['lobsterai-server'].models as unknown[]).push({ id: 'glm-5.3-flash-YoudaoInner' });
    })).toBe(OpenClawModelRuntimeChange.Model);
    expect(resolve('lobsterai-server/deepseek-flash', config => {
      const compat = config.plugins.entries[OPENCLAW_MODEL_COMPAT_PLUGIN_ID].config as Record<string, unknown>;
      compat.modelProfiles = {};
    })).toBe(OpenClawModelRuntimeChange.Compatibility);
  });

  test('stays unknown when the effect on the task cannot be inspected', () => {
    expect(resolve('', undefined)).toBe(OpenClawModelRuntimeChange.Unknown);
    expect(resolve('qwen3.8-flash', undefined)).toBe(OpenClawModelRuntimeChange.Unknown);
    expect(resolve(QWEN_MODEL, undefined, { appliedRaw: null })).toBe(OpenClawModelRuntimeChange.Unknown);
    expect(resolve(QWEN_MODEL, undefined, { pendingRaw: null })).toBe(OpenClawModelRuntimeChange.Unknown);
    expect(resolve(QWEN_MODEL, undefined, { appliedRaw: '{not json' })).toBe(OpenClawModelRuntimeChange.Unknown);
    expect(resolve(QWEN_MODEL, undefined, { appliedSecretEnv: null })).toBe(OpenClawModelRuntimeChange.Unknown);
  });
});
