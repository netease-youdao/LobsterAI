import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { buildSync } from 'esbuild';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import type { StreamFn } from 'openclaw/plugin-sdk/agent-core';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import type modelCompatPlugin from '../../../openclaw-extensions/lobsterai-model-compat/index';
import { LobsterAIModelRuntimeProfile } from '../../../openclaw-extensions/lobsterai-model-compat/profileMapping';
import {
  LOBSTERAI_REQUEST_OPTIONS_FIELD,
  LOBSTERAI_REQUEST_OPTIONS_VERSION,
} from '../../../openclaw-extensions/lobsterai-model-compat/requestOptionsProtocol';
import { LobsterAIThinkingLevel } from '../../../openclaw-extensions/lobsterai-model-compat/thinkingProfileMapping';

type Provider = Parameters<OpenClawPluginApi['registerProvider']>[0];
type StreamOptions = NonNullable<Parameters<StreamFn>[2]>;
type OnPayload = NonNullable<StreamOptions['onPayload']>;

const nativeRequire = createRequire(import.meta.url);
const model = {
  api: 'openai-completions',
  provider: 'custom_0',
  id: 'My-K3/Alias',
  reasoning: false,
  baseUrl: 'https://model-gateway.invalid/v1',
} as Parameters<StreamFn>[0];
const context = { messages: [], systemPrompt: 'Keep the original context' };
const modelRef = `${model.provider}/${model.id}`;
const explicitProfile = {
  modelProfiles: { [modelRef]: LobsterAIModelRuntimeProfile.MoonshotKimiK3 },
};
const streamResult = {} as Awaited<ReturnType<StreamFn>>;
const pinnedToolChoice = { type: 'function', function: { name: 'read' } };
let plugin: typeof modelCompatPlugin;
let fixtureDir: string;
let defaultStreamKey: symbol;
let defaultLoadsKey: symbol;
const runtimeGlobal = globalThis as typeof globalThis & Record<symbol, unknown>;

beforeAll(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-model-compat-'));
  const sdkDir = path.join(fixtureDir, 'node_modules/openclaw');
  fs.mkdirSync(sdkDir, { recursive: true });
  defaultStreamKey = Symbol.for(`${fixtureDir}/streamSimple`);
  defaultLoadsKey = Symbol.for(`${fixtureDir}/llm-loads`);
  runtimeGlobal[defaultLoadsKey] = 0;
  fs.writeFileSync(path.join(sdkDir, 'package.json'), JSON.stringify({
    type: 'module',
    exports: {
      './plugin-sdk/provider-model-shared': './provider-model-shared.js',
      './plugin-sdk/provider-stream-shared': './provider-stream-shared.js',
      './plugin-sdk/llm': './llm.js',
    },
  }));
  fs.writeFileSync(path.join(sdkDir, 'provider-model-shared.js'), `
    export const buildAnthropicReplayPolicyForModel = () => ({});
    export const buildGoogleGeminiReplayPolicy = () => ({});
    export const buildOpenAICompatibleReplayPolicy = () => ({});
  `);
  // Model the current public SDK surface: the retired K3 export is absent.
  fs.writeFileSync(path.join(sdkDir, 'provider-stream-shared.js'), `
    export const createMoonshotThinkingWrapper = () => { throw new Error('Native-name wrapper must not handle explicit aliases'); };
  `);
  fs.writeFileSync(path.join(sdkDir, 'llm.js'), `
    globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(defaultLoadsKey))})] += 1;
    export const streamSimple = (...args) => globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(defaultStreamKey))})](...args);
  `);
  const entry = path.join(fixtureDir, 'index.mjs');
  buildSync({
    entryPoints: [path.resolve(__dirname, '../../../openclaw-extensions/lobsterai-model-compat/index.ts')],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: ['openclaw/plugin-sdk', 'openclaw/plugin-sdk/*'],
    logLevel: 'silent',
  });
  // Native require(ESM) checks named exports without Vitest/Jiti module transforms.
  plugin = nativeRequire(entry).default;
});

afterAll(() => {
  delete runtimeGlobal[defaultStreamKey];
  delete runtimeGlobal[defaultLoadsKey];
  if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
});

const registerProvider = (pluginConfig: Record<string, unknown> = explicitProfile): Provider => {
  const register = vi.fn();
  plugin.register({ pluginConfig, registerProvider: register } as never);
  expect(register).toHaveBeenCalledOnce();
  return register.mock.calls[0][0];
};

const wrap = (
  streamFn: StreamFn | undefined,
  pluginConfig = explicitProfile as Record<string, unknown>,
  streamModel = model,
  thinkingLevel?: string,
): StreamFn | undefined => registerProvider(pluginConfig).wrapStreamFn?.({
  streamFn,
  provider: streamModel.provider,
  modelId: streamModel.id,
  model: streamModel,
  thinkingLevel,
} as never);

