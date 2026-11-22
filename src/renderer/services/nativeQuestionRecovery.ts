import { ASK_USER_QUESTION_TOOL_NAME } from '../../shared/cowork/constants';
import { OpenClawQuestion } from '../../shared/cowork/openclawQuestion';
import {
  DSH_APPROVAL_REQUEST_ID_PREFIX,
  DSH_QUESTION_REQUEST_ID_PREFIX,
} from '../../shared/dshEngine/hostConstants';
import { readMediaConfirmationState } from '../../shared/media/confirmation';
import type { CoworkPermissionRequest } from '../types/cowork';

type RecoveryApi = {
  getPendingQuestions?: () => Promise<CoworkPermissionRequest[]>;
  onStreamPermissionDismiss: (callback: (data: { requestId: string }) => void) => () => void;
};

function isRecoverablePendingInteraction(request: CoworkPermissionRequest): boolean {
  return (
    request.toolName === OpenClawQuestion.ToolName
    || request.toolName === ASK_USER_QUESTION_TOOL_NAME
    || request.requestId.startsWith(DSH_QUESTION_REQUEST_ID_PREFIX)
    || request.requestId.startsWith(DSH_APPROVAL_REQUEST_ID_PREFIX)
    || Boolean(readMediaConfirmationState(request.toolInput?.mediaConfirmation))
  );
}

/** Recover after renderer reload; a concurrent resolution must not resurrect a stale snapshot. */
export function restoreNativeQuestionPermissions(api: RecoveryApi, enqueue: (request: CoworkPermissionRequest) => void): () => void {
  if (!api.getPendingQuestions) return () => {};
  let cancelled = false;
  const dismissed = new Set<string>();
  const unsubscribe = api.onStreamPermissionDismiss(({ requestId }) => dismissed.add(requestId));
  void api.getPendingQuestions().then((requests) => {
    if (cancelled) return;
    for (const request of requests) {
      if (isRecoverablePendingInteraction(request) && !dismissed.has(request.requestId)) {
        enqueue(request);
      }
    }
  }).catch((error) => {
    if (!cancelled) console.warn('[NativeQuestion] failed to recover pending questions:', error);
  }).finally(unsubscribe);
  return () => { cancelled = true; unsubscribe(); };
}
