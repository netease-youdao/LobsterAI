import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { ApprovalDecisionOutcome, ApprovalState } from '../../shared/cowork/approval';
import { store } from '../store';
import { resetAccountSessionData } from '../store/accountSessionBoundary';
import { invalidateAuthAccountContext } from '../store/slices/authSlice';
import { enqueuePendingPermission, updatePendingPermissionState } from '../store/slices/coworkSlice';
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
  expect(store.getState().cowork.pendingPermissions[0].submissionState).toBe('unknown');
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
