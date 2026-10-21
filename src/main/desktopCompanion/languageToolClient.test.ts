import { describe, expect, test, vi } from 'vitest';

import { CompanionAnalyticsOutcome as Outcome, CompanionAnalyticsStage as Stage } from '../../shared/desktopCompanion/analytics';
import { LANGUAGE_TOOL_DEVICE_HEADER, LanguageTool, LanguageToolCode, type LanguageToolEvent, LanguageToolEventType, TranslationTarget } from '../../shared/desktopCompanion/languageTools';
import { CompanionLanguageClient } from './languageToolClient';

const request = { requestId: '00000000-1111-2222-3333-444444444444', tool: LanguageTool.Translate,
  text: 'Hello', targetLanguage: TranslationTarget.Chinese };
const sse = (text: string) => new Response(text, { headers: { 'content-type': 'text/event-stream' } });
const delta = `event: delta\ndata: ${JSON.stringify({ text: '你好', language: TranslationTarget.Chinese })}\n\n`;
const done = 'event: done\ndata: {}\n\n';
const drain = () => new Promise(resolve => setTimeout(resolve, 15));

const deviceId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const deviceDeps = { getInstallationId: () => deviceId, fetchAnonymous: vi.fn() };

describe('desktop language tools', () => {
  test.each([Outcome.Success, Outcome.Failed, Outcome.Cancelled])('counts one %s result without SSE text, audio or raw error codes', async outcome => {
    const reportAnalytics = vi.fn();
    let release!: (response: Response) => void;
    const client = new CompanionLanguageClient({ ...deviceDeps, reportAnalytics,
      fetchWithAuth: () => new Promise(resolve => { release = resolve; }),
      getSessionKey: () => 'account', getServerApiBaseUrl: () => 'https://private.example',
    });
    client.start({ ...request, text: 'private selection' }, vi.fn());
    if (outcome === Outcome.Cancelled) client.abort(request.requestId);
    release(outcome === Outcome.Failed ? sse('event: error\ndata: {"code":123456}\n\n') : sse(delta + done));
    await drain();
    client.reset();
    expect(reportAnalytics.mock.calls.map(([event]) => event.stage)).toEqual([Stage.Submit, Stage.Result]);
    expect(reportAnalytics.mock.lastCall?.[0]).toMatchObject({ outcome, tool: LanguageTool.Translate });
    expect(JSON.stringify(reportAnalytics.mock.calls)).not.toMatch(/private|你好|123456/);
  });
  test('requires a session before any TTS request', () => {
    const tool = LanguageTool.Tts;
    const fetchWithAuth = vi.fn();
    const client = new CompanionLanguageClient({ ...deviceDeps, fetchWithAuth, getSessionKey: () => null, getServerApiBaseUrl: () => 'http://localhost' });
    expect(client.start({ ...request, tool }, vi.fn())).toEqual({ success: false, code: LanguageToolCode.Unauthorized });
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  test('decodes UTF-8 across chunks and uses the authenticated local server', async () => {
    const bytes = new TextEncoder().encode(delta + done);
    const fetchWithAuth = vi.fn(async () => new Response(new ReadableStream({
      start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); },
    }), { headers: { 'content-type': 'text/event-stream' } }));
    const client = new CompanionLanguageClient({ ...deviceDeps, fetchWithAuth, getSessionKey: () => 'user1', getServerApiBaseUrl: () => 'http://127.0.0.1:18878' });
    const events: LanguageToolEvent[] = [];
    expect(client.start(request, event => events.push(event)).success).toBe(true);
    await drain();
    expect(fetchWithAuth).toHaveBeenCalledWith('http://127.0.0.1:18878/api/desktop-tools/translate', expect.objectContaining({ method: 'POST' }));
    expect(events.map(event => event.type)).toEqual([LanguageToolEventType.Delta, LanguageToolEventType.Done]);
    expect(events[0]).toMatchObject({ requestId: request.requestId, text: '你好' });
  });

  test('reports early JSON quota errors and incomplete SSE streams', async () => {
    for (const [response, code] of [
      [Response.json({ code: LanguageToolCode.DailyLimit }), LanguageToolCode.DailyLimit],
      [sse(delta), LanguageToolCode.Upstream],
    ] as const) {
      const client = new CompanionLanguageClient({ ...deviceDeps, fetchWithAuth: async () => response, getSessionKey: () => 'user1', getServerApiBaseUrl: () => 'http://localhost' });
      const events: LanguageToolEvent[] = [];
      client.start(request, event => events.push(event));
      await drain();
      expect(events[events.length - 1]).toMatchObject({ type: LanguageToolEventType.Error, code });
    }
  });

  test('cancellation and account switches suppress late results', async () => {
    for (const switchAccount of [true, false]) {
      let session = 'user1';
      let release!: (response: Response) => void;
      const client = new CompanionLanguageClient({ ...deviceDeps, fetchWithAuth: () => new Promise(resolve => { release = resolve; }),
        getSessionKey: () => session, getServerApiBaseUrl: () => 'http://localhost' });
      const send = vi.fn();
      client.start(request, send);
      if (switchAccount) session = 'user2'; else client.abort(request.requestId);
      release(sse(delta + done));
      await drain();
      expect(send).not.toHaveBeenCalled();
    }
  });
});


