import { OwnershipErrorCode, OwnershipResultStatus, OwnershipSyncState, OwnershipTargetKind } from '@shared/ownership/constants';
import type { OwnershipCommitResult, OwnershipDetail, OwnershipPreview } from '@shared/ownership/types';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const harness = vi.hoisted(() => ({ generation: 1, loggedIn: true, subscribers: new Set<() => void>() }));
vi.mock('../store', () => ({ store: {
  getState: () => ({ auth: { accountGeneration: harness.generation, isLoggedIn: harness.loggedIn } }),
  subscribe: (callback: () => void) => { harness.subscribers.add(callback); return () => harness.subscribers.delete(callback); },
} }));
vi.mock('./i18n', () => ({ i18nService: { t: (key: string) => key } }));

import type { ToastEventDetail } from '../components/Toast';
import { ownershipService, OwnershipView } from './ownership';
import { readOwnershipPending, saveOwnershipPending } from './ownershipPending';

const target = { kind: OwnershipTargetKind.Task, id: 'task-a' };
const detail: OwnershipDetail = {
  ...target, title: 'Local task', ownership: { kind: 'anonymous', label: '', scopeLabel: '' },
  deviceName: 'Desktop', syncState: OwnershipSyncState.Local, canAssociate: true, accountPartition: 'account-a',
};
const preview: OwnershipPreview = {
  planId: 'plan', planVersion: 'v1', accountGeneration: 'main-epoch', expiresAt: Date.now() + 30_000,
  account: { label: 'A', scopeLabel: 'Personal', partition: 'account-a' }, eligible: true,
  kind: target.kind, targetId: target.id, targetTitle: 'Local task', agentId: 'main',
  anonymousTaskCount: 1, subtaskCount: 0, existingOwnedTaskCount: 0,
  tasks: [{ id: target.id, title: 'Local task', isSubtask: false }], agentWillAssociate: false,
};
const result: OwnershipCommitResult = {
  status: OwnershipResultStatus.Associated, operationId: 'operation', requestId: 'request',
  agentIds: [], sessionIds: [target.id], syncState: OwnershipSyncState.Pending, accountPartition: 'account-a',
};
const api = {
  getDetail: vi.fn(), preview: vi.fn(), commit: vi.fn(), getResult: vi.fn(), onChanged: vi.fn(() => () => {}),
};
const remote = { state: vi.fn(), configure: vi.fn() };
const dispatchEvent = vi.fn();
const failedDetail: OwnershipDetail = {
  ...detail, canAssociate: false, syncState: OwnershipSyncState.Failed,
  ownership: { kind: 'owned', label: 'A', scopeLabel: 'Personal' },
};
function toast() { return (dispatchEvent.mock.calls[0][0] as CustomEvent<ToastEventDetail>).detail; }
let dispose: (() => void) | undefined;
function switchAccount(generation: number, loggedIn = true) {
  harness.generation = generation; harness.loggedIn = loggedIn;
  harness.subscribers.forEach(callback => callback());
}
async function settle() { await new Promise(resolve => setTimeout(resolve, 0)); }

beforeEach(() => {
  harness.generation = 1; harness.loggedIn = true;
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  vi.stubGlobal('window', { dispatchEvent, electron: { ownership: api, remote } });
  vi.clearAllMocks();
  api.getDetail.mockResolvedValue({ success: true, data: detail });
  api.preview.mockResolvedValue({ success: true, data: preview });
  api.commit.mockResolvedValue({ success: true, data: result });
  api.getResult.mockResolvedValue({ success: true, data: result });
  remote.state.mockResolvedValue({ owner: { userId: 'A' }, enabled: true });
  remote.configure.mockResolvedValue({});
  ownershipService.close();
});
afterEach(() => { dispose?.(); dispose = undefined; ownershipService.close(); vi.unstubAllGlobals(); });

