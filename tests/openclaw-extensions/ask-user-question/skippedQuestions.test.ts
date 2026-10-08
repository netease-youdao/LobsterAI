import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import plugin from '../../../openclaw-extensions/ask-user-question/index';
import { type AskUserResponse, McpBridgeServer } from '../../../src/main/libs/mcpBridgeServer';

const question = {
  question: 'Which target?',
  options: [{ label: 'Preview' }, { label: 'Production' }],
};

type RegisteredTool = {
  execute(id: string, input: unknown): Promise<{ content: { type: string; text: string }[]; details?: unknown; isError?: boolean }>;
};

describe('AskUserQuestion callback answers and skipped questions', () => {
  const server = new McpBridgeServer('question-test-secret');
  let response: AskUserResponse;
  let tool: RegisteredTool;

  beforeAll(async () => {
    await server.start();
    server.onAskUser((request) => { server.resolveAskUser(request.requestId, response); });
    const registerTool = vi.fn();
    plugin.register({
      pluginConfig: { callbackUrl: server.askUserCallbackUrl, secret: 'question-test-secret' },
      logger: { info: vi.fn() },
      registerTool,
    } as unknown as Parameters<typeof plugin.register>[0]);
    tool = registerTool.mock.calls[0][0]({ sessionKey: 'agent:main:lobsterai:question-test' });
  });

  afterAll(async () => { await server.stop(); });

  test('keeps the existing answer text and multi-select delimiter intact', async () => {
    response = { behavior: 'allow', answers: { 'Which target?': 'Preview|||Local alternative' } };
    const result = await tool.execute('normal', { questions: [question] });
    expect(result.content[0].text).toBe('Which target?: Preview|||Local alternative');
    expect(result.isError).not.toBe(true);
  });

  test('reports every skipped question instead of fabricating approval', async () => {
    response = { behavior: 'allow', answers: {}, skippedQuestionIds: ['question-1'] };
    const result = await tool.execute('skip', { questions: [question] });
    expect(result.content[0].text).toBe('Which target?: (skipped by user; no answer or approval given)');
    expect(result.details).toEqual({ answers: {}, skippedQuestionIds: ['question-1'] });
  });

  test('preserves explicit ids with a mixed answer and skip', async () => {
    response = { behavior: 'allow', answers: { 'Which target?': 'Preview' }, skippedQuestionIds: ['timing'] };
    const result = await tool.execute('mixed', { questions: [
      { ...question, id: 'target' }, { ...question, id: 'timing', question: 'When?' },
    ] });
    expect(result.content[0].text).toBe('Which target?: Preview\nWhen?: (skipped by user; no answer or approval given)');
    expect(result.details).toEqual({ answers: response.answers, skippedQuestionIds: ['timing'] });
  });

  test.each([
    { behavior: 'allow', skippedQuestionIds: ['unknown'] },
    { behavior: 'allow', skippedQuestionIds: ['question-1', 'question-1'] },
    { behavior: 'allow', answers: { 'Which target?': 'Preview' }, skippedQuestionIds: ['question-1'] },
    { behavior: 'allow', answers: { 'Which target?': 123 } },
  ])('rejects contradictory or malformed callbacks: %j', async (invalid) => {
    response = invalid as unknown as AskUserResponse;
    const result = await tool.execute('invalid', { questions: [question] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('AskUserQuestion failed:');
  });

  test('does not invent approval for an empty allow response', async () => {
    response = { behavior: 'allow' };
    const result = await tool.execute('empty', { questions: [question] });
    expect(result.content[0].text).toBe('No answers were provided; no user approval was given.');
  });

  test('still treats deny as deny', async () => {
    response = { behavior: 'deny' };
    const result = await tool.execute('deny', { questions: [question] });
    expect(result.content[0].text).toBe('User denied the operation.');
  });
});
