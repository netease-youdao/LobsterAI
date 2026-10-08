import type { StreamFn } from 'openclaw/plugin-sdk/agent-core';
import { describe, expect, test } from 'vitest';

import {
  applyKimiK3PayloadContract,
  createKimiK3StreamWrapper,
  ensureKimiK3ToolCallReasoningContent,
  KIMI_K3_FIXED_SAMPLING_FIELDS,
  KIMI_K3_REASONING_EFFORT,
} from '../../../openclaw-extensions/lobsterai-model-compat/kimiK3StreamWrapper';

const requireRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not a record`);
  }
  return value as Record<string, unknown>;
};

type CapturedCall = {
  model: Parameters<StreamFn>[0];
  options: Parameters<StreamFn>[2];
  finalPayload: unknown;
};

/**
 * Mimics the OpenAI-compatible transport: builds a payload, offers it to the
 * caller hook, and sends whatever the hook returned (or the mutated original).
 */
const createTransport = (
  buildPayload: () => unknown,
): { streamFn: StreamFn; calls: CapturedCall[] } => {
  const calls: CapturedCall[] = [];
  const streamFn: StreamFn = (async (model, _context, options) => {
    const payload = buildPayload();
    const replacement = await options?.onPayload?.(payload, model);
    calls.push({ model, options, finalPayload: replacement ?? payload });
    return {} as never;
  }) as StreamFn;
  return { streamFn, calls };
};

const k3Model = { api: 'openai-completions', provider: 'custom_0', id: 'kimi-k3' } as never;

describe('Kimi K3 payload contract', () => {
  test('forces max reasoning effort and strips the fixed sampling fields', () => {
    expect(KIMI_K3_REASONING_EFFORT).toBe('max');
    expect(KIMI_K3_FIXED_SAMPLING_FIELDS).toEqual([
      'temperature',
      'top_p',
      'n',
      'presence_penalty',
      'frequency_penalty',
    ]);

    const pinnedToolChoice = { type: 'function', function: { name: 'read' } };
    const payload: Record<string, unknown> = {
      model: 'kimi-k3',
      thinking: { type: 'disabled' },
      reasoningEffort: 'low',
      reasoning_effort: 'low',
      temperature: 0,
      top_p: 0.5,
      n: 2,
      presence_penalty: 1,
      frequency_penalty: 1,
      max_tokens: 8192,
      tool_choice: pinnedToolChoice,
      messages: [{ role: 'user', content: 'hi' }],
    };

    applyKimiK3PayloadContract(payload);

    expect(payload).toEqual({
      model: 'kimi-k3',
      reasoning_effort: 'max',
      max_tokens: 8192,
      tool_choice: pinnedToolChoice,
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  test('adds empty reasoning_content only to assistant tool-call messages that lack it', () => {
    const payload: Record<string, unknown> = {
      messages: [
        { role: 'user', content: 'plan' },
        { role: 'assistant', content: 'plain answer' },
        { role: 'assistant', tool_calls: [] },
        { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function' }] },
        {
          role: 'assistant',
          tool_calls: [{ id: 'call_2', type: 'function' }],
          reasoning_content: 'native reasoning',
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
        'not-a-message',
      ],
    };

    ensureKimiK3ToolCallReasoningContent(payload);

    expect(payload.messages).toEqual([
      { role: 'user', content: 'plan' },
      { role: 'assistant', content: 'plain answer' },
      { role: 'assistant', tool_calls: [] },
      { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function' }], reasoning_content: '' },
      {
        role: 'assistant',
        tool_calls: [{ id: 'call_2', type: 'function' }],
        reasoning_content: 'native reasoning',
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
      'not-a-message',
    ]);
  });

  test('tolerates payloads without a message list', () => {
    const noMessages: Record<string, unknown> = { model: 'kimi-k3' };
    const wrongShape: Record<string, unknown> = { model: 'kimi-k3', messages: 'nope' };

    ensureKimiK3ToolCallReasoningContent(noMessages);
    ensureKimiK3ToolCallReasoningContent(wrongShape);

    expect(noMessages).toEqual({ model: 'kimi-k3' });
    expect(wrongShape).toEqual({ model: 'kimi-k3', messages: 'nope' });
  });
});

describe('createKimiK3StreamWrapper', () => {
  test('marks the model as reasoning and requests max effort from the transport', async () => {
    const transport = createTransport(() => ({ model: 'kimi-k3' }));
    const wrapped = createKimiK3StreamWrapper(transport.streamFn);

    await wrapped(k3Model, {} as never, { promptCacheKey: 'session-1' } as never);

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0].model).toEqual({ ...(k3Model as object), reasoning: true });
    expect(transport.calls[0].options).toMatchObject({
      promptCacheKey: 'session-1',
      reasoning: 'max',
    });
    expect(transport.calls[0].finalPayload).toEqual({ model: 'kimi-k3', reasoning_effort: 'max' });
  });

  test('applies the contract before the caller hook and again after an async replacement', async () => {
    let callerSawReasoningContent: unknown;
    const pinnedToolChoice = { type: 'function', function: { name: 'read' } };
    const transport = createTransport(() => ({
      model: 'my-kimi-prod',
      messages: [
        {
          role: 'assistant',
          tool_calls: [{ id: 'call_before', type: 'function' }],
        },
      ],
    }));
    const wrapped = createKimiK3StreamWrapper(transport.streamFn);

    await wrapped(
      { api: 'openai-completions', provider: 'custom_0', id: 'my-kimi-prod' } as never,
      {} as never,
      {
        onPayload: async (payload) => {
          const messages = requireRecord(payload, 'caller payload').messages as Array<
            Record<string, unknown>
          >;
          callerSawReasoningContent = messages[0]?.reasoning_content;
          return {
            model: 'my-kimi-prod',
            messages: [
              {
                role: 'assistant',
                tool_calls: [{ id: 'call_after', type: 'function' }],
              },
              { role: 'assistant', content: 'plain answer' },
              {
                role: 'assistant',
                tool_calls: [{ id: 'call_native', type: 'function' }],
                reasoning_content: 'native reasoning',
              },
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
          };
        },
      },
    );

    expect(callerSawReasoningContent).toBe('');
    const payload = requireRecord(transport.calls[0]?.finalPayload, 'final payload');
    expect(payload).not.toHaveProperty('thinking');
    expect(payload).not.toHaveProperty('reasoningEffort');
    expect(payload.reasoning_effort).toBe('max');
    for (const field of KIMI_K3_FIXED_SAMPLING_FIELDS) {
      expect(payload).not.toHaveProperty(field);
    }
    expect(payload.tool_choice).toEqual(pinnedToolChoice);
    expect(payload.messages).toEqual([
      {
        role: 'assistant',
        tool_calls: [{ id: 'call_after', type: 'function' }],
        reasoning_content: '',
      },
      { role: 'assistant', content: 'plain answer' },
      {
        role: 'assistant',
        tool_calls: [{ id: 'call_native', type: 'function' }],
        reasoning_content: 'native reasoning',
      },
    ]);
  });

  test('re-applies the contract after a synchronous replacement', async () => {
    const transport = createTransport(() => ({ model: 'kimi-k3' }));
    const wrapped = createKimiK3StreamWrapper(transport.streamFn);

    await wrapped(k3Model, {} as never, {
      onPayload: () => ({ model: 'kimi-k3', temperature: 0.7, reasoning_effort: 'low' }),
    });

    expect(transport.calls[0]?.finalPayload).toEqual({ model: 'kimi-k3', reasoning_effort: 'max' });
  });

  test('keeps a caller hook that mutates in place and returns nothing', async () => {
    const transport = createTransport(() => ({ model: 'kimi-k3', temperature: 0 }));
    const wrapped = createKimiK3StreamWrapper(transport.streamFn);

    await wrapped(k3Model, {} as never, {
      onPayload: (payload) => {
        requireRecord(payload, 'caller payload').top_p = 0.1;
        return undefined;
      },
    });

    expect(transport.calls[0]?.finalPayload).toEqual({ model: 'kimi-k3', reasoning_effort: 'max' });
  });

  test('passes non-object payloads through to the caller untouched', async () => {
    const seen: unknown[] = [];
    const transport = createTransport(() => 'opaque-payload');
    const wrapped = createKimiK3StreamWrapper(transport.streamFn);

    await wrapped(k3Model, {} as never, {
      onPayload: (payload) => {
        seen.push(payload);
        return 'replaced-payload';
      },
    });

    expect(seen).toEqual(['opaque-payload']);
    expect(transport.calls[0]?.finalPayload).toBe('replaced-payload');
  });
});
