import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { OpenClawQuestion, OpenClawQuestionStatus } from '../../../shared/cowork/openclawQuestion';
import { OpenClawQuestionController } from './openclawQuestionController';

const makeRecord = (id = 'request-1', sessionKey = 'desktop-1') => ({
  id, sessionKey, runId: 'run-1', expiresAtMs: Date.now() + 900_000,
  status: OpenClawQuestionStatus.Pending,
  questions: [{
    questionId: 'choice', header: '选择', question: '选择一个',
    options: [{ label: 'A (Recommended)' }, { label: 'B' }], isOther: true,
  }],
});
const requestId = (id = 'request-1') => `${OpenClawQuestion.RequestIdPrefix}${id}`;

function setup() {
  const request = vi.fn().mockResolvedValue({ status: OpenClawQuestionStatus.Answered });
  let client: { request: typeof request } | null = { request };
  const options = {
    getGatewayClient: () => client,
    resolveSessionId: vi.fn((key: string) => key.startsWith('desktop-') ? key : undefined),
    isSessionStopped: vi.fn(() => false),
    emitPermissionRequest: vi.fn(), emitPermissionResolved: vi.fn(),
  };
  return {
    controller: new OpenClawQuestionController(options), request, options,
    disconnectClient: () => { client = null; },
  };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-08T08:00:00Z')); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('OpenClaw native questions', () => {
  test('opens one question in its owning session and sends the nested answers RPC envelope', async () => {
    const { controller, request, options } = setup();
    controller.handleRequested(makeRecord());
    controller.handleRequested(makeRecord());
    expect(options.emitPermissionRequest).toHaveBeenCalledTimes(1);
    expect(options.emitPermissionRequest).toHaveBeenCalledWith('desktop-1', expect.objectContaining({
      requestId: requestId(), toolName: OpenClawQuestion.ToolName,
    }));
    await controller.respond(requestId(), { behavior: 'allow', updatedInput: { answers: { choice: ['A (Recommended)'] } } });
    expect(request).toHaveBeenCalledWith(OpenClawQuestion.Resolve, {
      id: 'request-1', answers: { answers: { choice: ['A (Recommended)'] } },
    }, { timeoutMs: 10_000 });
    expect(options.emitPermissionResolved).toHaveBeenCalledWith('desktop-1', requestId());
  });

  test('cancel sends cancel:true, not a made-up answer', async () => {
    const { controller, request } = setup();
    controller.handleRequested(makeRecord());
    await controller.respond(requestId(), { behavior: 'deny', message: 'cancel' });
    expect(request).toHaveBeenCalledWith(OpenClawQuestion.Resolve, { id: 'request-1', cancel: true }, { timeoutMs: 10_000 });
  });

  test('renderer recovery snapshots include only still-pending questions', () => {
    const { controller } = setup();
    controller.handleRequested(makeRecord());
    expect(controller.getPendingQuestions()).toEqual([expect.objectContaining({
      sessionId: 'desktop-1', requestId: requestId(), toolName: OpenClawQuestion.ToolName,
    })]);
    controller.handleResolved({ id: 'request-1', status: OpenClawQuestionStatus.Answered });
    expect(controller.getPendingQuestions()).toEqual([]);
  });

  test('does not route unowned questions to the active desktop task', () => {
    const { controller, options, request } = setup();
    controller.handleRequested(makeRecord('im-question', 'im-session'));
    expect(options.emitPermissionRequest).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  test('retains a failed submission for retry and coalesces double-clicks', async () => {
    const { controller, request, options } = setup();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    controller.handleRequested(makeRecord());
    let fail: (error: Error) => void = () => {};
    request.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const answer = { behavior: 'allow' as const, updatedInput: { answers: { choice: ['B'] } } };
    const responses = Promise.allSettled([controller.respond(requestId(), answer), controller.respond(requestId(), answer)]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(options.emitPermissionResolved).not.toHaveBeenCalled();
    fail(new Error('disconnected'));
    expect((await responses).map((result) => result.status)).toEqual(['rejected', 'rejected']);
    await controller.respond(requestId(), answer);
    expect(request).toHaveBeenCalledTimes(2);
    expect(options.emitPermissionResolved).toHaveBeenCalledTimes(1);
  });

  test('does not send malformed answers or silently dismiss a disconnected submission', async () => {
    const { controller, request, options, disconnectClient } = setup();
    controller.handleRequested(makeRecord());
    await expect(controller.respond(requestId(), { behavior: 'allow', updatedInput: { answers: {} } })).rejects.toThrow();
    disconnectClient();
    await expect(controller.respond(requestId(), { behavior: 'deny', message: 'cancel' })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    expect(options.emitPermissionResolved).not.toHaveBeenCalled();
  });

  test.each([OpenClawQuestionStatus.Answered, OpenClawQuestionStatus.Cancelled, OpenClawQuestionStatus.Expired])(
    'dismisses remote %s once and ignores late requested events', (status) => {
      const { controller, options } = setup();
      controller.handleRequested(makeRecord());
      controller.handleResolved({ id: 'request-1', status });
      controller.handleResolved({ id: 'request-1', status });
      controller.handleRequested(makeRecord());
      expect(options.emitPermissionResolved).toHaveBeenCalledTimes(1);
      expect(options.emitPermissionRequest).toHaveBeenCalledTimes(1);
    },
  );

  test('closes expired UI even if the resolved event is missed', async () => {
    const { controller, options, request } = setup();
    controller.handleRequested(makeRecord());
    await vi.advanceTimersByTimeAsync(900_000);
    expect(options.emitPermissionResolved).toHaveBeenCalledTimes(1);
    await controller.respond(requestId(), { behavior: 'deny', message: 'late' });
    expect(request).not.toHaveBeenCalled();
  });

  test('cancels only the stopped session and suppresses late questions for it', () => {
    const { controller, options, request } = setup();
    controller.handleRequested(makeRecord());
    controller.handleRequested(makeRecord('request-2', 'desktop-2'));
    controller.cancelBySession('desktop-1');
    expect(options.emitPermissionResolved).toHaveBeenCalledWith('desktop-1', requestId());
    expect(options.emitPermissionResolved).not.toHaveBeenCalledWith('desktop-2', requestId('request-2'));
    options.isSessionStopped.mockReturnValue(true);
    controller.handleRequested(makeRecord('late'));
    expect(request).toHaveBeenCalledWith(OpenClawQuestion.Resolve, { id: 'late', cancel: true }, expect.anything());
    expect(options.emitPermissionRequest).toHaveBeenCalledTimes(2);
  });

  test('restores questions after reconnect and rejects a stale list from the previous connection', async () => {
    const { controller, options, request } = setup();
    const record = makeRecord();
    controller.handleRequested(record);
    let completeList: (value: unknown) => void = () => {};
    request.mockImplementationOnce(() => new Promise((resolve) => { completeList = resolve; }));
    const restoring = controller.restorePending();
    controller.disconnect();
    completeList({ questions: [record] });
    await restoring;
    expect(options.emitPermissionRequest).toHaveBeenCalledTimes(1);
    request.mockResolvedValueOnce({ questions: [record] });
    await controller.restorePending();
    expect(options.emitPermissionRequest).toHaveBeenCalledTimes(2);
    expect(options.emitPermissionResolved).toHaveBeenCalledTimes(1);
  });

  test('a resolved event during question.list prevents resurrection', async () => {
    const { controller, options, request } = setup();
    let completeList: (value: unknown) => void = () => {};
    request.mockImplementationOnce(() => new Promise((resolve) => { completeList = resolve; }));
    const restoring = controller.restorePending();
    controller.handleResolved({ id: 'request-1', status: OpenClawQuestionStatus.Answered });
    completeList({ questions: [makeRecord()] });
    await restoring;
    expect(options.emitPermissionRequest).not.toHaveBeenCalled();
  });

  test('a response already resolved by another client closes locally without retrying', async () => {
    const { controller, request, options } = setup();
    controller.handleRequested(makeRecord());
    request.mockRejectedValueOnce({ details: { reason: 'QUESTION_ALREADY_TERMINAL' } });
    await controller.respond(requestId(), { behavior: 'deny', message: 'cancel' });
    expect(options.emitPermissionResolved).toHaveBeenCalledTimes(1);
  });
});
