import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RemoteSettingsState } from '../../shared/remote/constants';
import { configureRemoteWithRetryLog } from './remoteConfigureLog';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('renderer synchronization retry diagnostics', () => {
  async function fixture() {
    vi.resetModules();
    const { configureRemoteWithRetryLog: configure } = await import('./remoteConfigureLog');
    const log = vi.fn();
    vi.stubGlobal('window', { electron: { log: { fromRenderer: log } } });
    const result = { accountEpoch: 'current' } as RemoteSettingsState;
    const api = { configure: vi.fn(async () => result) };
    return { configure, log, api, result };
  }

  it('correlates both task and connection retries without claiming synchronization completed', async () => {
    const f = await fixture();
    for (const changes of [{ retrySessionId: 'task-a', expectedAccountEpoch: 'current' }, { retry: true, expectedAccountEpoch: 'current' }]) {
      expect(await f.configure(f.api, changes)).toBe(f.result);
      expect(f.api.configure).toHaveBeenLastCalledWith(changes);
    }
    const records = f.log.mock.calls.map(call => JSON.parse(call[2]));
    expect(records).toEqual([
      { request: 1, scope: 'task', sessionId: 'task-a', stage: 'requested' },
      { request: 1, scope: 'task', sessionId: 'task-a', stage: 'response', accountChanged: false, initializationFailed: false },
      { request: 2, scope: 'connection', sessionId: null, stage: 'requested' },
      { request: 2, scope: 'connection', sessionId: null, stage: 'response', accountChanged: false, initializationFailed: false },
    ]);
  });

  it('preserves the original rejection and does not log private request/error content', async () => {
    const f = await fixture(), secret = 'private /Users/a/file.pdf token=value';
    const error = new Error(secret); f.api.configure.mockRejectedValue(error);
    await expect(f.configure(f.api, { retrySessionId: secret, expectedAccountEpoch: secret, name: secret })).rejects.toBe(error);
    expect(f.log).toHaveBeenCalledTimes(2);
    expect(JSON.parse(f.log.mock.calls[1][2])).toMatchObject({ sessionId: null, stage: 'failed' });
    expect(JSON.stringify(f.log.mock.calls)).not.toContain(secret);
  });

  it('does not log ordinary configuration writes and survives unavailable or throwing log bridges', async () => {
    const f = await fixture();
    await f.configure(f.api, { name: 'Desktop' }); expect(f.log).not.toHaveBeenCalled();
    f.log.mockImplementation(() => { throw new Error('logging unavailable'); });
    expect(await f.configure(f.api, { retry: true })).toBe(f.result);
    vi.stubGlobal('window', { electron: {} });
    expect(await f.configure(f.api, { retry: true })).toBe(f.result);
  });

  it('caps diagnostic volume without limiting retries or retaining request history', async () => {
    const f = await fixture(); vi.spyOn(Date, 'now').mockReturnValue(100000);
    for (let index = 0; index < 100; index++) await f.configure(f.api, { retry: true });
    expect(f.api.configure).toHaveBeenCalledTimes(100); expect(f.log).toHaveBeenCalledTimes(40);
    vi.mocked(Date.now).mockReturnValue(160000); await f.configure(f.api, { retry: true });
    expect(f.log).toHaveBeenCalledTimes(42);
  });

  it('returns synchronous IPC errors unchanged even without a renderer global', async () => {
    const error = new Error('IPC unavailable');
    await expect(configureRemoteWithRetryLog({ configure: () => { throw error; } }, { retry: true })).rejects.toBe(error);
  });
});
