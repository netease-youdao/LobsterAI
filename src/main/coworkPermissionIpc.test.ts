import { expect, test, vi } from 'vitest';

import type { ApprovalState } from '../shared/cowork/approval';
import { SESSION_AGNOSTIC_PERMISSION_SESSION_ID } from '../shared/cowork/constants';
import { OpenClawQuestion } from '../shared/cowork/openclawQuestion';
import { submitCoworkPermission } from './coworkPermissionIpc';
import type { CoworkRuntime } from './libs/agentEngine/types';

const snapshot = {
  requestId: 'approval-1', sessionId: 'session-1', approvalVersion: '3', operationDigest: 'digest-1',
} as ApprovalState;
const request = {
  requestId: 'approval-1', result: { behavior: 'allow' as const, updatedInput: {} },
  submissionId: '416742cf-1a30-4eeb-a195-5e382fdfd8f7', expectedVersion: '3', operationDigest: 'digest-1',
};
function fixture() {
  const respond = vi.fn(async () => ({ kind: 'confirmed' as const, decision: 'approve' as const }));
  const deps = {
    runtime: { getPermissionState: () => snapshot, respondToPermissionConfirmed: respond } as unknown as CoworkRuntime,
    sessionForRequest: () => 'session-1', isRuntimeRequest: () => true,
    canAccessLocalQuestion: () => true,
    canAccessSession: () => true, accountKey: () => 'account-a', resolveQuestion: vi.fn(),
  };
  return { deps, respond };
}

test('desktop IPC uses the confirmed lane and preserves the submitted version and ID', async () => {
  const { deps, respond } = fixture();
  await expect(submitCoworkPermission(request, deps)).resolves.toMatchObject({ kind: 'confirmed' });
  expect(respond).toHaveBeenCalledWith('approval-1', request.result, expect.objectContaining({
    source: 'desktop', submissionId: request.submissionId, expectedVersion: '3', operationDigest: 'digest-1',
  }));
  expect(deps.resolveQuestion).not.toHaveBeenCalled();
});

test('inaccessible requests are rejected before either resolver', async () => {
  const { deps, respond } = fixture();
  deps.canAccessSession = () => false;
  await expect(submitCoworkPermission(request, deps)).rejects.toThrow('APPROVAL_ACCESS_DENIED');
  expect(respond).not.toHaveBeenCalled();
  expect(deps.resolveQuestion).not.toHaveBeenCalled();
});

test('account changes during async preparation are checked at dispatch, including anonymous sessions', async () => {
  const { deps, respond } = fixture();
  let key = 'anonymous';
  deps.accountKey = () => key;
  respond.mockImplementationOnce(async (...args: unknown[]) => {
    key = 'account-a';
    (args[2] as { beforeDispatch: () => void }).beforeDispatch();
    return { kind: 'confirmed', decision: 'approve' };
  });
  await expect(submitCoworkPermission(request, deps)).rejects.toThrow('APPROVAL_ACCESS_DENIED');
});

test('result unknown is not reported as success or sent to the question resolver', async () => {
  const { deps } = fixture();
  deps.runtime.respondToPermissionConfirmed = vi.fn(async () => ({ kind: 'unknown', reason: 'RESULT_UNKNOWN' }));
  await expect(submitCoworkPermission(request, deps)).resolves.toMatchObject({ kind: 'unknown' });
  expect(deps.resolveQuestion).not.toHaveBeenCalled();
});

test('missing runtime state cannot fall through to AskUser and falsely close the dialog', async () => {
  const { deps } = fixture();
  deps.runtime.getPermissionState = () => null;
  await expect(submitCoworkPermission(request, deps)).rejects.toThrow('APPROVAL_UNAVAILABLE');
  expect(deps.resolveQuestion).not.toHaveBeenCalled();
});

