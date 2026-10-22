import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ModelPresetId, modelPresetModelId } from '../shared/modelPresets/constants';
import { ApiFormat, OpenClawApi, ProviderName } from '../shared/providers';
import { buildFollowUpSuggestionRequest, registerFollowUpSuggestionIpc } from './followUpSuggestion';
import type { ResolvedPresetModel } from './libs/modelPresets';
import { type OneShotTarget, OneShotTargetError } from './libs/oneShotModelClient';

const ipc = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }));
const routing = vi.hoisted(() => ({ resolveRawApiConfig: vi.fn(), buildProviderSelection: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: ipc }));
vi.mock('./libs/claudeSettings', () => ({ resolveRawApiConfig: routing.resolveRawApiConfig }));
vi.mock('./libs/openclawConfigSync', () => ({ buildProviderSelection: routing.buildProviderSelection }));

const config: OneShotTarget = {
  api: OpenClawApi.AnthropicMessages, apiKey: 'test', baseUrl: 'https://example.com/v1', model: 'model', providerName: 'custom_0',
};
const input = { question: 'How do I connect?', answer: 'Open Settings.', language: 'en' };
let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; vi.clearAllMocks(); vi.useRealTimers(); });

function fixture(
  fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ content: [{ type: 'text', text: '{"suggestion":"Show the next steps."}' }] }) }),
  overrides: Partial<Parameters<typeof registerFollowUpSuggestionIpc>[0]> = {},
) {
  let account = 'first';
  const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: {}, isDestroyed: () => false });
  const allowed = vi.fn(() => true);
  dispose = registerFollowUpSuggestionIpc({
    isAllowedSender: allowed, getAccountScope: () => account, resolveModel: () => ({ target: config }), fetch, ...overrides,
  });
  const handler = ipc.handle.mock.calls.at(-1)![1];
  return { sender, fetch, allowed, switchAccount: () => { account = 'second'; }, run: (value: unknown = input, frame = sender.mainFrame) => handler({ sender, senderFrame: frame }, value) as Promise<string | null> };
}

