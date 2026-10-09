import { describe, expect, test, vi } from 'vitest';

import { LanguageTool, LanguageToolCode, type LanguageToolEvent, LanguageToolEventType, TranslationTarget } from '../../shared/desktopCompanion/languageTools';
import { CompanionLanguageClient } from './languageToolClient';

const request = { requestId: '00000000-1111-2222-3333-444444444444', tool: LanguageTool.Translate,
  text: 'Hello', targetLanguage: TranslationTarget.Chinese };
const sse = (text: string) => new Response(text, { headers: { 'content-type': 'text/event-stream' } });
const delta = `event: delta\ndata: ${JSON.stringify({ text: '你好', language: TranslationTarget.Chinese })}\n\n`;
const done = 'event: done\ndata: {}\n\n';
const drain = () => new Promise(resolve => setTimeout(resolve, 15));

describe('authenticated desktop language tools', () => {
  test('requires a session before any paid upstream request', () => {
    const fetchWithAuth = vi.fn();
    const client = new CompanionLanguageClient({ fetchWithAuth, getSessionKey: () => null, getServerApiBaseUrl: () => 'http://localhost' });
    expect(client.start(request, vi.fn())).toEqual({ success: false, code: LanguageToolCode.Unauthorized });
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  test('decodes UTF-8 across chunks and uses the authenticated local server', async () => {
    const bytes = new TextEncoder().encode(delta + done);
    const fetchWithAuth = vi.fn(async () => new Response(new ReadableStream({
      start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); },
    }), { headers: { 'content-type': 'text/event-stream' } }));
    const client = new CompanionLanguageClient({ fetchWithAuth, getSessionKey: () => 'user1', getServerApiBaseUrl: () => 'http://127.0.0.1:18878' });
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
      const client = new CompanionLanguageClient({ fetchWithAuth: async () => response, getSessionKey: () => 'user1', getServerApiBaseUrl: () => 'http://localhost' });
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
      const client = new CompanionLanguageClient({ fetchWithAuth: () => new Promise(resolve => { release = resolve; }),
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
