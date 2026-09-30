import { afterEach, describe, expect, test, vi } from 'vitest';

import { RemoteConnectionReleaseState, type RemoteConnectionsSnapshot, RemoteDeviceAdmissionState, type RemoteDeviceConnection,RemoteDeviceConnectionState } from '../../shared/remote/connections';
import type { RemoteSettingsState } from '../../shared/remote/constants';
import { RemoteDeviceConnectionsService } from './remoteDeviceConnections';

const current: RemoteDeviceConnection = { deviceId: 'current', name: 'Current', connectionVersion: '1', connectionState: RemoteDeviceConnectionState.Allowed, admissionState: RemoteDeviceAdmissionState.QuotaBlocked, slotOccupied: false };
const other: RemoteDeviceConnection = { ...current, deviceId: 'other', name: 'Other', admissionState: RemoteDeviceAdmissionState.Online, slotOccupied: true, canRemove: true };
const data: RemoteConnectionsSnapshot = { supported: true, observedAt: '2026-09-18T06:00:00Z', presenceAvailable: true, quota: { maxOnlineDesktops: 5, onlineSlotsUsed: 5, scope: 'account_scope' }, currentDevice: current, connections: [other] };
const state: RemoteSettingsState = { accountEpoch: 'a', owner: { userId: 'a', scopeKey: 'personal' }, deviceConnectionManagementSupported: true, enabled: true, connected: false, name: 'Current', workspaces: [], accessRequests: [] };
const operation = { requestId: 'request-1', deviceId: other.deviceId, connectionVersion: '2', connectionState: RemoteDeviceConnectionState.Removed, releaseState: RemoteConnectionReleaseState.Released, nextAction: 'reconnect' };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
};
const create = (initial: RemoteSettingsState = state) => {
  let currentState = initial;
  let changed: () => void = () => undefined;
  const api = {
    queryConnections: vi.fn(async () => data),
    removeConnection: vi.fn(async () => operation),
    resumeCurrentConnection: vi.fn(async () => ({ ...operation, deviceId: current.deviceId, connectionState: RemoteDeviceConnectionState.Allowed })),
    queryConnectionOperation: vi.fn(async () => operation),
  };
  const settings = { getSnapshot: () => ({ state: currentState, busy: false, error: null }),
    subscribe: (listener: () => void) => { changed = listener; return () => { changed = () => undefined; }; }, refresh: vi.fn(async () => undefined) };
  const ids = vi.fn(() => 'request-1');
  const service = new RemoteDeviceConnectionsService(() => api, settings, ids);
  return { api, settings, service, ids, change: (next: RemoteSettingsState) => { currentState = next; changed(); } };
};

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('device management store', () => {
  test('does not query without login or advertised support', async () => {
    for (const initial of [{ ...state, owner: null }, { ...state, deviceConnectionManagementSupported: false }]) {
      const h = create(initial); const stop = h.service.subscribe(() => undefined);
      await h.service.refresh();
      expect(h.api.queryConnections).not.toHaveBeenCalled();
      stop();
    }
  });
  test('coalesces reads and does not request one list per device', async () => {
    const h = create(); const pending = deferred<RemoteConnectionsSnapshot>();
    h.api.queryConnections.mockReturnValue(pending.promise);
    const stop = h.service.subscribe(() => undefined);
    const first = h.service.refresh(); const second = h.service.refresh();
    expect(first).toBe(second); expect(h.api.queryConnections).toHaveBeenCalledTimes(1);
    pending.resolve(data); await first;
    expect(h.service.getSnapshot().data).toEqual(data);
    stop();
  });
  test('polls only while subscribed, at 15 seconds in foreground and 60 in background', async () => {
    vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0);
    let visibility: (() => void) | undefined;
    const doc = { visibilityState: 'visible', addEventListener: (_: string, listener: () => void) => { visibility = listener; }, removeEventListener: vi.fn() };
    vi.stubGlobal('document', doc);
    const h = create(); const stop = h.service.subscribe(() => undefined); await h.service.refresh();
    await vi.advanceTimersByTimeAsync(15000); expect(h.api.queryConnections).toHaveBeenCalledTimes(2);
    doc.visibilityState = 'hidden'; visibility?.();
    await vi.advanceTimersByTimeAsync(59000); expect(h.api.queryConnections).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000); expect(h.api.queryConnections).toHaveBeenCalledTimes(3);
    stop(); await vi.advanceTimersByTimeAsync(120000); expect(h.api.queryConnections).toHaveBeenCalledTimes(3);
  });
  test('keeps the last observation on failure instead of inventing zero connections', async () => {
    const h = create(); const stop = h.service.subscribe(() => undefined); await h.service.refresh();
    h.api.queryConnections.mockRejectedValueOnce(new Error('network'));
    await h.service.refresh();
    expect(h.service.getSnapshot().data?.quota.onlineSlotsUsed).toBe(5);
    expect(h.service.getSnapshot().error).toBe('remoteConnectionsUnavailable');
    stop();
  });
  test('recovers a transient list failure automatically after a short delay', async () => {
    vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0);
    const h = create(); const stop = h.service.subscribe(() => undefined); await h.service.refresh();
    h.api.queryConnections.mockRejectedValueOnce(new Error('busy'));
    await vi.advanceTimersByTimeAsync(15000);
    expect(h.service.getSnapshot().error).toBe('remoteConnectionsUnavailable');
    expect(h.service.getSnapshot().data).toEqual(data);
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.api.queryConnections).toHaveBeenCalledTimes(3);
    expect(h.service.getSnapshot().error).toBeNull();
    await vi.advanceTimersByTimeAsync(14999); expect(h.api.queryConnections).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1); expect(h.api.queryConnections).toHaveBeenCalledTimes(4);
    stop();
  });
  test('bounds repeated recovery attempts and stops them when the page closes', async () => {
    vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0);
    const h = create(); h.api.queryConnections.mockRejectedValue(new Error('network'));
    const stop = h.service.subscribe(() => undefined); await h.service.refresh();
    let calls = 1;
    for (const delay of [3000, 6000, 12000, 15000, 15000]) {
      await vi.advanceTimersByTimeAsync(delay - 1); expect(h.api.queryConnections).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(1); expect(h.api.queryConnections).toHaveBeenCalledTimes(++calls);
      expect(h.service.getSnapshot().error).toBe('remoteConnectionsUnavailable');
    }
    stop(); await vi.advanceTimersByTimeAsync(60000); expect(h.api.queryConnections).toHaveBeenCalledTimes(calls);
  });
  test('also retries a successful response whose presence information is unavailable', async () => {
    vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0);
    const h = create();
    h.api.queryConnections.mockResolvedValueOnce({ ...data, presenceAvailable: false, quota: { ...data.quota, onlineSlotsUsed: null } });
    const stop = h.service.subscribe(() => undefined); await h.service.refresh();
    expect(h.service.getSnapshot().data?.presenceAvailable).toBe(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.api.queryConnections).toHaveBeenCalledTimes(2);
    expect(h.service.getSnapshot().data?.presenceAvailable).toBe(true);
    stop();
  });
  test('keeps failure polling slow when the window is in the background', async () => {
    vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('document', { visibilityState: 'visible', hasFocus: () => false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const h = create(); h.api.queryConnections.mockRejectedValue(new Error('network'));
    const stop = h.service.subscribe(() => undefined); await h.service.refresh();
    await vi.advanceTimersByTimeAsync(59999); expect(h.api.queryConnections).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(h.api.queryConnections).toHaveBeenCalledTimes(2);
    stop();
  });
  test('refreshes on network recovery and coalesces it with an active list request', async () => {
    vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0);
    const listeners = new Map<string, () => void>();
    vi.stubGlobal('window', { addEventListener: (event: string, listener: () => void) => listeners.set(event, listener),
      removeEventListener: (event: string) => listeners.delete(event) });
    const h = create(); h.api.queryConnections.mockRejectedValueOnce(new Error('offline'));
    const stop = h.service.subscribe(() => undefined); await h.service.refresh();
    const pending = deferred<RemoteConnectionsSnapshot>(); h.api.queryConnections.mockReturnValueOnce(pending.promise);
    listeners.get('online')?.(); listeners.get('online')?.();
    expect(h.api.queryConnections).toHaveBeenCalledTimes(2);
    pending.resolve(data); await h.service.refresh();
    expect(h.service.getSnapshot().error).toBeNull();
    stop(); expect(listeners.size).toBe(0);
  });
  test('clears old account devices immediately and ignores their delayed response', async () => {
    const h = create(); const pending = deferred<RemoteConnectionsSnapshot>();
    h.api.queryConnections.mockReturnValueOnce(pending.promise);
    const stop = h.service.subscribe(() => undefined);
    h.change({ ...state, accountEpoch: 'b', owner: { userId: 'b', scopeKey: 'personal' }, deviceConnectionManagementSupported: false });
    expect(h.service.getSnapshot().data).toBeNull();
    pending.resolve(data); await pending.promise;
    expect(h.service.getSnapshot().data).toBeNull(); expect(h.service.getSnapshot().accountEpoch).toBe('b');
    stop();
  });
  test('queries an uncertain mutation receipt without issuing another mutation', async () => {
    const h = create(); const stop = h.service.subscribe(() => undefined); await h.service.refresh();
    h.api.removeConnection.mockRejectedValueOnce(new Error('timeout'));
    expect(await h.service.remove(other)).toBe(true);
    expect(h.api.removeConnection).toHaveBeenCalledTimes(1);
    expect(h.api.queryConnectionOperation).toHaveBeenCalledWith({ expectedAccountEpoch: 'a', requestId: 'request-1' });
    expect(h.service.getSnapshot().operations.other.unconfirmed).toBe(false);
    stop();
  });
  test('retries an unconfirmed remove with its exact original id and version', async () => {
    const h = create(); const stop = h.service.subscribe(() => undefined); await h.service.refresh();
    h.api.removeConnection.mockRejectedValueOnce(new Error('timeout'));
    h.api.queryConnectionOperation.mockRejectedValue(new Error('unreachable'));
    expect(await h.service.remove(other)).toBe(false);
    expect(await h.service.remove({ ...other, connectionVersion: '3' })).toBe(true);
    expect(h.api.removeConnection.mock.calls[0]).toEqual(h.api.removeConnection.mock.calls[1]);
    expect(h.ids).toHaveBeenCalledTimes(1);
    stop();
  });
  test('does not carry a delayed remove result into a new account', async () => {
    const h = create(); const stop = h.service.subscribe(() => undefined); await h.service.refresh();
    const pending = deferred<typeof operation>(); h.api.removeConnection.mockReturnValueOnce(pending.promise);
    const result = h.service.remove(other);
    h.change({ ...state, owner: null, accountEpoch: 'signed-out' });
    pending.resolve(operation); expect(await result).toBe(false);
    expect(h.service.getSnapshot().operations).toEqual({});
    expect(h.settings.refresh).not.toHaveBeenCalled();
    stop();
  });
  test('resume is an explicit operation and never a preference write', async () => {
    const h = create(); const stop = h.service.subscribe(() => undefined); await h.service.refresh();
    expect(h.api.resumeCurrentConnection).not.toHaveBeenCalled();
    expect(await h.service.resume(current)).toBe(true);
    expect(h.api.resumeCurrentConnection).toHaveBeenCalledWith({ expectedAccountEpoch: 'a', requestId: 'request-1', expectedConnectionVersion: '1' });
    stop();
  });
  test('rejects an action held by a previous account screen', async () => {
    const h = create(); const stop = h.service.subscribe(() => undefined); await h.service.refresh();
    h.change({ ...state, accountEpoch: 'b', owner: { userId: 'b', scopeKey: 'personal' } });
    await h.service.refresh();
    expect(await h.service.remove(other, 'a')).toBe(false);
    expect(h.api.removeConnection).not.toHaveBeenCalled();
    stop();
  });
  test('discards a list started before a completed removal and fetches a fresh snapshot', async () => {
    const h = create(); const stop = h.service.subscribe(() => undefined); await h.service.refresh();
    const pending = deferred<RemoteConnectionsSnapshot>();
    h.api.queryConnections.mockReturnValueOnce(pending.promise);
    const read = h.service.refresh();
    const removal = h.service.remove(other);
    await Promise.resolve();
    h.api.queryConnections.mockResolvedValue({ ...data, connections: [], quota: { ...data.quota, onlineSlotsUsed: 4 } });
    pending.resolve({ ...data, quota: { ...data.quota, onlineSlotsUsed: 99 } });
    await read; await removal;
    expect(h.service.getSnapshot().data?.quota.onlineSlotsUsed).toBe(4);
    stop();
  });

});