const createPayload = (): Record<string, unknown> => ({
  model: model.id,
  messages: [
    { role: 'assistant', tool_calls: [{ id: 'missing-reasoning', type: 'function' }] },
    { role: 'assistant', tool_calls: [{ id: 'native-reasoning' }], reasoning_content: 'keep me' },
    { role: 'assistant', tool_calls: [{ id: 'explicit-null' }], reasoning_content: null },
    { role: 'assistant', tool_calls: [] },
    { role: 'assistant', content: 'plain answer' },
    { role: 'user', tool_calls: [{ id: 'not-assistant' }] },
  ],
  thinking: { type: 'disabled' },
  reasoningEffort: 'low',
  reasoning_effort: 'low',
  temperature: 0,
  top_p: 0.5,
  n: 2,
  presence_penalty: 1,
  frequency_penalty: 1,
  tool_choice: pinnedToolChoice,
  custom_field: 'retain',
});

const expectK3Payload = (payload: unknown): void => {
  expect(payload).toEqual({
    model: model.id,
    messages: [
      { role: 'assistant', tool_calls: [{ id: 'missing-reasoning', type: 'function' }], reasoning_content: '' },
      { role: 'assistant', tool_calls: [{ id: 'native-reasoning' }], reasoning_content: 'keep me' },
      { role: 'assistant', tool_calls: [{ id: 'explicit-null' }], reasoning_content: null },
      { role: 'assistant', tool_calls: [] },
      { role: 'assistant', content: 'plain answer' },
      { role: 'user', tool_calls: [{ id: 'not-assistant' }] },
    ],
    reasoning_effort: 'max',
    tool_choice: pinnedToolChoice,
    custom_field: 'retain',
  });
};

const runPayload = async (params: {
  callback?: OnPayload;
  payload?: unknown;
  pluginConfig?: Record<string, unknown>;
  thinkingLevel?: string;
} = {}) => {
  const payload = 'payload' in params ? params.payload : createPayload();
  let callbackResult: unknown;
  let finalPayload: unknown;
  const baseStream: StreamFn = async (streamModel, streamContext, options) => {
    expect(streamModel).toEqual({ ...model, reasoning: true });
    expect(streamContext).toBe(context);
    expect(options).toMatchObject({ reasoning: 'max', maxTokens: 127 });
    callbackResult = options?.onPayload?.(payload, streamModel);
    finalPayload = await callbackResult ?? payload;
    return streamResult;
  };
  const wrapped = wrap(baseStream, params.pluginConfig, model, params.thinkingLevel);
  expect(await wrapped!(model, context, { onPayload: params.callback, reasoning: 'low', maxTokens: 127 })).toBe(streamResult);
  expect(model.reasoning).toBe(false);
  return { payload, callbackResult, finalPayload };
};