test('global question access cannot bypass runtime, native question or session ownership checks', async () => {
  for (const kind of ['approval', 'native', 'session', 'registered'] as const) {
    const { deps, respond } = fixture();
    deps.canAccessSession = () => false;
    deps.sessionForRequest = () => kind === 'session' ? 'session-1' : SESSION_AGNOSTIC_PERMISSION_SESSION_ID;
    deps.runtime.getPermissionState = () => null;
    deps.isRuntimeRequest = () => kind === 'approval';
    if (kind === 'registered') deps.runtime.getQuestionState = () => ({ sessionId: 'session-1' }) as never;
    const canAccessLocalQuestion = vi.fn(() => true);
    const requestId = kind === 'native' ? `${OpenClawQuestion.RequestIdPrefix}question-1` : request.requestId;
    await expect(submitCoworkPermission({ ...request, requestId }, { ...deps, canAccessLocalQuestion }))
      .rejects.toThrow('APPROVAL_ACCESS_DENIED');
    if (kind !== 'session') expect(canAccessLocalQuestion).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
    expect(deps.resolveQuestion).not.toHaveBeenCalled();
  }
});

test('AskUser retains its separate answer payload and resolver', async () => {
  const { deps, respond } = fixture();
  deps.runtime.getPermissionState = () => null;
  deps.isRuntimeRequest = () => false;
  const question = { requestId: 'question-1', result: { behavior: 'allow' as const, updatedInput: { answers: { choice: 'A' } } } };
  await expect(submitCoworkPermission(question, deps)).resolves.toEqual({ kind: 'question_resolved' });
  expect(deps.resolveQuestion).toHaveBeenCalledWith('question-1', question.result);
  expect(respond).not.toHaveBeenCalled();
});

test('missing concurrency metadata is not silently replaced with current approval values', async () => {
  const { deps, respond } = fixture();
  await expect(submitCoworkPermission({ requestId: request.requestId, result: request.result }, deps))
    .rejects.toThrow('INVALID_PERMISSION_RESPONSE');
  expect(respond).not.toHaveBeenCalled();
});

test('native questions await the runtime question resolver without approval metadata', async () => {
  const { deps, respond } = fixture();
  deps.runtime.getPermissionState = () => null;
  const resolveNative = vi.fn(async () => {});
  deps.runtime.respondToPermission = resolveNative;
  const question = {
    requestId: `${OpenClawQuestion.RequestIdPrefix}question-1`,
    result: { behavior: 'allow' as const, updatedInput: { answers: { choice: ['A'] } } },
  };
  await expect(submitCoworkPermission(question, deps)).resolves.toEqual({ kind: 'question_resolved' });
  expect(resolveNative).toHaveBeenCalledWith(question.requestId, question.result);
  expect(respond).not.toHaveBeenCalled();
  expect(deps.resolveQuestion).not.toHaveBeenCalled();

  resolveNative.mockRejectedValueOnce(new Error('offline'));
  await expect(submitCoworkPermission(question, deps)).rejects.toThrow('offline');

  deps.canAccessSession = () => false;
  await expect(submitCoworkPermission(question, deps)).rejects.toThrow('APPROVAL_ACCESS_DENIED');
  expect(resolveNative).toHaveBeenCalledTimes(2);
});

test('native question completion checks that the account has not changed', async () => {
  const { deps } = fixture();
  deps.runtime.getPermissionState = () => null;
  let accountKey = 'account-a';
  deps.accountKey = () => accountKey;
  deps.runtime.respondToPermission = vi.fn(async () => { accountKey = 'account-b'; });
  await expect(submitCoworkPermission({
    requestId: `${OpenClawQuestion.RequestIdPrefix}question-1`,
    result: { behavior: 'deny' },
  }, deps)).rejects.toThrow('APPROVAL_ACCESS_DENIED');
});

test('registered ordinary questions use the shared confirmed lane without legacy fallback', async () => {
  const { deps } = fixture(); deps.runtime.getPermissionState = () => null;
  deps.runtime.getQuestionState = () => ({ sessionId: 'session-1' }) as never;
  const response = vi.fn(async () => ({ kind: 'unknown' as const, reason: 'QUESTION_RESULT_UNKNOWN' }));
  deps.runtime.respondToQuestionConfirmed = response;
  expect(await submitCoworkPermission({ requestId: 'question-1', result: { behavior: 'allow', updatedInput: { answers: { choice: ['A'] } } } }, deps)).toMatchObject({ kind: 'unknown' });
  expect(response).toHaveBeenCalledTimes(1); expect(deps.resolveQuestion).not.toHaveBeenCalled();
});
