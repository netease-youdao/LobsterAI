import { afterEach, describe, expect, test, vi } from 'vitest';

import { OllamaClient } from './ollamaClient';

describe('OllamaClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('lists local models from /api/tags', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      models: [{ name: 'qwen3:8b', size: 123 }],
    })));

    const client = new OllamaClient('http://127.0.0.1:11434/');

    await expect(client.listModels()).resolves.toEqual([{ name: 'qwen3:8b', size: 123 }]);
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/tags',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  test('streams chat chunks from /api/chat NDJSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ndjsonResponse([
      JSON.stringify({ message: { role: 'assistant', content: 'hi' } }),
      JSON.stringify({ done: true, eval_count: 1 }),
    ])));
    const chunks: unknown[] = [];
    const client = new OllamaClient();

    await client.chat({
      model: 'qwen3:8b',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    }, (chunk) => chunks.push(chunk));

    expect(chunks).toEqual([
      { message: { role: 'assistant', content: 'hi' } },
      { done: true, eval_count: 1 },
    ]);
  });

  test('throws when Ollama stream returns an error chunk', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ndjsonResponse([
      JSON.stringify({ error: 'model not found' }),
    ])));
    const client = new OllamaClient();

    await expect(client.pullModel('missing')).rejects.toThrow('model not found');
  });
});

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as Response;
}

function ndjsonResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`${lines.join('\n')}\n`));
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    body,
  } as Response;
}
