import { expect, test, vi } from 'vitest';

import { OpenClawQuestion } from '../../shared/cowork/openclawQuestion';
import type { CoworkPermissionRequest } from '../types/cowork';
import { restoreNativeQuestionPermissions } from './nativeQuestionRecovery';

function setup() {
  const permission: CoworkPermissionRequest = {
    requestId: `${OpenClawQuestion.RequestIdPrefix}id`, sessionId: 'session',
    toolName: OpenClawQuestion.ToolName, toolInput: {},
  };
  let resolve: (requests: CoworkPermissionRequest[]) => void = () => {};
  let dismiss: (data: { requestId: string }) => void = () => {};
  const unsubscribe = vi.fn();
  const api = {
    getPendingQuestions: () => new Promise<CoworkPermissionRequest[]>((callback) => { resolve = callback; }),
    onStreamPermissionDismiss: (callback: typeof dismiss) => { dismiss = callback; return unsubscribe; },
  };
  const enqueue = vi.fn();
  const cleanup = restoreNativeQuestionPermissions(api, enqueue);
  return { permission, enqueue, cleanup, unsubscribe, resolve: () => resolve([permission]), dismiss: () => dismiss({ requestId: permission.requestId }) };
}

test('restores the pending native question when a renderer reloads', async () => {
  const { resolve, enqueue, permission } = setup();
  resolve();
  await Promise.resolve();
  expect(enqueue).toHaveBeenCalledWith(permission);
});

test('ignores questions resolved between the snapshot and IPC response', async () => {
  const { resolve, enqueue, dismiss } = setup();
  dismiss();
  resolve();
  await Promise.resolve();
  expect(enqueue).not.toHaveBeenCalled();
});

test('does not dispatch into a disposed renderer service', async () => {
  const { resolve, enqueue, cleanup, unsubscribe } = setup();
  cleanup();
  resolve();
  await Promise.resolve();
  expect(enqueue).not.toHaveBeenCalled();
  expect(unsubscribe).toHaveBeenCalled();
});
