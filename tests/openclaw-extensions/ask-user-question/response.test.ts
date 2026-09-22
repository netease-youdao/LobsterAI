import { afterEach, describe, expect, test, vi } from 'vitest';

import plugin from '../../../openclaw-extensions/ask-user-question';

type QuestionTool = { execute(id: string, params: unknown): Promise<unknown> };

function createTool(): QuestionTool {
  const registerTool = vi.fn();
  plugin.register({
    pluginConfig: { callbackUrl: 'http://127.0.0.1:12345/askuser', secret: 'test-secret' },
    logger: { info: vi.fn() },
    registerTool,
  } as unknown as Parameters<typeof plugin.register>[0]);
  return registerTool.mock.calls[0][0]({ sessionKey: 'agent:main:lobsterai:session-a' });
}

const input = { questions: [{ question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] }] };

describe('AskUserQuestion response handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test('keeps successful answers and explicit user refusals compatible', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ behavior: 'allow', answers: { 'Continue?': 'Yes' } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ behavior: 'deny' }))));
    const tool = createTool();

    await expect(tool.execute('call-a', input)).resolves.toEqual({
      content: [{ type: 'text', text: 'Continue?: Yes' }],
      details: { answers: { 'Continue?': 'Yes' }, skippedQuestionIds: [] },
    });
    await expect(tool.execute('call-b', input)).resolves.toEqual({ content: [{ type: 'text', text: 'User denied the operation.' }] });
  });

  test.each([
    ['timeout', 'timed out without a user response'],
    ['unavailable', 'could not be displayed'],
  ])('does not describe %s as an explicit user refusal', async (reason, text) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ behavior: 'deny', reason }))));

    await expect(createTool().execute('call-a', input)).resolves.toEqual({
      content: [{ type: 'text', text: expect.stringContaining(text) }],
      isError: true,
    });
  });

  test('treats an empty bridge response as an error without granting permission', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('')));

    await expect(createTool().execute('call-a', input)).resolves.toEqual({
      content: [{ type: 'text', text: expect.stringContaining('No permission was granted') }],
      isError: true,
    });
  });

  test('allows the bridge timeout to arrive before the transport deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));
    const settled = vi.fn();
    const result = createTool().execute('call-a', input).then(value => { settled(value); return value; });

    await vi.advanceTimersByTimeAsync(120_000);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(result).resolves.toEqual({
      content: [{ type: 'text', text: expect.stringContaining('timed out without a user response') }],
      isError: true,
    });
  });
});
