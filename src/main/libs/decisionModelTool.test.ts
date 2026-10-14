import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { DecisionModelErrorCode } from '../../shared/decisionModel/constants';
import type { DecisionFetch } from './decisionModelClient';
import { type DecisionModelConfig, DEFAULT_DECISION_MODEL_CONFIG } from './decisionModelConfig';
import { handleDecisionToolRequest } from './decisionModelTool';

const activeConfig: DecisionModelConfig = {
  ...DEFAULT_DECISION_MODEL_CONFIG,
  enabled: true,
  apiKey: 'sk-or-v1-secret-key-123456',
};

const request = (args: Record<string, unknown>) => ({
  args,
  context: { sessionKey: 'agent:main:lobsterai:session-a', toolCallId: 'call-1' },
});

const validArgs = {
  state: 'Customer reviews of a coffee shop.',
  questions: [
    { id: 'r1', type: 'choice', instructions: 'Review: "Cold coffee, rude staff." Sentiment?', options: [{ name: 'positive' }, { name: 'negative' }] },
    { id: 'r2', type: 'boolean', instructions: 'Review: "Loved the croissants." Does it praise the food?' },
  ],
};

const fetchReturning = (status: number, body: unknown): DecisionFetch => async () => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});

const parseToolText = (response: { content: Array<{ text: string }> }) => JSON.parse(response.content[0].text);

describe('handleDecisionToolRequest', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('tells the agent how to turn the feature on when it is inactive', async () => {
    const fetch = vi.fn<DecisionFetch>();

    const response = await handleDecisionToolRequest(request(validArgs), {
      getConfig: () => ({ ...activeConfig, enabled: false }),
      fetch,
    });

    expect(response.isError).toBe(true);
    expect(parseToolText(response).guidance).toContain('Settings → Experimental');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('returns validation problems as an invalid_input failure', async () => {
    const response = await handleDecisionToolRequest(request({ state: 'x', questions: [] }), {
      getConfig: () => activeConfig,
      fetch: vi.fn<DecisionFetch>(),
    });

    expect(response.isError).toBe(true);
    expect(parseToolText(response)).toMatchObject({
      status: 'unavailable',
      errorCode: DecisionModelErrorCode.InvalidInput,
      reason: expect.stringContaining('"questions" must be a non-empty array'),
    });
  });

  test('returns typed answers and a summary for the transcript', async () => {
    const response = await handleDecisionToolRequest(request(validArgs), {
      getConfig: () => activeConfig,
      fetch: fetchReturning(200, {
        model: 'typesafe/jev-1.13-20260917',
        answers: {
          r1: { type: 'choice', choice: 'negative', confidence: 0.9, probabilities: { positive: 0.05, negative: 0.95 } },
          r2: { type: 'noul', noul: 0.91 },
        },
        usage: { input_tokens: 120, output_tokens: 20, cost: 0.000005 },
      }),
    });

    expect(response.isError).toBeUndefined();
    expect(parseToolText(response)).toMatchObject({
      status: 'ok',
      provider: 'typesafe',
      model: 'typesafe/jev-1.13-20260917',
      answers: {
        r1: { type: 'choice', choice: 'negative', confidence: 0.9 },
        r2: { type: 'boolean', probability: 0.91 },
      },
    });
    expect(response.details).toMatchObject({ questionCount: 2, invalidCount: 0 });
  });

  test('turns provider failures into guidance without leaking the key', async () => {
    const response = await handleDecisionToolRequest(request(validArgs), {
      getConfig: () => activeConfig,
      fetch: fetchReturning(401, { error: `bad key ${activeConfig.apiKey}` }),
    });

    expect(response.isError).toBe(true);
    const payload = parseToolText(response);
    expect(payload.errorCode).toBe(DecisionModelErrorCode.Unauthorized);
    expect(payload.guidance).toContain('check it under Settings');
    expect(response.content[0].text).not.toContain(activeConfig.apiKey);
  });
});