describe('lobsterai-model-compat native entry and explicit K3 policy', () => {
  test('loads without the retired SDK export or eager default transport', () => {
    expect(plugin.id).toBe('lobsterai-model-compat');
    expect(registerProvider().id).toBe('lobsterai-model-compat');
    expect(runtimeGlobal[defaultLoadsKey]).toBe(0);
  });

  test('keeps the alias and pinned tool choice and only fills missing tool reasoning', async () => {
    const { callbackResult, finalPayload } = await runPayload();
    expect(callbackResult).toBeUndefined();
    expectK3Payload(finalPayload);
  });

  test.each([false, true])('reapplies policy after caller mutation (async=%s)', async (isAsync) => {
    const callback = vi.fn((payload: unknown, payloadModel: Parameters<StreamFn>[0]) => {
      expectK3Payload(payload);
      expect(payloadModel.id).toBe(model.id);
      expect(payloadModel.provider).toBe(model.provider);
      Object.assign(payload as object, createPayload());
      return isAsync ? Promise.resolve() : undefined;
    });
    const { payload, callbackResult, finalPayload } = await runPayload({ callback });
    expect(callback).toHaveBeenCalledOnce();
    expect(callbackResult instanceof Promise).toBe(isAsync);
    expect(finalPayload).toBe(payload);
    expectK3Payload(finalPayload);
  });

  test.each([false, true])('sanitizes caller replacement and preserves its identity (async=%s)', async (isAsync) => {
    const replacement = createPayload();
    const callback = vi.fn((payload: unknown) => {
      expectK3Payload(payload);
      return isAsync ? Promise.resolve(replacement) : replacement;
    });
    const { callbackResult, finalPayload } = await runPayload({ callback });
    expect(callback).toHaveBeenCalledOnce();
    expect(callbackResult instanceof Promise).toBe(isAsync);
    expect(finalPayload).toBe(replacement);
    expectK3Payload(finalPayload);
  });

  test('awaits caller thenables before applying the final policy', async () => {
    const replacement = createPayload();
    const callback = () => ({ then: (resolve: (value: unknown) => void) => resolve(replacement) });
    const { finalPayload } = await runPayload({ callback: callback as OnPayload });
    expect(finalPayload).toBe(replacement);
    expectK3Payload(finalPayload);
  });

  test.each([
    { label: 'undefined', payload: undefined },
    { label: 'null', payload: null },
    { label: 'string', payload: 'text' },
    { label: 'array', payload: [] },
  ])('passes non-record $label payload directly to the caller', async ({ payload }) => {
    const replacement = { untouched: true };
    const callback = vi.fn(() => replacement);
    const { finalPayload } = await runPayload({ callback, payload });
    expect(callback).toHaveBeenCalledWith(payload, expect.objectContaining({ id: model.id, provider: model.provider }));
    expect(finalPayload).toBe(replacement);
    expect(finalPayload).toEqual({ untouched: true });
  });

  test.each([
    { label: 'null', result: null },
    { label: 'false', result: false },
    { label: 'string', result: 'caller-value' },
    { label: 'array', result: [] },
  ])('preserves non-record $label callback result', async ({ result }) => {
    const { payload, callbackResult } = await runPayload({ callback: () => result });
    expect(callbackResult).toBe(result);
    expectK3Payload(payload);
  });

  test.each([false, true])('propagates caller failures unchanged (async=%s)', async (isAsync) => {
    const failure = new Error('caller failed');
    const callback = () => {
      if (isAsync) return Promise.reject(failure);
      throw failure;
    };
    await expect(runPayload({ callback })).rejects.toBe(failure);
  });

  test('invokes a supplied synchronous stream immediately and preserves its result', async () => {
    const stream = vi.fn(() => streamResult);
    const wrapped = wrap(stream)!;
    const result = wrapped(model, context);
    expect(stream).toHaveBeenCalledOnce();
    // The retired K3 wrapper is async even when its supplied transport is sync.
    expect(result).toBeInstanceOf(Promise);
    expect(await result).toBe(streamResult);
  });

  test.each([false, true])('preserves transport failure rejection (async=%s)', async (isAsync) => {
    const failure = new Error('transport failed');
    const stream = vi.fn(() => {
      if (isAsync) return Promise.reject(failure);
      throw failure;
    });
    const result = wrap(stream)!(model, context);
    expect(stream).toHaveBeenCalledOnce();
    expect(result).toBeInstanceOf(Promise);
    await expect(result).rejects.toBe(failure);
  });

  test.each([{}, { modelProfiles: { [modelRef]: 'unknown-profile' } }])('passes through unmapped and unknown profiles', (config) => {
    const stream = vi.fn(() => streamResult);
    expect(wrap(stream, config)).toBe(stream);
    expect(wrap(undefined, config)).toBeUndefined();
    expect(wrap(stream, config, { ...model, provider: 'moonshot', id: 'kimi-k3' })).toBe(stream);
  });

  test('keeps exact profile matching and the OpenAI transport guard', () => {
    const stream = vi.fn(() => streamResult);
    expect(wrap(stream, explicitProfile, { ...model, id: model.id.toLowerCase() })).toBe(stream);
    expect(() => wrap(stream, explicitProfile, { ...model, api: 'anthropic-messages' })).toThrow('requires openai-completions');
  });

  test('retains the versioned thinking request options when the callback replaces the payload', async () => {
    const replacement = createPayload();
    const { finalPayload } = await runPayload({
      callback: async () => replacement,
      thinkingLevel: 'high',
      pluginConfig: {
        ...explicitProfile,
        thinkingProfiles: {
          [modelRef]: {
            options: [{ level: LobsterAIThinkingLevel.High, openclawLevel: 'high' }],
            defaultLevel: LobsterAIThinkingLevel.High,
            requestOptionsVersion: LOBSTERAI_REQUEST_OPTIONS_VERSION,
          },
        },
      },
    });
    expect(finalPayload).toBe(replacement);
    expect(replacement[LOBSTERAI_REQUEST_OPTIONS_FIELD]).toEqual({
      version: LOBSTERAI_REQUEST_OPTIONS_VERSION,
      thinking: { level: LobsterAIThinkingLevel.High },
    });
    const { [LOBSTERAI_REQUEST_OPTIONS_FIELD]: _options, ...k3Payload } = replacement;
    expectK3Payload(k3Payload);
  });

  test('loads the public default transport lazily and applies the same policy', async () => {
    expect(runtimeGlobal[defaultLoadsKey]).toBe(0);
    const stream = vi.fn(async (streamModel, streamContext, options) => {
      expect(streamModel).toEqual({ ...model, reasoning: true });
      expect(streamContext).toBe(context);
      expect(options.reasoning).toBe('max');
      const payload = createPayload();
      expect(await options.onPayload(payload, streamModel)).toBeUndefined();
      expectK3Payload(payload);
      return streamResult;
    });
    runtimeGlobal[defaultStreamKey] = stream;
    const wrapped = wrap(undefined)!;
    expect(runtimeGlobal[defaultLoadsKey]).toBe(0);
    expect(await wrapped(model, context)).toBe(streamResult);
    expect(await wrapped(model, context)).toBe(streamResult);
    expect(stream).toHaveBeenCalledTimes(2);
    expect(runtimeGlobal[defaultLoadsKey]).toBe(1);
  });
});
