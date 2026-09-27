import { describe, expect, test } from 'vitest';

import { DecisionModelErrorCode, DecisionModelProvider } from '../../shared/decisionModel/constants';
import {
  buildDecisionRequest,
  type DecisionEvaluateInput,
  type DecisionFetch,
  type DecisionHttpResponse,
  DecisionLimits,
  DecisionModelError,
  evaluateDecision,
  JEV_LATEST_MODEL,
  OPENROUTER_DECISIONS_URL,
  OPENROUTER_JEV_MODEL,
  parseDecisionEvaluateInput,
  testDecisionModelConnection,
  TYPESAFE_SYSTEM_ONE_URL,
} from './decisionModelClient';
import { type DecisionModelConfig, DEFAULT_DECISION_MODEL_CONFIG } from './decisionModelConfig';

const API_KEY = 'sk-or-v1-secret-key-123456';
const RELAY_ENDPOINT = 'https://relay.example.com/typesafe/v1/systemone';

const openRouterConfig: DecisionModelConfig = {
  ...DEFAULT_DECISION_MODEL_CONFIG,
  enabled: true,
  provider: DecisionModelProvider.OpenRouter,
  apiKey: API_KEY,
};

const ticketInput: DecisionEvaluateInput = {
  state: { ticket: 'My checkout page shows a blank screen after I click Pay.' },
  questions: [
    { id: 'is_bug', type: 'boolean', instructions: 'Is the customer reporting a software defect?' },
    {
      id: 'team',
      type: 'choice',
      instructions: 'Which team should own this ticket?',
      options: [
        { name: 'payments', description: 'Checkout, billing, or payment issues.' },
        { name: 'frontend' },
      ],
    },
    {
      id: 'urgency',
      type: 'score',
      instructions: 'How urgent is this ticket?',
      levels: ['Can wait', 'This week', 'Blocking revenue'],
    },
  ],
};

const typeSafeAnswers = {
  model: 'jev-1.13.0',
  answers: {
    is_bug: { type: 'noul', noul: 0.96 },
    team: {
      type: 'choice',
      choice: 'payments',
      confidence: 0.812345,
      probabilities: { payments: 0.9, frontend: 0.1 },
    },
    urgency: {
      type: 'score',
      score: 1.99,
      confidence: 0.99,
      legend: { 0: 'Can wait', 1: 'This week', 2: 'Blocking revenue' },
      probabilities: { 0: 0, 1: 0.01, 2: 0.99 },
    },
  },
  usage: { input_tokens: 476, output_tokens: 70, cost: 0.00002 },
};

const jsonResponse = (status: number, body: unknown): DecisionHttpResponse => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

function recordingFetch(result: DecisionHttpResponse | Error) {
  const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  const fetch: DecisionFetch = async (url, init) => {
    calls.push({ url, body: init.body, headers: init.headers });
    if (result instanceof Error) throw result;
    return result;
  };
  return { fetch, calls };
}

// Resolves only through the abort signal, like a request that never answers.
const hangingFetch: DecisionFetch = (_url, init) => new Promise((_resolve, reject) => {
  init.signal.addEventListener('abort', () => {
    reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
  });
});

const errorCodeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DecisionModelError) return error.code;
    throw error;
  }
  throw new Error('expected the promise to reject');
};

