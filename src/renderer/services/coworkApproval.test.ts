import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { ApprovalDecisionOutcome, ApprovalState } from '../../shared/cowork/approval';
import { OpenClawQuestion } from '../../shared/cowork/openclawQuestion';
import { store } from '../store';
import { resetAccountSessionData } from '../store/accountSessionBoundary';
import { invalidateAuthAccountContext } from '../store/slices/authSlice';
import { enqueuePendingPermission, updatePendingPermissionState } from '../store/slices/coworkSlice';
import type { CoworkPermissionRequest, CoworkPermissionResult } from '../types/cowork';
import { coworkService } from './cowork';

vi.mock('./i18n', () => ({ i18nService: { t: (key: string) => key } }));

const pending = (): ApprovalState => ({
  requestId: 'approval-1', sessionId: 'session-1', runId: 'run-1', approvalVersion: '1', operationDigest: 'digest-1',
  title: 'Delete draft?', summary: 'Delete draft.md in the workspace.', expiresAt: '2099-01-01T00:00:00.000Z',
  remoteAllowed: true, requiresLocalAction: false, status: 'pending', resolvedAt: null,
  resolution: { phase: 'idle', source: null, confirmedDecision: null, confirmedAt: null },
});
const enqueue = (approval = pending()) => store.dispatch(enqueuePendingPermission({
  sessionId: approval.sessionId, requestId: approval.requestId, toolName: 'Bash', toolInput: {}, approval,
}));
const confirmed = (): ApprovalState => ({ ...pending(), approvalVersion: '3', status: 'approved',
  resolvedAt: '2026-09-10T08:00:00Z',
  resolution: { phase: 'finished', source: 'desktop', confirmedDecision: 'approve', confirmedAt: '2026-09-10T08:00:00Z' },
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};
type Response = { success: boolean; outcome?: ApprovalDecisionOutcome };
const allow = { behavior: 'allow' as const, updatedInput: {} };

beforeEach(() => {
  coworkService.destroy();
  store.dispatch(resetAccountSessionData());
});
afterEach(() => { coworkService.destroy(); vi.unstubAllGlobals(); });

test('double clicks send one immutable submission and keep the dialog until runtime confirmation', async () => {
  const reply = deferred<Response>();
  const respondToPermission = vi.fn(() => reply.promise);
  vi.stubGlobal('window', { electron: { cowork: { respondToPermission } } });
  enqueue();
  const first = coworkService.respondToPermission('approval-1', allow);
  expect(await coworkService.respondToPermission('approval-1', { behavior: 'deny', message: 'No' })).toBe(false);
  expect(respondToPermission).toHaveBeenCalledTimes(1);
  expect(respondToPermission).toHaveBeenCalledWith({ requestId: 'approval-1', result: allow,
    submissionId: expect.any(String), expectedVersion: '1', operationDigest: 'digest-1' });
  expect(store.getState().cowork.pendingPermissions[0].submissionState).toBe('submitting');
  reply.resolve({ success: true, outcome: { kind: 'confirmed', decision: 'approve', state: confirmed() } });
  expect(await first).toBe(true);
  expect(store.getState().cowork.pendingPermissions).toEqual([]);
});

test('lost IPC response keeps the decision locked until a later authoritative state arrives', async () => {
  const respondToPermission = vi.fn().mockRejectedValue(new Error('IPC disconnected'));
  vi.stubGlobal('window', { electron: { cowork: { respondToPermission } } });
  enqueue();
  expect(await coworkService.respondToPermission('approval-1', allow)).toBe(false);
  expect(store.getState().cowork.pendingPermissions[0]).toMatchObject({
    submissionState: 'unknown', submissionError: 'coworkApprovalUnknown',
  });
  await coworkService.respondToPermission('approval-1', { behavior: 'deny', message: 'No' });
  expect(respondToPermission).toHaveBeenCalledTimes(1);
  store.dispatch(updatePendingPermissionState(confirmed()));
  expect(store.getState().cowork.pendingPermissions).toEqual([]);
});

test('known never-dispatched failure unlocks only after the runtime supplies its newer idle version', async () => {
  const respondToPermission = vi.fn().mockResolvedValue({ success: false,
    outcome: { kind: 'known_not_applied', state: { ...pending(), approvalVersion: '3' } } });
  vi.stubGlobal('window', { electron: { cowork: { respondToPermission } } });
  enqueue();
  await coworkService.respondToPermission('approval-1', allow);
  expect(store.getState().cowork.pendingPermissions[0]).toMatchObject({
    approval: { approvalVersion: '3', resolution: { phase: 'idle' } },
    submissionState: undefined,
    submissionError: 'coworkApprovalNotApplied',
  });
  await coworkService.respondToPermission('approval-1', allow);
  expect(respondToPermission.mock.calls[1][0].expectedVersion).toBe('3');
  expect(respondToPermission.mock.calls[1][0].submissionId).not.toBe(respondToPermission.mock.calls[0][0].submissionId);
});

test('late confirmation from an old account does not refill the new account approval cache', async () => {
  const reply = deferred<Response>();
  vi.stubGlobal('window', { electron: { cowork: { respondToPermission: () => reply.promise } } });
  enqueue();
  const first = coworkService.respondToPermission('approval-1', allow);
  store.dispatch(invalidateAuthAccountContext());
  reply.resolve({ success: true, outcome: { kind: 'confirmed', decision: 'approve', state: confirmed() } });
  expect(await first).toBe(false);
  expect(store.getState().cowork.pendingPermissions).toEqual([]);
  expect(store.getState().cowork.permissionStates).toEqual({});
});

test('reload hydration cannot reopen an approval resolved while the IPC list was in flight', async () => {
  const reply = deferred<{ success: boolean; items: unknown[] }>();
  let onState!: (event: { state: ApprovalState }) => void;
  const noopListener = () => () => undefined;
  vi.stubGlobal('window', { electron: { cowork: {
    onStreamMessage: noopListener, onStreamMessageUpdate: noopListener, onStreamPermission: noopListener,
    onStreamPermissionDismiss: noopListener, onStreamComplete: noopListener, onStreamError: noopListener,
    onSessionsChanged: noopListener,
    onStreamPermissionState: (listener: typeof onState) => { onState = listener; return () => undefined; },
    listPendingPermissions: () => reply.promise,
  } } });
  (coworkService as unknown as { setupStreamListeners: () => void }).setupStreamListeners();
  onState({ state: confirmed() });
  reply.resolve({ success: true, items: [{ sessionId: 'session-1', request: {
    requestId: 'approval-1', toolName: 'Bash', toolInput: {}, approval: pending(),
  } }] });
  await vi.waitFor(() => expect(store.getState().cowork.permissionStates['approval-1'].status).toBe('approved'));
  expect(store.getState().cowork.pendingPermissions).toEqual([]);
});

const nativeQuestion = (id: string): CoworkPermissionRequest => ({
  requestId: `${OpenClawQuestion.RequestIdPrefix}${id}`,
  sessionId: `session-${id}`,
  toolName: OpenClawQuestion.ToolName,
  toolInput: {},
});

test.each([
  { source: 'bridge', requestId: 'question-1' },
  { source: 'native', requestId: `${OpenClawQuestion.RequestIdPrefix}question-1` },
])('$source question submission failures remain retryable for selections and refusals', async ({ requestId }) => {
  const respondToPermission = vi.fn();
  vi.stubGlobal('window', { electron: { cowork: { respondToPermission } } });
  const results: CoworkPermissionResult[] = [
    { behavior: 'allow', updatedInput: { answers: { Cleanup: 'Cancel' } } },
    { behavior: 'deny', message: 'No' },
  ];

  for (const result of results) {
    store.dispatch(enqueuePendingPermission({ ...nativeQuestion('1'), requestId }));
    respondToPermission.mockResolvedValueOnce({ success: false, error: 'APPROVAL_ACCESS_DENIED' });
    expect(await coworkService.respondToPermission(requestId, result)).toBe(false);
    expect(store.getState().cowork.pendingPermissions).toMatchObject([{
      requestId, submissionState: undefined, submissionError: 'coworkQuestionSubmitFailed',
    }]);
    expect(respondToPermission).toHaveBeenLastCalledWith({ requestId, result });

    respondToPermission.mockResolvedValueOnce({ success: true, outcome: { kind: 'question_resolved' } });
    expect(await coworkService.respondToPermission(requestId, result)).toBe(true);
    expect(store.getState().cowork.pendingPermissions).toEqual([]);
  }
  expect(respondToPermission).toHaveBeenCalledTimes(4);
});

test('question IPC rejection shows a retryable submission failure instead of approval reconciliation', async () => {
  const respondToPermission = vi.fn().mockRejectedValueOnce(new Error('IPC disconnected'))
    .mockResolvedValueOnce({ success: true, outcome: { kind: 'question_resolved' } });
  vi.stubGlobal('window', { electron: { cowork: { respondToPermission } } });
  const question = nativeQuestion('1');
  store.dispatch(enqueuePendingPermission(question));

  expect(await coworkService.respondToPermission(question.requestId, allow)).toBe(false);
  expect(store.getState().cowork.pendingPermissions).toMatchObject([{
    requestId: question.requestId, submissionState: undefined, submissionError: 'coworkQuestionSubmitFailed',
  }]);
  expect(await coworkService.respondToPermission(question.requestId, allow)).toBe(true);
  expect(store.getState().cowork.pendingPermissions).toEqual([]);
});

test('permission diagnostics correlate submissions without logging question bodies or answers', async () => {
  const fromRenderer = vi.fn();
  const respondToPermission = vi.fn()
    .mockResolvedValueOnce({ success: false, error: 'APPROVAL_ACCESS_DENIED' })
    .mockRejectedValueOnce(new Error('sensitive-exception-detail'))
    .mockResolvedValueOnce({ success: true, outcome: { kind: 'question_resolved' } });
  vi.stubGlobal('window', { electron: { cowork: { respondToPermission }, log: { fromRenderer } } });
  const permission = { ...nativeQuestion('1'), requestId: 'local-login', toolInput: { question: 'private-question' } };
  store.dispatch(enqueuePendingPermission(permission));
  const answer: CoworkPermissionResult = { behavior: 'allow', updatedInput: { answers: { 'private-question': 'private-answer' } } };
  expect(await coworkService.respondToPermission(permission.requestId, answer)).toBe(false);
  expect(await coworkService.respondToPermission(permission.requestId, answer)).toBe(false);
  expect(await coworkService.respondToPermission(permission.requestId, answer)).toBe(true);
  const logs = JSON.stringify(fromRenderer.mock.calls);
  expect(logs).toContain('requestId=local-login');
  expect(logs).toContain('APPROVAL_ACCESS_DENIED');
  expect(logs).toContain('IPC failed');
  expect(logs).toContain('succeeded');
  for (const value of ['private-question', 'private-answer', 'sensitive-exception-detail']) expect(logs).not.toContain(value);
});

test('diagnostic transport failure cannot prevent a successful permission response', async () => {
  vi.stubGlobal('window', { electron: {
    cowork: { respondToPermission: vi.fn().mockResolvedValue({ success: true }) },
    log: { fromRenderer: () => { throw new Error('Logger unavailable'); } },
  } });
  const permission = nativeQuestion('1');
  store.dispatch(enqueuePendingPermission(permission));
  expect(await coworkService.respondToPermission(permission.requestId, allow)).toBe(true);
  expect(store.getState().cowork.pendingPermissions).toEqual([]);
});

const setupNativeQuestionRecovery = (getPendingQuestions: () => Promise<CoworkPermissionRequest[]>) => {
  const dismissListeners = new Set<(event: { requestId: string }) => void>();
  const noopListener = () => () => undefined;
  vi.stubGlobal('window', { electron: { cowork: {
    onStreamMessage: noopListener, onStreamMessageUpdate: noopListener, onStreamPermission: noopListener,
    onStreamComplete: noopListener, onStreamError: noopListener, onSessionsChanged: noopListener,
    onStreamPermissionDismiss: (listener: (event: { requestId: string }) => void) => {
      dismissListeners.add(listener);
      return () => { dismissListeners.delete(listener); };
    },
    getPendingQuestions,
  } } });
  (coworkService as unknown as { setupStreamListeners: () => void }).setupStreamListeners();
  return {
    dismiss: (requestId: string) => dismissListeners.forEach(listener => listener({ requestId })),
    dismissListeners,
  };
};

test('account changes recover current native questions and discard the previous account snapshot', async () => {
  const previous = deferred<CoworkPermissionRequest[]>();
  const current = deferred<CoworkPermissionRequest[]>();
  const getPendingQuestions = vi.fn().mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise);
  setupNativeQuestionRecovery(getPendingQuestions);

  store.dispatch(invalidateAuthAccountContext());
  expect(getPendingQuestions).toHaveBeenCalledTimes(2);
  current.resolve([nativeQuestion('current')]);
  await vi.waitFor(() => expect(store.getState().cowork.pendingPermissions).toMatchObject([
    nativeQuestion('current'),
  ]));

  previous.resolve([nativeQuestion('previous')]);
  await previous.promise;
  await Promise.resolve();
  expect(store.getState().cowork.pendingPermissions).toMatchObject([nativeQuestion('current')]);
});

