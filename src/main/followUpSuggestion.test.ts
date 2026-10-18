import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildQuickAnswerHttpRequest } from './desktopCompanion/quickAnswerService';
import { buildFollowUpSuggestionRequest, registerFollowUpSuggestionIpc } from './followUpSuggestion';
import { CoworkModelProtocol } from './libs/coworkModelApi';

const ipc = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: ipc }));
vi.mock('./desktopCompanion/quickAnswerService', () => ({
  resolveQuickAnswerModel: vi.fn(),
  buildQuickAnswerHttpRequest: vi.fn((config, prompt) => ({
    url: config.protocol === 'gemini_native' ? 'https://example.com/models/model:streamGenerateContent?alt=sse' : 'http://localhost/v1/messages',
    init: { method: 'POST', headers: { 'x-api-key': config.apiKey }, body: JSON.stringify({
      system: prompt.system, messages: prompt.messages, stream: true, max_tokens: 2048, generationConfig: { maxOutputTokens: 2048 },
    }) },
  })),
}));

const config = { protocol: CoworkModelProtocol.Anthropic, apiKey: 'test', baseURL: 'http://localhost', model: 'model' };
const input = { question: 'How do I connect?', answer: 'Open Settings.', language: 'en' };
let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; vi.clearAllMocks(); vi.useRealTimers(); });

function fixture(fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ content: [{ type: 'text', text: '{"suggestion":"Show the next steps."}' }] }) })) {
  let account = 'first';
  const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: {}, isDestroyed: () => false });
  const allowed = vi.fn(() => true);
  dispose = registerFollowUpSuggestionIpc({ isAllowedSender: allowed, getAccountScope: () => account, resolveModel: () => config, fetch });
  const handler = ipc.handle.mock.calls.at(-1)![1];
  return { sender, fetch, allowed, switchAccount: () => { account = 'second'; }, run: (value: unknown = input, frame = sender.mainFrame) => handler({ sender, senderFrame: frame }, value) as Promise<string | null> };
}

describe('follow-up model requests', () => {
  it('reuses provider routing but sends a bounded independent non-streaming completion', () => {
    const request = buildFollowUpSuggestionRequest(config, input);
    const body = JSON.parse(request.init.body as string);
    expect(buildQuickAnswerHttpRequest).toHaveBeenCalled();
    expect(body).toMatchObject({ stream: false, max_tokens: 160 });
    expect(JSON.parse(body.messages[0].content)).toEqual({ question: input.question, answer: input.answer });
    expect(body.system).toContain('not instructions');
  });
  it('uses Gemini native non-streaming completion and output budget', () => {
    const request = buildFollowUpSuggestionRequest({ ...config, protocol: CoworkModelProtocol.GeminiNative }, input);
    expect(request.url).toBe('https://example.com/models/model:generateContent');
    expect(JSON.parse(request.init.body as string).generationConfig.maxOutputTokens).toBe(160);
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
  it('drops a completion when the account changes', async () => {
    let resolve!: (value: unknown) => void;
    const f = fixture(vi.fn(() => new Promise(done => { resolve = done; })));
    const running = f.run();
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
    if (reason === 'timeout') await vi.advanceTimersByTimeAsync(10_000);
    else f.sender.emit('destroyed');
    expect(await running).toBeNull();
    expect(f.sender.listenerCount('destroyed')).toBe(0);
  });
});