describe('parseDecisionEvaluateInput', () => {
  test('accepts text or JSON state and all three question types', () => {
    const parsed = parseDecisionEvaluateInput({
      state: 'Help! My payouts have been failing for 3 days.',
      questions: [
        { id: ' urgent ', type: 'boolean', instructions: 'Is this urgent?', trueCriteria: 'Needs a reply within the hour.' },
        { id: 'area', type: 'choice', instructions: 'Which area?', options: ['billing', { name: 'bug', description: 'A defect.' }] },
        { id: 'tone', type: 'score', instructions: 'How angry?', levels: ['Calm', 'Frustrated', 'Very angry'] },
      ],
    });

    expect(parsed).toEqual({
      ok: true,
      input: {
        state: 'Help! My payouts have been failing for 3 days.',
        questions: [
          { id: 'urgent', type: 'boolean', instructions: 'Is this urgent?', trueCriteria: 'Needs a reply within the hour.' },
          { id: 'area', type: 'choice', instructions: 'Which area?', options: [{ name: 'billing' }, { name: 'bug', description: 'A defect.' }] },
          { id: 'tone', type: 'score', instructions: 'How angry?', levels: ['Calm', 'Frustrated', 'Very angry'] },
        ],
      },
    });
    expect(parseDecisionEvaluateInput({ state: [{ a: 1 }], questions: [{ id: 'q', type: 'boolean', instructions: 'ok?' }] }).ok)
      .toBe(true);
  });

  test.each([
    [{ questions: [] }, '"state" must be text'],
    [{ state: '   ', questions: [] }, '"state" must not be empty'],
    [{ state: 'x', questions: [] }, '"questions" must be a non-empty array'],
    [{ state: 'x', questions: [{ type: 'boolean', instructions: 'ok?' }] }, 'questions[0].id is required'],
    [{ state: 'x', questions: [{ id: 'q', type: 'boolean' }] }, 'questions[0].instructions is required'],
    [{ state: 'x', questions: [{ id: 'q', type: 'rank', instructions: 'ok?' }] }, 'questions[0].type must be'],
    [{ state: 'x', questions: [{ id: 'q', type: 'choice', instructions: 'ok?', options: ['only'] }] }, 'between 2 and 255'],
    [{ state: 'x', questions: [{ id: 'q', type: 'choice', instructions: 'ok?', options: ['a', 'a'] }] }, 'duplicate name "a"'],
    [{ state: 'x', questions: [{ id: 'q', type: 'score', instructions: 'ok?', levels: ['one'] }] }, 'between 2 and 10'],
    [{ state: 'x', questions: [{ id: 'q', type: 'score', instructions: 'ok?', levels: ['a', 'a'] }] }, 'must be distinct'],
    [{
      state: 'x',
      questions: [
        { id: 'q', type: 'boolean', instructions: 'a?' },
        { id: 'q', type: 'boolean', instructions: 'b?' },
      ],
    }, 'duplicate question id "q"'],
  ])('rejects malformed input %#', (args, message) => {
    const parsed = parseDecisionEvaluateInput(args);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.error).toContain(message);
  });

  test('caps the number of questions per call', () => {
    const questions = Array.from({ length: DecisionLimits.MaxQuestions + 1 }, (_, index) => ({
      id: `q${index}`,
      type: 'boolean',
      instructions: 'ok?',
    }));
    const parsed = parseDecisionEvaluateInput({ state: 'x', questions });
    expect(parsed.ok === false && parsed.error).toContain('split the work');
  });
});

