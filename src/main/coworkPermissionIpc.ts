import type { ApprovalDecisionOutcome } from '../shared/cowork/approval';
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
  accountKey: () => string;
  resolveQuestion: (requestId: string, result: PermissionResult) => void;
}

/** Runtime approvals wait for execution evidence; local AskUser forms retain their own resolver. */
export async function submitCoworkPermission(
  request: CoworkPermissionSubmission,
  deps: PermissionIpcDependencies,
): Promise<ApprovalDecisionOutcome | { kind: 'question_resolved' }> {
  if (!request || typeof request.requestId !== 'string' || !request.requestId
    || !request.result || !['allow', 'deny'].includes(request.result.behavior)) {
    throw new Error('INVALID_PERMISSION_RESPONSE');
  }
  const snapshot = deps.runtime.getPermissionState?.(request.requestId);
  const sessionId = snapshot?.sessionId ?? deps.sessionForRequest(request.requestId);
  const accountKey = deps.accountKey();
  const assertAccess = (): void => {
    if (!sessionId || !deps.canAccessSession(sessionId) || deps.accountKey() !== accountKey) {
      throw new Error('APPROVAL_ACCESS_DENIED');
    }
  };
  assertAccess();

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