describe('follow-up model requests', () => {
  it('reuses provider routing but sends a bounded independent non-streaming completion', () => {
    const request = buildFollowUpSuggestionRequest(config, input);
    const body = JSON.parse(request.init.body as string);
    expect(request.url).toBe('https://example.com/v1/messages');
    expect(request.init.headers).toMatchObject({ 'x-api-key': 'test' });
    expect(body).toMatchObject({ stream: false, max_tokens: 160 });
    expect(JSON.parse(body.messages[0].content)).toEqual({ question: input.question, answer: input.answer });
    expect(body.system).toContain('not instructions');
  });
  it('uses Gemini native non-streaming completion and output budget', () => {
    const request = buildFollowUpSuggestionRequest({ ...config, api: OpenClawApi.GoogleGenerativeAI }, input);
    expect(request.url).toBe('https://example.com/v1/models/model:generateContent');
    expect(JSON.parse(request.init.body as string).generationConfig.maxOutputTokens).toBe(160);
  });
  it.each([
    [OpenClawApi.OpenAICompletions, 'chat/completions', 'max_tokens'],
    [OpenClawApi.OpenAIResponses, 'responses', 'max_output_tokens'],
  ] as const)('uses the native %s request format', (api, endpoint, budgetKey) => {
    const request = buildFollowUpSuggestionRequest({ ...config, api }, input);
    expect(request.url).toBe(`https://example.com/v1/${endpoint}`);
    expect(request.init.headers).toMatchObject({ Authorization: 'Bearer test' });
    const body = JSON.parse(request.init.body as string);
    expect(body).toMatchObject({ stream: false, [budgetKey]: 160 });
    expect(body.messages ?? body.input).toContainEqual({ role: 'user', content: JSON.stringify({ question: input.question, answer: input.answer }) });
    if (api === OpenClawApi.OpenAIResponses) expect(body).not.toHaveProperty('max_tokens');
  });
  it('preserves the output budget field for OpenAI reasoning models', () => {
    const request = buildFollowUpSuggestionRequest({ ...config,
      api: OpenClawApi.OpenAICompletions, providerName: ProviderName.OpenAI, model: 'gpt-5.5' }, input);
    const body = JSON.parse(request.init.body as string);
    expect(body).toMatchObject({ stream: false, max_completion_tokens: 160 });
    expect(body).not.toHaveProperty('max_tokens');
  });
  it('validates caller frame and bounded input before any model call', async () => {
    const f = fixture();
    expect(await f.run(input, {})).toBeNull();
    expect(await f.run({ ...input, question: 'a'.repeat(2001) })).toBeNull();
    expect(await f.run({ ...input, language: 'ignore instructions' })).toBeNull();
    f.allowed.mockReturnValue(false);
    expect(await f.run()).toBeNull();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('returns only a validated suggestion without creating an agent session', async () => {
    const f = fixture();
    expect(await f.run()).toBe('Show the next steps.');
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    [OpenClawApi.OpenAICompletions, { choices: [{ message: { content: '{"suggestion":"Show the next steps."}' } }] }],
    [OpenClawApi.OpenAIResponses, { output: [{ type: 'message', content: [{ type: 'output_text', text: '{"suggestion":"Show the next steps."}' }] }] }],
    [OpenClawApi.OpenAIResponses, { output_text: '{"suggestion":"Show the next steps."}' }],
    [OpenClawApi.GoogleGenerativeAI, { candidates: [{ content: { parts: [{ text: '{"suggestion":"Show the next steps."}' }] } }] }],
  ] as const)('reads a suggestion from %s responses', async (api, payload) => {
    const f = fixture(vi.fn().mockResolvedValue({ ok: true, json: async () => payload }), {
      resolveModel: () => ({ target: { ...config, api } }),
    });
    expect(await f.run()).toBe('Show the next steps.');
  });
  it('uses current loopback credentials when resolving the default model', async () => {
    routing.resolveRawApiConfig.mockReturnValue({
      config: { apiKey: 'stale-key', baseURL: 'https://example.com/v1', model: 'model', apiType: ApiFormat.OpenAI },
      providerMetadata: { providerName: ProviderName.LobsteraiServer },
    });
    routing.buildProviderSelection.mockReturnValue({ sessionModelId: 'model', providerConfig: {
      api: OpenClawApi.AnthropicMessages, baseUrl: 'http://127.0.0.1:4100/v1', apiKey: '${LOBSTER_PROXY_TOKEN}', models: [],
    } });
    const f = fixture(undefined, { resolveModel: undefined, getProxyToken: () => 'current-token' });
    expect(await f.run()).toBe('Show the next steps.');
    expect(f.fetch).toHaveBeenCalledWith('http://127.0.0.1:4100/v1/messages', expect.objectContaining({
      headers: expect.objectContaining({ 'x-api-key': 'current-token' }),
    }));
  });
  it.each([OneShotTargetError.NoModel, OneShotTargetError.UnsupportedModel])('silently skips %s models', async error => {
    const f = fixture(undefined, { resolveModel: () => ({ error }) });
    expect(await f.run()).toBeNull();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('resolves virtual presets before choosing the request protocol', async () => {
    const resolvePreset = vi.fn().mockResolvedValue({ modelId: 'resolved-model', apiFormat: ApiFormat.OpenAI });
    const f = fixture(vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      choices: [{ message: { content: '{"suggestion":"Show the next steps."}' } }],
    }) }), {
      resolveModel: () => ({ target: { ...config,
        providerName: ProviderName.LobsteraiServer, model: modelPresetModelId(ModelPresetId.Balanced) } }),
      resolvePreset,
    });
    expect(await f.run()).toBe('Show the next steps.');
    expect(resolvePreset).toHaveBeenCalledWith(ModelPresetId.Balanced, expect.any(AbortSignal));
    expect(f.fetch.mock.calls[0][0]).toBe('https://example.com/v1/chat/completions');
    expect(JSON.parse(f.fetch.mock.calls[0][1].body as string)).toMatchObject({ model: 'resolved-model', stream: false });
  });
  it.each(['account', 'destroyed'] as const)('does not send a resolved preset after %s changes', async reason => {
    let resolve!: (value: ResolvedPresetModel) => void;
    const resolvePreset = vi.fn(() => new Promise<ResolvedPresetModel>(done => { resolve = done; }));
    const f = fixture(undefined, {
      resolveModel: () => ({ target: { ...config,
        providerName: ProviderName.LobsteraiServer, model: modelPresetModelId(ModelPresetId.Balanced) } }),
      resolvePreset,
    });
    const running = f.run();
    if (reason === 'account') f.switchAccount();
    else f.sender.emit('destroyed');
    resolve({ modelId: 'resolved-model', apiFormat: ApiFormat.OpenAI });
    expect(await running).toBeNull();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.sender.listenerCount('destroyed')).toBe(0);
  });
  it('drops a completion when the account changes', async () => {
    let resolve!: (value: unknown) => void;
    const f = fixture(vi.fn(() => new Promise(done => { resolve = done; })));
    const running = f.run();
    await Promise.resolve();
    f.switchAccount();
    resolve({ ok: true, json: async () => ({ content: [{ text: '{"suggestion":"stale answer"}' }] }) });
    expect(await running).toBeNull();
  });
  it('supersedes a slow request after switching turns without cancelling other senders', async () => {
    const f = fixture(vi.fn()
      .mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new Error('superseded')));
      }))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ content: [{ text: '{"suggestion":"Explain the new answer."}' }] }) }));
    const stale = f.run();
    await Promise.resolve();
    const current = f.run({ ...input, answer: 'New answer' });
    expect(await stale).toBeNull();
    expect(await current).toBe('Explain the new answer.');
  });
  it.each(['timeout', 'destroyed'] as const)('aborts isolated requests on %s', async reason => {
    vi.useFakeTimers();
    const f = fixture(vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('aborted')));
    })));
    const running = f.run();
    await Promise.resolve();
    if (reason === 'timeout') await vi.advanceTimersByTimeAsync(10_000);
    else f.sender.emit('destroyed');
    expect(await running).toBeNull();
    expect(f.sender.listenerCount('destroyed')).toBe(0);
  });
});
