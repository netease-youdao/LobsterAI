import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import plugin from '../../../openclaw-extensions/ask-user-question/index';
import { McpBridgeServer } from '../../../src/main/libs/mcpBridgeServer';

type RegisteredTool = {
  execute(id: string, input: unknown, signal?: AbortSignal): Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
};

describe('AskUserQuestion when the run stops', () => {
  const server = new McpBridgeServer('stop-test-secret');
  const asked: string[] = [];
  const dismissed: string[] = [];
  let tool: RegisteredTool;

  beforeAll(async () => {
    await server.start();
    // Never answer: the run is stopped while the question is still open.
    server.onAskUser((request) => { asked.push(request.requestId); });
    server.onAskUserDismiss((requestId) => { dismissed.push(requestId); });
    const registerTool = vi.fn();
    plugin.register({
      pluginConfig: { callbackUrl: server.askUserCallbackUrl, secret: 'stop-test-secret' },
      logger: { info: vi.fn() },
      registerTool,
    } as unknown as Parameters<typeof plugin.register>[0]);
    tool = registerTool.mock.calls[0][0]({ sessionKey: 'agent:main:lobsterai:stop-test' });
  });

  afterAll(async () => { await server.stop(); });

  test('withdraws the open question so LobsterAI closes its dialog', async () => {
    const controller = new AbortController();
    const pending = tool.execute('stopped', {
      questions: [{ question: 'Which target?', options: [{ label: 'Preview' }, { label: 'Production' }] }],
    }, controller.signal);

    await expect.poll(() => asked.length, { timeout: 5_000 }).toBe(1);
    controller.abort();

    await expect(pending).resolves.toMatchObject({ content: [{ text: 'User denied the operation.' }] });
    await expect.poll(() => dismissed, { timeout: 5_000 }).toEqual(asked);
  });
});
