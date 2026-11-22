import { expect, test, vi } from 'vitest';

import { ASK_USER_QUESTION_TOOL_NAME } from '../../shared/cowork/constants';
import { OpenClawQuestion } from '../../shared/cowork/openclawQuestion';
import {
  DSH_APPROVAL_REQUEST_ID_PREFIX,
  DSH_QUESTION_REQUEST_ID_PREFIX,
} from '../../shared/dshEngine/hostConstants';
import type { CoworkPermissionRequest } from '../types/cowork';
import { restoreNativeQuestionPermissions } from './nativeQuestionRecovery';

function setup(requests?: CoworkPermissionRequest[]) {
  const permission: CoworkPermissionRequest = {
    requestId: `${OpenClawQuestion.RequestIdPrefix}id`, sessionId: 'session',
    toolName: OpenClawQuestion.ToolName, toolInput: {},
  };
  const snapshot = requests ?? [permission];
  let resolve: (items: CoworkPermissionRequest[]) => void = () => {};
  let dismiss: (data: { requestId: string }) => void = () => {};
  const unsubscribe = vi.fn();
  const api = {
    getPendingQuestions: () => new Promise<CoworkPermissionRequest[]>((callback) => { resolve = callback; }),
    onStreamPermissionDismiss: (callback: typeof dismiss) => { dismiss = callback; return unsubscribe; },
  };
  const enqueue = vi.fn();
  const cleanup = restoreNativeQuestionPermissions(api, enqueue);
  return {
    permission,
    enqueue,
    cleanup,
    unsubscribe,
    resolve: () => resolve(snapshot),
    dismiss: (requestId = permission.requestId) => dismiss({ requestId }),
  };
}

test('restores the pending native question when a renderer reloads', async () => {
  const { resolve, enqueue, permission } = setup();
  resolve();
  await Promise.resolve();
  expect(enqueue).toHaveBeenCalledWith(permission);
});

test('restores pending DSH AskUserQuestion and DSH tool approval prompts after renderer reload', async () => {
  const dshQuestion: CoworkPermissionRequest = {
    requestId: `${DSH_QUESTION_REQUEST_ID_PREFIX}q-42`,
    sessionId: 'session-1',
    toolName: ASK_USER_QUESTION_TOOL_NAME,
    toolInput: { questions: [{ id: 'q1', question: 'How to group photos?' }] },
  };
  const dshApproval: CoworkPermissionRequest = {
    requestId: `${DSH_APPROVAL_REQUEST_ID_PREFIX}a-99`,
    sessionId: 'session-1',
    toolName: 'bash',
    toolInput: { command: 'rm -rf tmp' },
  };
  const unrelated: CoworkPermissionRequest = {
    requestId: 'legacy-unknown-1',
    sessionId: 'session-1',
    toolName: 'bash',
    toolInput: {},
  };

  const { resolve, enqueue, dismiss } = setup([dshQuestion, dshApproval, unrelated]);
  dismiss(dshApproval.requestId);
  resolve();
  await Promise.resolve();

  expect(enqueue).toHaveBeenCalledTimes(1);
  expect(enqueue).toHaveBeenCalledWith(dshQuestion);

  const second = setup([dshApproval]);
  second.resolve();
  await Promise.resolve();
  expect(second.enqueue).toHaveBeenCalledTimes(1);
  expect(second.enqueue).toHaveBeenCalledWith(dshApproval);
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
