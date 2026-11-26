import { randomUUID } from 'crypto';

import type { ApprovalDecisionOutcome } from '../shared/cowork/approval';
import { SESSION_AGNOSTIC_PERMISSION_SESSION_ID } from '../shared/cowork/constants';
import { OpenClawQuestion } from '../shared/cowork/openclawQuestion';
import { DSH_APPROVAL_REQUEST_ID_PREFIX, DSH_QUESTION_REQUEST_ID_PREFIX } from '../shared/dshEngine/hostConstants';
import type { QuestionDecisionOutcome } from '../shared/remote/questions';
import type { CoworkRuntime, PermissionResult } from './libs/agentEngine/types';

export interface CoworkPermissionSubmission {
  requestId: string;
  result: PermissionResult;
  submissionId?: string;
  expectedVersion?: string;
  operationDigest?: string;
}

interface PermissionIpcDependencies {
  runtime: CoworkRuntime;
  sessionForRequest: (requestId: string) => string | undefined;
  isRuntimeRequest: (requestId: string) => boolean;
  canAccessSession: (sessionId: string) => boolean;
  canAccessLocalQuestion: (requestId: string) => boolean;
  accountKey: () => string;
  resolveQuestion: (requestId: string, result: PermissionResult) => void;
}

/** Runtime approvals wait for execution evidence; local AskUser forms retain their own resolver. */
export async function submitCoworkPermission(
  request: CoworkPermissionSubmission,
  deps: PermissionIpcDependencies,
): Promise<ApprovalDecisionOutcome | QuestionDecisionOutcome | { kind: 'question_resolved' }> {
  if (!request || typeof request.requestId !== 'string' || !request.requestId
    || !request.result || !['allow', 'deny'].includes(request.result.behavior)) {
    throw new Error('INVALID_PERMISSION_RESPONSE');
  }
  const snapshot = deps.runtime.getPermissionState?.(request.requestId);
  const question = deps.runtime.getQuestionState?.(request.requestId);
  const sessionId = question?.sessionId ?? snapshot?.sessionId ?? deps.sessionForRequest(request.requestId);
  const accountKey = deps.accountKey();
  const legacyNativeQuestion = request.requestId.startsWith(OpenClawQuestion.RequestIdPrefix);
  const nativeDsh = request.requestId.startsWith(DSH_QUESTION_REQUEST_ID_PREFIX)
    || request.requestId.startsWith(DSH_APPROVAL_REQUEST_ID_PREFIX);
  const isLocalQuestion = !snapshot && !question && !nativeDsh && !legacyNativeQuestion && !deps.isRuntimeRequest(request.requestId);
  const assertAccess = (): void => {
    const accessible = isLocalQuestion
      ? !!sessionId && deps.canAccessLocalQuestion(request.requestId)
        && (sessionId === SESSION_AGNOSTIC_PERMISSION_SESSION_ID || deps.canAccessSession(sessionId))
      : !!sessionId && deps.canAccessSession(sessionId);
    if (!accessible || deps.accountKey() !== accountKey) {
      throw new Error('APPROVAL_ACCESS_DENIED');
    }
  };
  assertAccess();

  if (question) {
    if (!deps.runtime.respondToQuestionConfirmed) throw new Error('QUESTION_UNAVAILABLE');
    const result = await deps.runtime.respondToQuestionConfirmed(request.requestId, request.result, {
      submissionId: request.submissionId || randomUUID(), source: 'desktop', beforeDispatch: assertAccess,
    });
    assertAccess(); return result;
  }
  if (!snapshot && (legacyNativeQuestion || nativeDsh)) {
    const live = deps.runtime.getPendingQuestions?.().some(item =>
      item.requestId === request.requestId && item.sessionId === sessionId && !item.approval);
    // A durable interaction must reconcile through its decision record even when reading it failed.
    if (!live || (nativeDsh && !deps.runtime.isLocalOnlyInteraction?.(request.requestId))) {
      throw new Error('APPROVAL_UNAVAILABLE');
    }
    await deps.runtime.respondToPermission(request.requestId, request.result);
    assertAccess();
    return { kind: 'question_resolved' };
  }

  if (snapshot || deps.isRuntimeRequest(request.requestId)) {
    if (!snapshot || !deps.runtime.respondToPermissionConfirmed) throw new Error('APPROVAL_UNAVAILABLE');
    if (typeof request.submissionId !== 'string'
      || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu.test(request.submissionId)
      || typeof request.expectedVersion !== 'string' || !/^[1-9]\d*$/u.test(request.expectedVersion)
      || typeof request.operationDigest !== 'string' || !request.operationDigest || request.operationDigest.length > 128) {
      throw new Error('INVALID_PERMISSION_RESPONSE');
    }
    const outcome = await deps.runtime.respondToPermissionConfirmed(request.requestId, request.result, {
      submissionId: request.submissionId,
      source: 'desktop',
      expectedVersion: request.expectedVersion,
      operationDigest: request.operationDigest,
      beforeDispatch: assertAccess,
    });
    assertAccess();
    return outcome;
  }

  deps.resolveQuestion(request.requestId, request.result);
  return { kind: 'question_resolved' };
}