test('native question recovery after an account change still ignores concurrent dismissals', async () => {
  const current = deferred<CoworkPermissionRequest[]>();
  const getPendingQuestions = vi.fn().mockResolvedValueOnce([]).mockReturnValueOnce(current.promise);
  const { dismiss } = setupNativeQuestionRecovery(getPendingQuestions);

  store.dispatch(invalidateAuthAccountContext());
  const question = nativeQuestion('dismissed');
  dismiss(question.requestId);
  current.resolve([question]);
  await current.promise;
  await Promise.resolve();
  expect(store.getState().cowork.pendingPermissions).toEqual([]);
});

test('destroy cancels native question recovery and removes the account change subscription', async () => {
  const response = deferred<CoworkPermissionRequest[]>();
  const getPendingQuestions = vi.fn(() => response.promise);
  const { dismissListeners } = setupNativeQuestionRecovery(getPendingQuestions);

  coworkService.destroy();
  store.dispatch(invalidateAuthAccountContext());
  expect(getPendingQuestions).toHaveBeenCalledTimes(1);
  expect(dismissListeners.size).toBe(0);
  response.resolve([nativeQuestion('disposed')]);
  await response.promise;
  await Promise.resolve();
  expect(store.getState().cowork.pendingPermissions).toEqual([]);
});
