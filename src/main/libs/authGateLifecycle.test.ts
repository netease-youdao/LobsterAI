import { describe, expect, test, vi } from 'vitest';

import { AuthGateLifecycleCoordinator } from './authGateLifecycle';

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('AuthGateLifecycleCoordinator', () => {
  test('starts DSH, scheduler, and IM gateways and unblocks companion/tray on login', async () => {
    let blocked = false;
    const callOrder: string[] = [];

    const coordinator = new AuthGateLifecycleCoordinator({
      isBlocked: () => blocked,
      startDshAndScheduler: async () => { callOrder.push('startDshAndScheduler'); },
      startImGateways: async () => { callOrder.push('startImGateways'); },
      stopCoworkSessions: () => { callOrder.push('stopCoworkSessions'); },
      stopSchedulerPolling: () => { callOrder.push('stopSchedulerPolling'); },
      stopImGateways: async () => { callOrder.push('stopImGateways'); },
      suspendDsh: async () => { callOrder.push('suspendDsh'); },
      setCompanionAuthBlocked: value => { callOrder.push(`companion:${value}`); },
      refreshTrayMenu: () => { callOrder.push('refreshTray'); },
    });

    await coordinator.syncState('user-login');

    expect(coordinator.isServicesActive()).toBe(true);
    expect(callOrder).toEqual([
      'companion:false',
      'refreshTray',
      'companion:false',
      'refreshTray',
      'startDshAndScheduler',
      'startImGateways',
    ]);

    // Subsequent sync while already active does not duplicate DSH startup.
    callOrder.length = 0;
    await coordinator.syncState('duplicate-login');
    expect(callOrder).toEqual([
      'companion:false',
      'refreshTray',
      'companion:false',
      'refreshTray',
    ]);

    // Transitioning to blocked suspends all runtime services in order.
    blocked = true;
    callOrder.length = 0;
    await coordinator.syncState('user-logout');
    expect(coordinator.isServicesActive()).toBe(false);
    expect(callOrder).toEqual([
      'companion:true',
      'refreshTray',
      'companion:true',
      'refreshTray',
      'stopCoworkSessions',
      'stopSchedulerPolling',
      'stopImGateways',
      'suspendDsh',
    ]);
  });

  test('serializes rapid login -> logout transitions so IM gateways do not start after logout', async () => {
    let blocked = false;
    const dshBoot = createDeferred<void>();
    const startImGateways = vi.fn(async () => undefined);
    const suspendDsh = vi.fn(async () => undefined);
    const stopCoworkSessions = vi.fn();
    const stopSchedulerPolling = vi.fn();
    const stopImGateways = vi.fn(async () => undefined);

    const coordinator = new AuthGateLifecycleCoordinator({
      isBlocked: () => blocked,
      startDshAndScheduler: () => dshBoot.promise,
      startImGateways,
      stopCoworkSessions,
      stopSchedulerPolling,
      stopImGateways,
      suspendDsh,
      setCompanionAuthBlocked: vi.fn(),
      refreshTrayMenu: vi.fn(),
    });

    const loginPromise = coordinator.syncState('user-login');
    blocked = true;
    const logoutPromise = coordinator.syncState('user-logout');

    dshBoot.resolve();
    await Promise.all([loginPromise, logoutPromise]);

    expect(startImGateways).not.toHaveBeenCalled();
    expect(stopCoworkSessions).toHaveBeenCalledTimes(1);
    expect(stopSchedulerPolling).toHaveBeenCalledTimes(1);
    expect(stopImGateways).toHaveBeenCalledTimes(1);
    expect(suspendDsh).toHaveBeenCalledTimes(1);
    expect(coordinator.isServicesActive()).toBe(false);
  });

  test('resets servicesActive when DSH startup fails so a subsequent retry succeeds', async () => {
    const startDshAndScheduler = vi.fn()
      .mockRejectedValueOnce(new Error('boot failed'))
      .mockResolvedValueOnce(undefined);
    const startImGateways = vi.fn(async () => undefined);

    const coordinator = new AuthGateLifecycleCoordinator({
      isBlocked: () => false,
      startDshAndScheduler,
      startImGateways,
      stopCoworkSessions: vi.fn(),
      stopSchedulerPolling: vi.fn(),
      stopImGateways: vi.fn(async () => undefined),
      suspendDsh: vi.fn(async () => undefined),
      setCompanionAuthBlocked: vi.fn(),
      refreshTrayMenu: vi.fn(),
    });

    await coordinator.syncState('first-attempt');
    expect(coordinator.isServicesActive()).toBe(false);
    expect(startImGateways).not.toHaveBeenCalled();

    await coordinator.syncState('retry-attempt');
    expect(coordinator.isServicesActive()).toBe(true);
    expect(startImGateways).toHaveBeenCalledTimes(1);
  });
});
