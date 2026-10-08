import { OpenClawQuestion } from '../../shared/cowork/openclawQuestion';
import type { CoworkPermissionRequest } from '../types/cowork';

type RecoveryApi = {
  getPendingQuestions?: () => Promise<CoworkPermissionRequest[]>;
  onStreamPermissionDismiss: (callback: (data: { requestId: string }) => void) => () => void;
};

/** Recover after renderer reload; a concurrent resolution must not resurrect a stale snapshot. */
export function restoreNativeQuestionPermissions(api: RecoveryApi, enqueue: (request: CoworkPermissionRequest) => void): () => void {
  if (!api.getPendingQuestions) return () => {};
  let cancelled = false;
  const dismissed = new Set<string>();
  const unsubscribe = api.onStreamPermissionDismiss(({ requestId }) => dismissed.add(requestId));
  void api.getPendingQuestions().then((requests) => {
    if (cancelled) return;
    for (const request of requests) {
      if (request.toolName === OpenClawQuestion.ToolName && !dismissed.has(request.requestId)) enqueue(request);
    }
  }).catch((error) => {
    if (!cancelled) console.warn('[NativeQuestion] failed to recover pending questions:', error);
  }).finally(unsubscribe);
  return () => { cancelled = true; unsubscribe(); };
}
