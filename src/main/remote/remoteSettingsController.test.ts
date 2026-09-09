import { describe, expect, test } from 'vitest';

import type { RemoteSettingsState } from '../../shared/remote/constants';
import { RemoteSettingsController } from './remoteSettingsController';

function fixture(preference?: boolean, loggedIn = true) {
  let active = false;
  let unavailable = false;
  let failSaving = false;
  let connected = false;
  let owner: RemoteSettingsState['owner'] = loggedIn ? { userId: 'user-1', scopeKey: 'personal' } : null;
  const published: RemoteSettingsState[] = [];
  const saved: boolean[] = [];
  const applied: boolean[] = [];
  const controller = new RemoteSettingsController({
    getRemoteState: () => ({ enabled: false, connected, name: 'Desktop', owner, workspaces: [], accessRequests: [] }),
    getKeepAwakePreference: () => preference,
    saveKeepAwakePreference: value => { if (failSaving) throw new Error('Disk full'); saved.push(value); preference = value; },
    applyKeepAwake: value => { applied.push(value); if (unavailable) throw new Error('Power unavailable'); active = value; },
    isKeepAwakeActive: () => active,
    publish: state => { published.push(state); },
  });
  return { controller, published, saved, applied, preference: () => preference, active: () => active,
    unavailable: (value: boolean) => { unavailable = value; }, failSaving: (value = true) => { failSaving = value; },
    login: () => { owner = { userId: 'user-1', scopeKey: 'personal' }; controller.restoreKeepAwake(); },
    logout: () => { owner = null; connected = false; controller.restoreKeepAwake(); },
    connect: () => { connected = true; controller.notify(); } };
}

describe('remote settings power and state lifecycle', () => {
  test('defaults missing preference on only while logged in and preserves explicit false', () => {
    const fresh = fixture();
    fresh.controller.restoreKeepAwake();
    expect(fresh.preference()).toBe(true);
    expect(fresh.controller.state()).toMatchObject({ enabled: false, owner: { userId: 'user-1' }, keepAwakeEnabled: true, keepAwakeActive: true });
    const existing = fixture(false);
    existing.controller.restoreKeepAwake();
    expect(existing.preference()).toBe(false);
    expect(existing.active()).toBe(false);
    expect(existing.saved).toEqual([]);
  });

  test('keeps a fresh logged-out installation off without persisting the logged-in default', () => {
    const f = fixture(undefined, false);
    expect(f.controller.state()).toMatchObject({ owner: null, keepAwakeEnabled: false, keepAwakeActive: false });
    f.controller.restoreKeepAwake();
    f.controller.restoreKeepAwake();
    expect(f.preference()).toBeUndefined();
    expect(f.saved).toEqual([]);
    expect(f.applied).toEqual([false, false]);

    f.login();
    expect(f.controller.state()).toMatchObject({ keepAwakeEnabled: true, keepAwakeActive: true });
    expect(f.saved).toEqual([true]);
  });

  test('logout releases the blocker while login restores the saved enabled preference', () => {
    const f = fixture(true);
    f.controller.restoreKeepAwake();
    expect(f.active()).toBe(true);

    f.logout();
    expect(f.controller.state()).toMatchObject({ owner: null, keepAwakeEnabled: false, keepAwakeActive: false });
    expect(f.preference()).toBe(true);
    expect(f.saved).toEqual([]);

    f.login();
    expect(f.controller.state()).toMatchObject({ keepAwakeEnabled: true, keepAwakeActive: true });
    expect(f.saved).toEqual([]);
  });

  test('an explicit disabled preference survives logout and subsequent login', () => {
    const f = fixture(undefined, false);
    f.login();
    f.controller.setKeepAwake(false);
    f.logout();
    f.login();

    expect(f.preference()).toBe(false);
    expect(f.controller.state()).toMatchObject({ keepAwakeEnabled: false, keepAwakeActive: false });
    expect(f.saved).toEqual([true, false]);
  });

  test('rejects all logged-out manual changes before persistence or OS calls', () => {
    const f = fixture(true, false);
    expect(() => f.controller.setKeepAwake(true)).toThrow('Login required');
    expect(() => f.controller.setKeepAwake(false)).toThrow('Login required');
    expect(f.preference()).toBe(true);
    expect(f.saved).toEqual([]);
    expect(f.applied).toEqual([]);
    expect(f.published).toEqual([]);
  });

  test('reports failed activation separately from durable user intent and restores on retry', () => {
    const f = fixture(false);
    f.unavailable(true);
    const failed = f.controller.setKeepAwake(true);
    expect(failed.keepAwakeEnabled).toBe(true);
    expect(failed.keepAwakeActive).toBe(false);
    expect(failed.keepAwakeError).toBeDefined();
    f.unavailable(false);
    f.controller.restoreKeepAwake();
    expect(f.controller.state().keepAwakeActive).toBe(true);
    expect(f.controller.state().keepAwakeError).toBeUndefined();
  });

  test('retries a failed logout release without overwriting the enabled preference', () => {
    const f = fixture(true);
    f.controller.restoreKeepAwake();
    f.unavailable(true);
    f.logout();
    expect(f.controller.state()).toMatchObject({ owner: null, keepAwakeEnabled: false, keepAwakeActive: true });
    expect(f.controller.state().keepAwakeError).toBeDefined();
    expect(f.preference()).toBe(true);

    f.unavailable(false);
    f.controller.restoreKeepAwake();
    expect(f.controller.state()).toMatchObject({ keepAwakeEnabled: false, keepAwakeActive: false });
    expect(f.controller.state().keepAwakeError).toBeUndefined();
    expect(f.preference()).toBe(true);
    expect(f.saved).toEqual([]);
  });

  test('does not abort logged-in restore when saving the default fails and can retry', () => {
    const f = fixture();
    f.failSaving();
    expect(() => f.controller.restoreKeepAwake()).not.toThrow();
    expect(f.active()).toBe(false);
    expect(f.preference()).toBeUndefined();
    expect(f.applied).toEqual([]);
    expect(f.controller.state().keepAwakeError).toBeDefined();

    f.failSaving(false);
    f.controller.restoreKeepAwake();
    expect(f.controller.state()).toMatchObject({ keepAwakeEnabled: true, keepAwakeActive: true });
    expect(f.controller.state().keepAwakeError).toBeUndefined();
    expect(f.saved).toEqual([true]);
  });

  test('does not change OS behavior when saving intent fails', () => {
    const f = fixture(false);
    f.failSaving();
    expect(() => f.controller.setKeepAwake(true)).toThrow('Disk full');
    expect(f.active()).toBe(false);
    expect(f.preference()).toBe(false);
    expect(f.applied).toEqual([]);
  });

  test('orders connection, lock and power notifications; releases the blocker without clearing preference', () => {
    const f = fixture(true);
    f.controller.restoreKeepAwake();
    f.connect();
    f.controller.setScreenLocked(true);
    expect(f.published.map(state => state.stateRevision)).toEqual([1, 2, 3]);
    expect(f.controller.state()).toMatchObject({ connected: true, screenLocked: true, keepAwakeActive: true });
    f.controller.dispose();
    expect(f.active()).toBe(false);
    expect(f.preference()).toBe(true);
  });
});
