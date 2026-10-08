import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import plugin from '../../../openclaw-extensions/lobster-decision/index';
import type { DecisionFetch } from '../../../src/main/libs/decisionModelClient';
import { DEFAULT_DECISION_MODEL_CONFIG } from '../../../src/main/libs/decisionModelConfig';
import { handleDecisionToolRequest } from '../../../src/main/libs/decisionModelTool';
import { McpBridgeServer } from '../../../src/main/libs/mcpBridgeServer';

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
};

type RegisteredTool = {
  name: string;
  execute(id: string, input: unknown, signal?: AbortSignal): Promise<ToolResult>;
};

type ToolFactory = (ctx: { sessionKey?: string }) => RegisteredTool | null;

const SECRET = 'decision-e2e-secret';
const DESKTOP_SESSION = 'agent:main:lobsterai:session-e2e';

describe('decision_evaluate through the loopback bridge', () => {
  const server = new McpBridgeServer(SECRET);
  const upstreamBodies: Array<Record<string, unknown>> = [];
  let factory: ToolFactory;

  // Stands in for Jev: answers every question with the wire type it was asked.
  const fakeJev: DecisionFetch = async (_url, init) => {
    const body = JSON.parse(init.body) as { questions: Record<string, { type: string; criteria?: Record<string, unknown> }> };
    upstreamBodies.push(body);
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
      if (question.type === 'noul') return [id, { type: 'noul', noul: 0.8 }];
      if (question.type === 'choice') {
        return [id, { type: 'choice', choice: Object.keys(question.criteria ?? {})[0], confidence: 0.7 }];
      }
      return [id, { type: 'score', score: 1 }];
    }));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 42, output_tokens: 3 } }),
    };
  };

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await server.start();
    server.onDecisionTool((request, signal) => handleDecisionToolRequest(request, {
      getConfig: () => ({ ...DEFAULT_DECISION_MODEL_CONFIG, enabled: true, apiKey: 'ts-test-key' }),
      fetch: fakeJev,
    }, signal));

    const registerTool = vi.fn();
    plugin.register({
      pluginConfig: { callbackUrl: server.decisionCallbackUrl, secret: SECRET },
      logger: { info: vi.fn() },
      registerTool,
    } as unknown as Parameters<typeof plugin.register>[0]);
    factory = registerTool.mock.calls[0][0];
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await server.stop();
  });

  test('exposes the tool to LobsterAI desktop sessions only', () => {
    expect(factory({ sessionKey: DESKTOP_SESSION })?.name).toBe('decision_evaluate');
    expect(factory({ sessionKey: 'agent:main:dingtalk:group-1' })).toBeNull();
  });

  test('judges a batch of items and returns typed answers', async () => {
    const tool = factory({ sessionKey: DESKTOP_SESSION })!;

    const result = await tool.execute('call-1', {
      state: 'Customer reviews of an online store.',
      questions: [
        {
          id: 'r1',
          type: 'choice',
          instructions: 'Review: "Arrived late." Which problem does it report?',
          options: [{ name: 'shipping' }, { name: 'quality' }],
        },
        { id: 'r2', type: 'boolean', instructions: 'Review: "Great value." Is it positive?' },
        { id: 'r3', type: 'score', instructions: 'How angry is "Never again!"?', levels: ['calm', 'annoyed', 'furious'] },
      ],
    });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      status: 'ok',
      model: 'jev-1.13.0',
      usage: { inputTokens: 42, outputTokens: 3, costUsd: null },
      answers: {
        r1: { type: 'choice', choice: 'shipping', confidence: 0.7 },
        r2: { type: 'boolean', probability: 0.8 },
        r3: { type: 'score', score: 1, level: 'annoyed' },
      },
    });
    expect(upstreamBodies.at(-1)).toMatchObject({
      model: 'jev-latest',
      state: 'Customer reviews of an online store.',
    });
  });

  test('passes validation errors back as tool errors without calling the model', async () => {
    const tool = factory({ sessionKey: DESKTOP_SESSION })!;
    const callsBefore = upstreamBodies.length;

    const result = await tool.execute('call-2', {
      state: 'x',
      questions: [{ id: 'q', type: 'choice', instructions: 'Pick one', options: ['only'] }],
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ status: 'unavailable', errorCode: 'invalid_input' });
    expect(upstreamBodies).toHaveLength(callsBefore);
  });
});