describe('buildDecisionRequest', () => {
  test('targets OpenRouter decisions with its pinned Jev model and app attribution', () => {
    const request = buildDecisionRequest(openRouterConfig, ticketInput);

    expect(request.url).toBe(OPENROUTER_DECISIONS_URL);
    expect(request.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(request.headers['HTTP-Referer']).toBe('https://lobsterai.youdao.com');
    expect(request.headers['X-Title']).toBe('LobsterAI');
    expect(JSON.parse(request.body)).toEqual({
      model: OPENROUTER_JEV_MODEL,
      state: ticketInput.state,
      questions: {
        is_bug: { type: 'noul', instructions: 'Is the customer reporting a software defect?' },
        team: {
          type: 'choice',
          instructions: 'Which team should own this ticket?',
          criteria: { payments: 'Checkout, billing, or payment issues.', frontend: 'frontend' },
        },
        urgency: {
          type: 'score',
          instructions: 'How urgent is this ticket?',
          criteria: ['Can wait', 'This week', 'Blocking revenue'],
        },
      },
    });
  });

  test('fills the missing side of a one-sided yes/no rubric', () => {
    const request = buildDecisionRequest(openRouterConfig, {
      state: 'x',
      questions: [{ id: 'q', type: 'boolean', instructions: 'Urgent?', falseCriteria: 'Routine request.' }],
    });

    expect(JSON.parse(request.body).questions.q.criteria).toEqual({
      true: 'Yes, this holds.',
      false: 'Routine request.',
    });
  });

  test('uses the moving alias for TypeSafe and compatible endpoints', () => {
    const typeSafe = buildDecisionRequest({ ...openRouterConfig, provider: DecisionModelProvider.TypeSafe }, ticketInput);
    expect(typeSafe.url).toBe(TYPESAFE_SYSTEM_ONE_URL);
    expect(typeSafe.headers['HTTP-Referer']).toBeUndefined();
    expect(JSON.parse(typeSafe.body).model).toBe(JEV_LATEST_MODEL);

    const relay = buildDecisionRequest({
      ...openRouterConfig,
      provider: DecisionModelProvider.Compatible,
      endpoint: RELAY_ENDPOINT,
    }, ticketInput);
    expect(relay.url).toBe(RELAY_ENDPOINT);
    expect(JSON.parse(relay.body).model).toBe(JEV_LATEST_MODEL);
  });
});

describe('evaluateDecision', () => {
  test('normalizes TypeSafe answers into typed, rounded results', async () => {
    const { fetch, calls } = recordingFetch(jsonResponse(200, typeSafeAnswers));
    let clock = 1_000;

    const result = await evaluateDecision(openRouterConfig, ticketInput, {
      fetch,
      now: () => {
        clock += 150;
        return clock;
      },
    });

    expect(calls).toHaveLength(1);
    expect(result).toEqual({
      provider: DecisionModelProvider.OpenRouter,
      model: 'jev-1.13.0',
      elapsedMs: 150,
      usage: { inputTokens: 476, outputTokens: 70, costUsd: 0.00002 },
      answers: {
        is_bug: { type: 'boolean', probability: 0.96 },
        team: { type: 'choice', choice: 'payments', confidence: 0.8123, probabilities: { payments: 0.9, frontend: 0.1 } },
        urgency: {
          type: 'score',
          score: 1.99,
          level: 'Blocking revenue',
          confidence: 0.99,
          probabilities: { 'Can wait': 0, 'This week': 0.01, 'Blocking revenue': 0.99 },
        },
      },
    });
  });

  test('flags malformed answers per question instead of trusting them', async () => {
    const { fetch } = recordingFetch(jsonResponse(200, {
      model: 'jev-1.13.0',
      answers: {
        is_bug: { type: 'choice', choice: 'yes' },
        team: { type: 'choice', choice: 'legal', probabilities: { legal: 1 } },
        urgency: { type: 'score', score: 7 },
      },
    }));

    const result = await evaluateDecision(openRouterConfig, ticketInput, { fetch });

    expect(result.answers.is_bug).toEqual({ type: 'invalid', reason: 'expected a yes/no answer, got "choice"' });
    expect(result.answers.team).toEqual({ type: 'invalid', reason: 'the chosen option is not one of the options asked about' });
    expect(result.answers.urgency).toEqual({ type: 'invalid', reason: 'the score is outside the rubric' });
    expect(result.usage).toEqual({ inputTokens: null, outputTokens: null, costUsd: null });
  });

  test('reports a partial probability distribution as absent', async () => {
    const { fetch } = recordingFetch(jsonResponse(200, {
      answers: {
        ...typeSafeAnswers.answers,
        team: { type: 'choice', choice: 'payments', probabilities: { payments: 0.9 } },
      },
    }));

    const result = await evaluateDecision(openRouterConfig, ticketInput, { fetch });

    expect(result.model).toBe(OPENROUTER_JEV_MODEL);
    expect(result.answers.team).toEqual({ type: 'choice', choice: 'payments', confidence: null, probabilities: null });
  });

  test.each([
    [401, DecisionModelErrorCode.Unauthorized],
    [402, DecisionModelErrorCode.InsufficientCredits],
    [429, DecisionModelErrorCode.RateLimited],
    [422, DecisionModelErrorCode.InvalidInput],
    [504, DecisionModelErrorCode.Timeout],
    [500, DecisionModelErrorCode.UpstreamError],
  ])('maps HTTP %i to %s', async (status, code) => {
    const { fetch } = recordingFetch(jsonResponse(status, { error: 'nope' }));
    await expect(errorCodeOf(evaluateDecision(openRouterConfig, ticketInput, { fetch }))).resolves.toBe(code);
  });

  test('treats a 404 from a compatible endpoint as a wrong URL', async () => {
    const { fetch } = recordingFetch(jsonResponse(404, 'Not Found'));
    const config = { ...openRouterConfig, provider: DecisionModelProvider.Compatible, endpoint: RELAY_ENDPOINT };
    await expect(errorCodeOf(evaluateDecision(config, ticketInput, { fetch })))
      .resolves.toBe(DecisionModelErrorCode.InvalidEndpoint);
  });

  test('redacts the API key from upstream error bodies', async () => {
    const { fetch } = recordingFetch(jsonResponse(401, `invalid key ${API_KEY}`));
    await expect(evaluateDecision(openRouterConfig, ticketInput, { fetch }))
      .rejects.toThrow('The API key was rejected (HTTP 401): invalid key ***');
  });

  test('rejects responses that are not JSON or carry no answers', async () => {
    await expect(errorCodeOf(evaluateDecision(openRouterConfig, ticketInput, recordingFetch(jsonResponse(200, '<html>')))))
      .resolves.toBe(DecisionModelErrorCode.InvalidResponse);
    await expect(errorCodeOf(evaluateDecision(openRouterConfig, ticketInput, recordingFetch(jsonResponse(200, { model: 'x' })))))
      .resolves.toBe(DecisionModelErrorCode.InvalidResponse);
  });

  test('classifies network failures, timeouts, and cancellation', async () => {
    await expect(errorCodeOf(evaluateDecision(openRouterConfig, ticketInput, recordingFetch(new Error('ECONNRESET')))))
      .resolves.toBe(DecisionModelErrorCode.Network);
    await expect(errorCodeOf(evaluateDecision(openRouterConfig, ticketInput, { fetch: hangingFetch, timeoutMs: 10 })))
      .resolves.toBe(DecisionModelErrorCode.Timeout);

    const caller = new AbortController();
    const pending = evaluateDecision(openRouterConfig, ticketInput, { fetch: hangingFetch, signal: caller.signal });
    caller.abort();
    await expect(errorCodeOf(pending)).resolves.toBe(DecisionModelErrorCode.Cancelled);
  });

  test('fails before any request when the key is missing or the payload is too large', async () => {
    const { fetch, calls } = recordingFetch(jsonResponse(200, typeSafeAnswers));

    await expect(errorCodeOf(evaluateDecision({ ...openRouterConfig, apiKey: '' }, ticketInput, { fetch })))
      .resolves.toBe(DecisionModelErrorCode.MissingApiKey);
    await expect(errorCodeOf(evaluateDecision(openRouterConfig, {
      state: 'x'.repeat(DecisionLimits.MaxRequestChars),
      questions: ticketInput.questions,
    }, { fetch }))).resolves.toBe(DecisionModelErrorCode.InvalidInput);
    expect(calls).toHaveLength(0);
  });
});

describe('testDecisionModelConnection', () => {
  test('reports the resolved model and latency on success', async () => {
    const { fetch } = recordingFetch(jsonResponse(200, {
      model: 'typesafe/jev-1.13-20260917',
      answers: { connection_check: { type: 'noul', noul: 0.97 } },
    }));

    const result = await testDecisionModelConnection(openRouterConfig, { fetch, now: () => 0 });

    expect(result).toEqual({ ok: true, model: 'typesafe/jev-1.13-20260917', elapsedMs: 0 });
  });

  test('returns a localized-ready error code on failure', async () => {
    const result = await testDecisionModelConnection(openRouterConfig, recordingFetch(jsonResponse(401, 'bad key')));

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe(DecisionModelErrorCode.Unauthorized);
  });
});
