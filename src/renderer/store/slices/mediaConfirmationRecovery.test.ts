import { expect, test, vi } from 'vitest';

import { ASK_USER_QUESTION_TOOL_NAME } from '../../../shared/cowork/constants';
import {
  MediaConfirmationPolicy,
  MediaConfirmationStatus,
} from '../../../shared/media/confirmation';
import { restoreNativeQuestionPermissions } from '../../services/nativeQuestionRecovery';
import type { CoworkPermissionRequest } from '../../types/cowork';
import reducer, { enqueuePendingPermission } from './coworkSlice';

const request = (
  sequence: number,
  status = MediaConfirmationStatus.Expired,
): CoworkPermissionRequest => ({
  requestId: 'request',
  sessionId: 'session',
  toolName: ASK_USER_QUESTION_TOOL_NAME,
  toolInput: {
    mediaConfirmation: {
      kind: MediaConfirmationPolicy.Kind,
      revision: 0,
      sequence,
      status,
      retainedUntil: 10000,
    },
  },
});

test('updated confirmation replaces the queued item without stale reload snapshots rolling it back', () => {
  let state = reducer(undefined, enqueuePendingPermission(request(1)));
  state = reducer(state, enqueuePendingPermission(request(3)));
  state = reducer(state, enqueuePendingPermission(request(2)));
  expect(state.pendingPermissions).toHaveLength(1);
  expect(state.pendingPermissions[0].toolInput.mediaConfirmation).toMatchObject({ sequence: 3 });
});

test('renderer reload recovers pending media confirmations through the existing questions snapshot', async () => {
  const enqueue = vi.fn();
  restoreNativeQuestionPermissions(
    {
      getPendingQuestions: async () => [request(1)],
      onStreamPermissionDismiss: () => () => {},
    },
    enqueue,
  );
  await Promise.resolve();
  expect(enqueue).toHaveBeenCalledWith(request(1));
});
