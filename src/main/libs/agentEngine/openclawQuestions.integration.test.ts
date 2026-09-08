import { expect, test, vi } from 'vitest';

import { OpenClawQuestion, OpenClawQuestionStatus } from '../../../shared/cowork/openclawQuestion';
import { CoworkEngineRouter } from './coworkEngineRouter';
import { OpenClawRuntimeAdapter } from './openclawRuntimeAdapter';

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), getPath: () => process.cwd(), getVersion: () => 'test' },
  BrowserWindow: { getAllWindows: () => [] },
}));

test('native gateway events reach the permission UI and router propagates answer failures for retry', async () => {
  const sessionId = '33e1f1ef-57b5-404f-a878-c727e764e104';
  const store = {
    getSession: (id: string) => id === sessionId ? { id: sessionId, agentId: 'main' } : null,
  };
  const adapter = new OpenClawRuntimeAdapter(store as never, {} as never);
  const router = new CoworkEngineRouter({ getCurrentEngine: () => 'openclaw', openclawRuntime: adapter });
  const request = vi.fn().mockResolvedValue({ status: OpenClawQuestionStatus.Answered });
  const internals = adapter as unknown as {
    gatewayClient: unknown;
    handleGatewayEvent: (event: unknown) => void;
    stopGatewayClient: () => void;
  };
  internals.gatewayClient = { start: () => {}, stop: () => {}, request };
  const onQuestion = vi.fn();
  const onResolved = vi.fn();
  router.on('permissionRequest', onQuestion);
  router.on('permissionResolved', onResolved);
  internals.handleGatewayEvent({ event: OpenClawQuestion.Requested, payload: {
    id: 'native-request', sessionKey: `agent:main:lobsterai:${sessionId}`,
    status: OpenClawQuestionStatus.Pending, expiresAtMs: Date.now() + 60_000,
    questions: [{ questionId: 'topic', header: 'Topic', question: 'Pick', options: [{ label: 'A' }, { label: 'B' }], isOther: true }],
  } });
  const requestId = `${OpenClawQuestion.RequestIdPrefix}native-request`;
  expect(onQuestion).toHaveBeenCalledWith(sessionId, expect.objectContaining({ requestId, toolName: OpenClawQuestion.ToolName }));
  const response = { behavior: 'allow' as const, updatedInput: { answers: { topic: ['B'] } } };
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  request.mockRejectedValueOnce(new Error('offline'));
  await expect(router.respondToPermission(requestId, response)).rejects.toThrow('offline');
  expect(onResolved).not.toHaveBeenCalled();
  await router.respondToPermission(requestId, response);
  expect(request).toHaveBeenLastCalledWith(OpenClawQuestion.Resolve, {
    id: 'native-request', answers: { answers: { topic: ['B'] } },
  }, expect.anything());
  expect(onResolved).toHaveBeenCalledWith(sessionId, requestId);
  warn.mockRestore();
  internals.stopGatewayClient();
});
