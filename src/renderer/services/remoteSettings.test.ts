import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { RemoteSettingsError,type RemoteSettingsState } from '../../shared/remote/constants';
import { RemoteSettingsService } from './remoteSettings';

const state = (changes: Partial<RemoteSettingsState> = {}): RemoteSettingsState => ({
  owner: { userId: 'a', scopeKey: 'personal' }, accountEpoch: 'a-1', stateRevision: 1,
  enabled: true, connected: false, keepAwakeEnabled: true, name: 'Computer', workspaces: [], accessRequests: [],
  ...changes,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}

function fixture(initial = state()) {
  const unsubscribeRemote = vi.fn();
  let onChanged: (value: RemoteSettingsState) => void = () => {};
  const order: string[] = [];
  const api = {
    state: vi.fn(async () => { order.push('state'); return initial; }),
    configure: vi.fn(async () => initial),
    onChanged: vi.fn((listener: (value: RemoteSettingsState) => void) => {
      order.push('subscribe');
      onChanged = listener;
      return unsubscribeRemote;
    }),
  };
  const service = new RemoteSettingsService(() => api);
  return { service, api, order, unsubscribeRemote, emit: (value: RemoteSettingsState) => onChanged(value) };
}

describe('RemoteSettingsService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  test('keeps the snapshot stable and starts one subscription before reading and polling', async () => {
    const f = fixture();
    const initial = f.service.getSnapshot();
    expect(f.service.getSnapshot()).toBe(initial);
    expect(initial).toEqual({ state: null, busy: false, error: null });
    const offFirst = f.service.subscribe(vi.fn());
    const offSecond = f.service.subscribe(vi.fn());
    await Promise.resolve();
    expect(f.order).toEqual(['subscribe', 'state']);
    expect(f.service.getSnapshot().state).toEqual(state());
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.api.state).toHaveBeenCalledTimes(2);
    offFirst();
    expect(f.unsubscribeRemote).not.toHaveBeenCalled();
    offSecond();
    expect(f.unsubscribeRemote).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.api.state).toHaveBeenCalledTimes(2);
  });

  test('ignores reads superseded by a newer notification and late closed-subscription events', async () => {
    const f = fixture();
    const read = deferred<RemoteSettingsState>();
    f.api.state.mockReturnValueOnce(read.promise);
    const off = f.service.subscribe(vi.fn());
    f.emit(state({ stateRevision: 3, enabled: false }));
    read.resolve(state());
    await Promise.resolve();
    expect(f.service.getSnapshot().state?.enabled).toBe(false);
    off();
    f.emit(state({ stateRevision: 4, enabled: true }));
    expect(f.service.getSnapshot().state?.enabled).toBe(false);
  });

  test('only submits supplied changes and the current account epoch', async () => {
    const f = fixture();
    await f.service.refresh();
    f.api.configure.mockResolvedValue(state({ enabled: false, stateRevision: 2 }));
    expect(await f.service.submit({ enabled: false, expectedAccountEpoch: 'forged' })).toBe(true);
    expect(f.api.configure).toHaveBeenCalledWith({ enabled: false, expectedAccountEpoch: 'a-1' });
    expect(f.service.getSnapshot()).toMatchObject({ busy: false, error: null, state: { enabled: false } });
  });

  test('rejects this click after refreshing a missing account epoch', async () => {
    const f = fixture(state({ accountEpoch: undefined }));
    await f.service.refresh();
    f.api.state.mockResolvedValue(state());
    expect(await f.service.submit({ enabled: false })).toBe(false);
    expect(f.api.configure).not.toHaveBeenCalled();
    expect(f.service.getSnapshot().state?.accountEpoch).toBe('a-1');
  });

  test('does not configure for a signed-out identity', async () => {
    const f = fixture(state({ owner: null, accountEpoch: 'signed-out', enabled: false }));
    await f.service.refresh();
    expect(await f.service.submit({ enabled: true })).toBe(false);
    expect(f.api.configure).not.toHaveBeenCalled();
  });

  test('blocks concurrent writes and finishes a submission after the last subscriber closes', async () => {
    const f = fixture();
    const off = f.service.subscribe(vi.fn());
    await Promise.resolve();
    const saved = deferred<RemoteSettingsState>();
    f.api.configure.mockReturnValueOnce(saved.promise);
    const pending = f.service.submit({ enabled: false });
    off();
    expect(f.service.getSnapshot().busy).toBe(true);
    expect(await f.service.submit({ keepAwakeEnabled: false })).toBe(false);
    expect(f.api.configure).toHaveBeenCalledOnce();
    const reopen = f.service.subscribe(vi.fn());
    expect(f.service.getSnapshot().busy).toBe(true);
    saved.resolve(state({ enabled: false, stateRevision: 2 }));
    expect(await pending).toBe(true);
    expect(f.service.getSnapshot()).toMatchObject({ busy: false, state: { enabled: false } });
    reopen();
  });

  test('reconciles a lost successful reply without issuing another configure call', async () => {
    const f = fixture();
    await f.service.refresh();
    f.api.configure.mockRejectedValueOnce(new Error('Reply lost'));
    f.api.state.mockResolvedValue(state({ enabled: false, stateRevision: 2 }));
    expect(await f.service.submit({ enabled: false })).toBe(true);
    expect(f.service.getSnapshot()).toMatchObject({ error: null, state: { enabled: false } });
    expect(f.api.configure).toHaveBeenCalledOnce();
  });

  test('preserves the confirmed previous value when local persistence failed', async () => {
    const f = fixture();
    await f.service.refresh();
    f.api.configure.mockRejectedValueOnce(new Error('Disk full'));
    expect(await f.service.submit({ enabled: false })).toBe(false);
    expect(f.service.getSnapshot()).toMatchObject({ error: 'remoteSaveFailed', state: { enabled: true } });
  });

  test('re-reads an unknown outcome before accepting another user change', async () => {
    const f = fixture();
    await f.service.refresh();
    f.api.configure.mockRejectedValueOnce(new Error('Reply lost'));
    f.api.state.mockRejectedValueOnce(new Error('Read failed'));
    expect(await f.service.submit({ enabled: false })).toBe(false);
    expect(f.service.getSnapshot().error).toBe('remoteSettingsUnconfirmed');
    f.api.state.mockResolvedValue(state({ enabled: false, stateRevision: 2 }));
    expect(await f.service.submit({ enabled: false })).toBe(false);
    expect(f.api.configure).toHaveBeenCalledOnce();
    expect(f.service.getSnapshot()).toMatchObject({ error: null, state: { enabled: false } });
  });

  test('preserves saved power intent and its OS failure instead of reverting the switch', async () => {
    const f = fixture(state({ keepAwakeEnabled: false }));
    await f.service.refresh();
    f.api.configure.mockResolvedValue(state({ stateRevision: 2, keepAwakeEnabled: true, keepAwakeActive: false, keepAwakeError: 'unavailable' }));
    expect(await f.service.submit({ keepAwakeEnabled: true })).toBe(true);
    expect(f.service.getSnapshot()).toMatchObject({ error: null, state: { keepAwakeEnabled: true, keepAwakeActive: false, keepAwakeError: 'unavailable' } });
  });

  test('does not infer retry success from unchanged preference values', async () => {
    const f = fixture();
    await f.service.refresh();
    f.api.configure.mockRejectedValueOnce(new Error('Retry failed'));
    expect(await f.service.submit({ retry: true })).toBe(false);
    expect(f.api.configure).toHaveBeenCalledWith({ retry: true, expectedAccountEpoch: 'a-1' });
    expect(f.service.getSnapshot().error).toBe('remoteSaveFailed');
  });

  test('invalidates pending reads and A-to-B-to-A submission responses', async () => {
    const f = fixture();
    await f.service.refresh();
    const saved = deferred<RemoteSettingsState>();
    const read = deferred<RemoteSettingsState>();
    f.api.configure.mockReturnValueOnce(saved.promise);
    f.api.state.mockReturnValueOnce(read.promise);
    const pending = f.service.submit({ enabled: false });
    const refreshing = f.service.refresh();
    f.service.invalidate();
    f.api.state.mockResolvedValue(state({ accountEpoch: 'b-1', owner: { userId: 'b', scopeKey: 'personal' }, stateRevision: 2 }));
    await f.service.refresh();
    f.service.invalidate();
    f.api.state.mockResolvedValue(state({ accountEpoch: 'a-2', stateRevision: 3 }));
    await f.service.refresh();
    saved.resolve(state({ enabled: false, stateRevision: 2 }));
    read.resolve(state({ enabled: false, stateRevision: 2 }));
    expect(await pending).toBe(false);
    await refreshing;
    expect(f.service.getSnapshot()).toMatchObject({ busy: false, error: null, state: { enabled: true, accountEpoch: 'a-2' } });
  });

  test('handles an identity-change notification before the App invalidation arrives', async () => {
    const f = fixture();
    f.service.subscribe(vi.fn());
    await Promise.resolve();
    const saved = deferred<RemoteSettingsState>();
    f.api.configure.mockReturnValueOnce(saved.promise);
    const pending = f.service.submit({ enabled: false });
    f.emit(state({ accountEpoch: 'team-1', owner: { userId: 'a', scopeKey: 'team' }, stateRevision: 2 }));
    saved.resolve(state({ enabled: false, stateRevision: 1 }));
    expect(await pending).toBe(false);
    expect(f.service.getSnapshot().state?.owner?.scopeKey).toBe('team');
  });

  test('maps the main-process epoch rejection and never retries the mutation', async () => {
    const f = fixture();
    await f.service.refresh();
    f.api.configure.mockRejectedValueOnce(new Error(`Error invoking remote method: ${RemoteSettingsError.AccountChanged}`));
    expect(await f.service.submit({ enabled: false })).toBe(false);
    expect(f.service.getSnapshot()).toEqual({ state: null, busy: false, error: RemoteSettingsError.AccountChanged });
    expect(f.api.configure).toHaveBeenCalledOnce();
  });

  test('can read the current epoch after its notification preceded App invalidation', async () => {
    const f = fixture();
    f.service.subscribe(vi.fn());
    await Promise.resolve();
    const current = state({ accountEpoch: 'b-1', owner: { userId: 'b', scopeKey: 'personal' }, stateRevision: 2 });
    f.emit(current);
    f.service.invalidate();
    f.emit(state({ stateRevision: 1 }));
    expect(f.service.getSnapshot().state).toBeNull();
    f.api.state.mockResolvedValue(current);
    await f.service.refresh();
    expect(f.service.getSnapshot().state).toBe(current);
    f.emit(state({ stateRevision: 1 }));
    expect(f.service.getSnapshot().state).toBe(current);
  });

  test.each([1, 2])('keeps a new epoch notification when the post-invalidation read returns revision %s', async readRevision => {
    const f = fixture();
    await f.service.refresh();
    f.service.invalidate();
    const read = deferred<RemoteSettingsState>();
    f.api.state.mockReturnValueOnce(read.promise);
    const off = f.service.subscribe(vi.fn());
    const current = state({ accountEpoch: 'b-1', owner: { userId: 'b', scopeKey: 'personal' }, stateRevision: 2 });
    f.emit(current);
    f.emit(state({ stateRevision: 1 }));
    expect(f.service.getSnapshot().state).toBeNull();
    read.resolve(state({ stateRevision: readRevision }));
    await Promise.resolve();
    expect(f.service.getSnapshot().state).toBe(current);
    off();
  });

  test('uses a buffered current identity if the post-invalidation state read fails', async () => {
    const f = fixture();
    await f.service.refresh();
    f.service.invalidate();
    const read = deferred<RemoteSettingsState>();
    f.api.state.mockReturnValueOnce(read.promise);
    const off = f.service.subscribe(vi.fn());
    const current = state({ accountEpoch: 'a-2', stateRevision: 2 });
    f.emit(current);
    read.reject(new Error('Read failed'));
    await Promise.resolve();
    expect(f.service.getSnapshot()).toMatchObject({ state: current, error: null });
    off();
  });

  test('reports state read failures without changing a saved preference', async () => {
    const f = fixture();
    await f.service.refresh();
    f.api.state.mockRejectedValueOnce(new Error('Disconnected'));
    await f.service.refresh();
    expect(f.service.getSnapshot()).toMatchObject({ error: 'remoteStateUnavailable', state: { enabled: true } });
  });
});
