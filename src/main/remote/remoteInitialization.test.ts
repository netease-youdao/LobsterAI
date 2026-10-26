import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteInitializationFailure as Failure } from '../../shared/remote/constants';
import { RemoteIdentityError } from './installationIdentity';
import { RemoteInitializationRecovery } from './remoteInitialization';

afterEach(() => { vi.useRealTimers(); });

function fixture() {
  const initialize = vi.fn(), canRetry = vi.fn(() => true), changed = vi.fn(), report = vi.fn();
  return { initialize, canRetry, changed, report, recovery: new RemoteInitializationRecovery({ initialize, canRetry, changed, report }) };
}

describe('remote initialization recovery', () => {
  it('keeps original credential failure visible without forwarding sensitive exception text or retrying reads', () => {
    vi.useFakeTimers();
    const f = fixture();
    f.initialize.mockImplementation(() => { throw new RemoteIdentityError(Failure.IdentityUnreadable); });
    expect(() => f.recovery.ensure()).toThrow(Failure.IdentityUnreadable);
    expect(f.recovery.failure).toBe(Failure.IdentityUnreadable);
    for (let i = 0; i < 10; i++) expect(() => f.recovery.ensure()).toThrow(Failure.IdentityUnreadable);
    vi.advanceTimersByTime(120_000);
    expect(() => f.recovery.ensure()).toThrow(Failure.IdentityUnreadable);
    expect(f.initialize).toHaveBeenCalledOnce();
    expect(f.report).toHaveBeenCalledExactlyOnceWith(Failure.IdentityUnreadable, 1);
    f.recovery.dispose();
  });

  it('recovers a temporary storage failure with a bounded retry and then stops retrying', () => {
    vi.useFakeTimers();
    const f = fixture();
    f.initialize.mockImplementationOnce(() => { throw new RemoteIdentityError(Failure.SecureStorageUnavailable); });
    expect(() => f.recovery.ensure()).toThrow(Failure.SecureStorageUnavailable);
    vi.advanceTimersByTime(29_999); expect(f.initialize).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(f.recovery.failure).toBeUndefined();
    expect(f.initialize).toHaveBeenCalledTimes(2);
    expect(f.report).toHaveBeenLastCalledWith(null, 2);
    vi.advanceTimersByTime(120_000); f.recovery.ensure();
    expect(f.initialize).toHaveBeenCalledTimes(2);
    f.recovery.dispose();
  });

  it('manual checks retain the original failure until initialization really succeeds and reject click storms', () => {
    vi.useFakeTimers(); const f = fixture();
    f.initialize.mockImplementationOnce(() => { throw new RemoteIdentityError(Failure.IdentityUnreadable); });
    expect(() => f.recovery.ensure()).toThrow();
    expect(() => f.recovery.ensure(true)).toThrow(Failure.IdentityUnreadable);
    vi.advanceTimersByTime(1000); f.recovery.ensure(true);
    expect(f.recovery.failure).toBeUndefined(); expect(f.initialize).toHaveBeenCalledTimes(2);
    f.recovery.dispose();
  });

  it('does not automatically retry while logged out or disabled and cancels probes on shutdown', () => {
    vi.useFakeTimers(); const f = fixture();
    f.initialize.mockImplementation(() => { throw new RemoteIdentityError(Failure.LocalStorageUnavailable); });
    expect(() => f.recovery.ensure()).toThrow(); f.canRetry.mockReturnValue(false);
    vi.advanceTimersByTime(90_000); expect(f.initialize).toHaveBeenCalledOnce();
    f.canRetry.mockReturnValue(true); vi.advanceTimersByTime(30_000);
    expect(f.initialize).toHaveBeenCalledTimes(2);
    expect(f.report).toHaveBeenCalledOnce();
    f.recovery.dispose(); vi.advanceTimersByTime(120_000);
    expect(f.initialize).toHaveBeenCalledTimes(2);
    expect(() => f.recovery.ensure(true)).toThrow();
  });

  it('reports unexpected initialization failures as local dependencies and never includes their raw error', () => {
    vi.useFakeTimers(); const f = fixture();
    f.initialize.mockImplementation(() => { throw new Error('secret-value C:/private/identity.bin'); });
    expect(() => f.recovery.ensure()).toThrow(Failure.DependencyUnavailable);
    expect(JSON.stringify(f.report.mock.calls)).not.toContain('secret-value');
    vi.advanceTimersByTime(120_000); expect(f.initialize).toHaveBeenCalledOnce();
    f.recovery.dispose();
  });

  it('ignores diagnostic and state listener exceptions during failure and successful recovery', () => {
    vi.useFakeTimers(); const f = fixture();
    f.report.mockImplementation(() => { throw new Error('logger'); });
    f.changed.mockImplementation(() => { throw new Error('listener'); });
    f.initialize.mockImplementationOnce(() => { throw new RemoteIdentityError(Failure.IdentityInvalid); });
    expect(() => f.recovery.ensure()).toThrow(Failure.IdentityInvalid);
    vi.advanceTimersByTime(1000); expect(() => f.recovery.ensure(true)).not.toThrow();
    expect(f.recovery.failure).toBeUndefined(); f.recovery.dispose();
  });
});