test('guest translation sends the persistent UUID and omits cookies without invoking auth', async () => {
  const fetchAnonymous = vi.fn(async () => sse(delta + done));
  const fetchWithAuth = vi.fn();
  const client = new CompanionLanguageClient({ ...deviceDeps, fetchAnonymous, fetchWithAuth,
    getSessionKey: () => null, getServerApiBaseUrl: () => 'http://localhost' });
  const events: LanguageToolEvent[] = [];
  expect(client.start(request, event => events.push(event)).success).toBe(true);
  await drain();
  expect(events.map(event => event.type)).toEqual([LanguageToolEventType.Delta, LanguageToolEventType.Done]);
  expect(fetchAnonymous).toHaveBeenCalledWith(expect.stringContaining('/translate'), expect.objectContaining({
    credentials: 'omit', headers: expect.objectContaining({ [LANGUAGE_TOOL_DEVICE_HEADER]: deviceId }),
  }));
  expect(fetchWithAuth).not.toHaveBeenCalled();
});

test('authenticated rejection never falls back to anonymous transport', async () => {
  const fetchAnonymous = vi.fn();
  const fetchWithAuth = vi.fn(async () => Response.json({ code: LanguageToolCode.Unauthorized }, { status: 401 }));
  const client = new CompanionLanguageClient({ ...deviceDeps, fetchAnonymous, fetchWithAuth,
    getSessionKey: () => 'user1', getServerApiBaseUrl: () => 'http://localhost' });
  const send = vi.fn(); client.start(request, send); await drain();
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ code: LanguageToolCode.Unauthorized }));
  expect(fetchWithAuth).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
    headers: expect.objectContaining({ [LANGUAGE_TOOL_DEVICE_HEADER]: deviceId }),
  }));
  expect(fetchAnonymous).not.toHaveBeenCalled();
});

test('guest quota is translation-only and server authentication rejection requests sign-in', async () => {
  const fetchAnonymous = vi.fn(async () => Response.json({ code: 0, data: { tools: { translate: { limitRequests: 1000 } } } }));
  const client = new CompanionLanguageClient({ ...deviceDeps, fetchAnonymous, fetchWithAuth: vi.fn(),
    getSessionKey: () => null, getServerApiBaseUrl: () => 'http://localhost' });
  expect(await client.quota(LanguageTool.Translate)).toMatchObject({ success: true });
  expect(fetchAnonymous).toHaveBeenCalledWith('http://localhost/api/desktop-tools/translate/quota', expect.objectContaining({
    headers: { [LANGUAGE_TOOL_DEVICE_HEADER]: deviceId }, credentials: 'omit',
  }));
  expect(await client.quota(LanguageTool.Tts)).toEqual({ success: false, code: LanguageToolCode.Unauthorized });
  fetchAnonymous.mockImplementation(async () => Response.json({ code: 401 }, { status: 401 }));
  expect(await client.quota(LanguageTool.Translate)).toEqual({ success: false, code: LanguageToolCode.Unauthorized });
  fetchAnonymous.mockImplementation(async () => new Response('Unauthorized', { status: 401 }));
  expect(await client.quota(LanguageTool.Translate)).toEqual({ success: false, code: LanguageToolCode.Unauthorized });
});

test.each([
  { status: 401, code: 401 },
  { status: 401, code: LanguageToolCode.Unauthorized },
  { status: 401, code: undefined },
  { status: 200, code: 401 },
  { status: 200, code: LanguageToolCode.Unauthorized },
])('guest translation requests sign-in for authentication rejection $status/$code', async ({ status, code }) => {
  const fetchAnonymous = vi.fn(async () => code === undefined
    ? new Response('Unauthorized', { status }) : Response.json({ code }, { status }));
  const fetchWithAuth = vi.fn();
  const client = new CompanionLanguageClient({ ...deviceDeps, fetchAnonymous, fetchWithAuth,
    getSessionKey: () => null, getServerApiBaseUrl: () => 'http://localhost' });
  const send = vi.fn();
  client.start(request, send);
  await drain();
  expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    type: LanguageToolEventType.Error, code: LanguageToolCode.Unauthorized,
  }));
  expect(fetchAnonymous).toHaveBeenCalledTimes(1);
  expect(fetchWithAuth).not.toHaveBeenCalled();
});

test('a later guest request can translate after the server removes its login requirement', async () => {
  const fetchAnonymous = vi.fn()
    .mockResolvedValueOnce(Response.json({ code: 401 }, { status: 401 }))
    .mockResolvedValueOnce(sse(delta + done));
  const client = new CompanionLanguageClient({ ...deviceDeps, fetchAnonymous, fetchWithAuth: vi.fn(),
    getSessionKey: () => null, getServerApiBaseUrl: () => 'http://localhost' });
  const send = vi.fn();
  client.start(request, send);
  await drain();
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ code: LanguageToolCode.Unauthorized }));
  send.mockClear();
  expect(client.start(request, send).success).toBe(true);
  await drain();
  expect(send.mock.calls.map(([event]) => event.type)).toEqual([LanguageToolEventType.Delta, LanguageToolEventType.Done]);
  expect(fetchAnonymous).toHaveBeenCalledTimes(2);
});

test('missing persistent device fails before dispatch and guest results are discarded after login', async () => {
  const fetchAnonymous = vi.fn();
  const client = new CompanionLanguageClient({ ...deviceDeps, fetchAnonymous, fetchWithAuth: vi.fn(),
    getInstallationId: () => null, getSessionKey: () => null, getServerApiBaseUrl: () => 'http://localhost' });
  expect(client.start(request, vi.fn())).toEqual({ success: false, code: LanguageToolCode.Unavailable });
  expect(fetchAnonymous).not.toHaveBeenCalled();
  let session: string | null = null;
  let release!: (response: Response) => void;
  const delayed = new CompanionLanguageClient({ ...deviceDeps, fetchWithAuth: vi.fn(),
    fetchAnonymous: () => new Promise(resolve => { release = resolve; }),
    getSessionKey: () => session, getServerApiBaseUrl: () => 'http://localhost' });
  const send = vi.fn(); delayed.start(request, send); session = 'user1'; release(sse(delta + done));
  await drain(); expect(send).not.toHaveBeenCalled();
});