describe('ownership confirmation and recovery', () => {
  test.each([OwnershipSyncState.Local, OwnershipSyncState.Pending, OwnershipSyncState.Synced, OwnershipSyncState.WaitingService])(
    'closes only after a confirmed local commit and reports association without claiming sync success (%s)', async syncState => {
      let resolve!: (value: unknown) => void;
      api.commit.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
      await ownershipService.open(target, OwnershipView.Preview);
      const revision = ownershipService.getRevision();
      const committing = ownershipService.commit();
      expect(ownershipService.getSnapshot()?.loading).toBe(true);
      expect(dispatchEvent).not.toHaveBeenCalled();
      resolve({ success: true, data: { ...result, syncState } });
      await committing;
      expect(ownershipService.getSnapshot()).toBeNull();
      expect(ownershipService.getRevision()).toBeGreaterThan(revision);
      expect(readOwnershipPending(localStorage)).toEqual([]);
      expect(dispatchEvent).toHaveBeenCalledTimes(1);
      expect(dispatchEvent.mock.calls[0][0].type).toBe('app:showToast');
      expect(toast()).toEqual({ message: 'ownershipSuccess' });
    },
  );
  test('saves original pending confirmation before commit and reconciles a lost response without another commit', async () => {
    api.commit.mockImplementation(async () => {
      const pending = readOwnershipPending(localStorage);
      expect(pending).toHaveLength(1);
      expect(pending[0].request.planId).toBe(preview.planId);
      throw new Error('lost IPC response');
    });
    await ownershipService.open(target, OwnershipView.Preview);
    await ownershipService.commit();
    expect(api.commit).toHaveBeenCalledTimes(1);
    expect(api.getResult).toHaveBeenCalledTimes(1);
    expect(readOwnershipPending(localStorage)).toHaveLength(0);
    expect(ownershipService.getSnapshot()).toBeNull();
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect(toast()).toEqual({ message: 'ownershipSuccess' });
  });
  test('unknown result retains the intent; a confirmed non-commit requires a new user confirmation', async () => {
    api.commit.mockRejectedValue(new Error('transport'));
    api.getResult.mockRejectedValue(new Error('transport'));
    await ownershipService.open(target, OwnershipView.Preview);
    await ownershipService.commit();
    const pending = readOwnershipPending(localStorage)[0];
    expect(ownershipService.getSnapshot()?.view).toBe(OwnershipView.Unknown);
    expect(dispatchEvent).not.toHaveBeenCalled();
    api.getResult.mockResolvedValue({ success: true, data: { status: OwnershipResultStatus.NotCommitted } });
    await ownershipService.reconcile(pending);
    expect(ownershipService.getSnapshot()?.view).toBe(OwnershipView.Detail);
    expect(readOwnershipPending(localStorage)).toEqual([]);
    expect(api.commit).toHaveBeenCalledTimes(1);
    expect(dispatchEvent).not.toHaveBeenCalled();
  });
  test('a confirmed association rejection keeps the error panel without a success toast', async () => {
    api.commit.mockResolvedValue({ success: false, error: { code: OwnershipErrorCode.LocalCommitFailed } });
    api.getResult.mockResolvedValue({ success: true, data: { status: OwnershipResultStatus.NotCommitted } });
    await ownershipService.open(target, OwnershipView.Preview);
    await ownershipService.commit();
    expect(ownershipService.getSnapshot()).toMatchObject({ view: OwnershipView.Detail, error: OwnershipErrorCode.LocalCommitFailed });
    expect(dispatchEvent).not.toHaveBeenCalled();
  });
  test('sync failure closes the success panel and offers a sync-only retry', async () => {
    api.commit.mockResolvedValue({ success: true, data: { ...result, syncState: OwnershipSyncState.Failed } });
    await ownershipService.open(target, OwnershipView.Preview);
    await ownershipService.commit();
    expect(ownershipService.getSnapshot()).toBeNull();
    expect(toast()).toMatchObject({ message: 'ownershipAssociationSyncFailed', actionLabel: 'ownershipRetrySync' });
    api.getDetail.mockResolvedValue({ success: true, data: failedDetail });
    toast().onAction!();
    await settle();
    expect(ownershipService.getSnapshot()).toMatchObject({ view: OwnershipView.Detail, notice: 'ownershipRetryScheduled' });
    expect(remote.configure).toHaveBeenCalledExactlyOnceWith({ retry: true });
    expect(api.commit).toHaveBeenCalledTimes(1);
  });
  test('a stale failure toast cannot retry after switching accounts', async () => {
    api.commit.mockResolvedValue({ success: true, data: { ...result, syncState: OwnershipSyncState.Failed } });
    await ownershipService.open(target, OwnershipView.Preview);
    await ownershipService.commit();
    const action = toast().onAction!;
    api.getDetail.mockClear();
    switchAccount(2);
    action();
    await settle();
    expect(api.getDetail).not.toHaveBeenCalled();
    expect(remote.configure).not.toHaveBeenCalled();
  });
  test('a delayed commit from the previous account cannot close another panel or show success', async () => {
    let resolve!: (value: unknown) => void;
    api.commit.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await ownershipService.open(target, OwnershipView.Preview);
    const committing = ownershipService.commit();
    switchAccount(2);
    const another = { ...target, id: 'task-b' };
    await ownershipService.open(another);
    resolve({ success: true, data: result });
    await committing;
    expect(ownershipService.getSnapshot()?.target).toEqual(another);
    expect(dispatchEvent).not.toHaveBeenCalled();
    expect(readOwnershipPending(localStorage)).toHaveLength(1);
  });
  test('retry from a menu cannot wake sync after its detail request is superseded', async () => {
    let resolve!: (value: unknown) => void;
    api.getDetail.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const retrying = ownershipService.retrySync(target);
    await ownershipService.open({ ...target, id: 'task-b' });
    resolve({ success: true, data: failedDetail });
    await retrying;
    expect(remote.configure).not.toHaveBeenCalled();
    expect(api.commit).not.toHaveBeenCalled();
  });
  test('restart reconciliation of a durable receipt closes the recovery panel without re-association', async () => {
    saveOwnershipPending(localStorage, {
      partition: 'account-a', target,
      request: { planId: 'old', planVersion: 'v1', requestId: 'old-request', accountGeneration: 'old-epoch' },
    });
    api.getResult.mockResolvedValue({ success: true, data: { ...result, status: OwnershipResultStatus.AlreadyAssociated } });
    dispose = ownershipService.start();
    await settle();
    expect(ownershipService.getSnapshot()).toBeNull();
    expect(readOwnershipPending(localStorage)).toEqual([]);
    expect(toast()).toEqual({ message: 'ownershipSuccess' });
    expect(api.commit).not.toHaveBeenCalled();
  });
  test('account change clears previews and drops a late private detail response', async () => {
    dispose = ownershipService.start();
    let resolve!: (value: unknown) => void;
    api.getDetail.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const opening = ownershipService.open(target);
    switchAccount(2);
    resolve({ success: true, data: detail });
    await opening;
    expect(ownershipService.getSnapshot()).toBeNull();
  });
  test('login return re-previews but never commits automatically', async () => {
    harness.loggedIn = false;
    dispose = ownershipService.start();
    api.preview.mockResolvedValueOnce({ success: true, data: { ...preview, eligible: false, account: null, reason: OwnershipErrorCode.AuthRequired } });
    await ownershipService.open(target, OwnershipView.Preview);
    ownershipService.waitForLogin();
    switchAccount(2);
    await settle();
    expect(api.preview).toHaveBeenCalledTimes(2);
    expect(ownershipService.getSnapshot()?.preview?.eligible).toBe(true);
    expect(api.commit).not.toHaveBeenCalled();
  });
  test('restart recovery does not query or display another account partition', async () => {
    saveOwnershipPending(localStorage, {
      partition: 'account-b', target,
      request: { planId: 'old', planVersion: 'v1', requestId: 'old-request', accountGeneration: 'old-epoch' },
    });
    dispose = ownershipService.start();
    await settle();
    expect(api.getResult).not.toHaveBeenCalled();
    expect(ownershipService.getSnapshot()).toBeNull();
    expect(readOwnershipPending(localStorage)).toHaveLength(1);
  });
});
