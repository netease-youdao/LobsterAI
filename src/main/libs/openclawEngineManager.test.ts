/**
 * Unit tests for the gateway restart-loop fixes in openclawEngineManager.ts.
 *
 * Two bugs are covered:
 *
 * Bug 1 – Race condition causing infinite restart loop:
 *   When a gateway process exits during waitForGatewayReady, the exit handler
 *   schedules a restart via scheduleGatewayRestart(). The caller then tries to
 *   call stopGatewayProcess() on the already-dead process, which adds it to
 *   expectedGatewayExits *after* the exit event has already fired — so the guard
 *   has no effect and the restart timer fires again, looping forever.
 *   Fix: only call stopGatewayProcess() when isGatewayProcessAlive() is true.
 *
 * Bug 2 – No upper bound on consecutive auto-restarts:
 *   A gateway that crashes every startup would restart indefinitely at 3-second
 *   intervals.
 *   Fix: hasExceededRestartLimit() caps restarts at GATEWAY_MAX_RESTART_ATTEMPTS.
 *
 * Both exported helpers are pure functions with no I/O, making them testable
 * without mocking Electron or the filesystem.
 */
import { test, expect } from 'vitest';
import { isGatewayProcessAlive, hasExceededRestartLimit } from './openclawEngineManager';

// ---------------------------------------------------------------------------
// isGatewayProcessAlive
// ---------------------------------------------------------------------------

test('isGatewayProcessAlive: returns false for null', () => {
  expect(isGatewayProcessAlive(null)).toBe(false);
});

test('isGatewayProcessAlive: returns false for object without pid', () => {
  const noPid = {} as Parameters<typeof isGatewayProcessAlive>[0];
  expect(isGatewayProcessAlive(noPid)).toBe(false);
});

test('isGatewayProcessAlive: returns true when pid is a number and process is running', () => {
  const running = { pid: 1234 } as Parameters<typeof isGatewayProcessAlive>[0];
  expect(isGatewayProcessAlive(running)).toBe(true);
});

test('isGatewayProcessAlive: returns false when exitCode is non-null (process exited)', () => {
  const exited = { pid: 1234, exitCode: 1 } as Parameters<typeof isGatewayProcessAlive>[0];
  expect(isGatewayProcessAlive(exited)).toBe(false);
});

test('isGatewayProcessAlive: returns false when exitCode is 0 (clean exit)', () => {
  const cleanExit = { pid: 1234, exitCode: 0 } as Parameters<typeof isGatewayProcessAlive>[0];
  expect(isGatewayProcessAlive(cleanExit)).toBe(false);
});

test('isGatewayProcessAlive: returns true when exitCode is null (still running)', () => {
  const stillRunning = { pid: 1234, exitCode: null } as Parameters<typeof isGatewayProcessAlive>[0];
  expect(isGatewayProcessAlive(stillRunning)).toBe(true);
});

test('isGatewayProcessAlive: returns false when pid is not a number', () => {
  const badPid = { pid: 'not-a-number' } as unknown as Parameters<typeof isGatewayProcessAlive>[0];
  expect(isGatewayProcessAlive(badPid)).toBe(false);
});

// ---------------------------------------------------------------------------
// hasExceededRestartLimit
// ---------------------------------------------------------------------------

test('hasExceededRestartLimit: returns false when attempts is 0', () => {
  expect(hasExceededRestartLimit(0, 5)).toBe(false);
});

test('hasExceededRestartLimit: returns false when attempts equals max', () => {
  expect(hasExceededRestartLimit(5, 5)).toBe(false);
});

test('hasExceededRestartLimit: returns true when attempts exceeds max by 1', () => {
  expect(hasExceededRestartLimit(6, 5)).toBe(true);
});

test('hasExceededRestartLimit: returns true well above max', () => {
  expect(hasExceededRestartLimit(100, 5)).toBe(true);
});

test('hasExceededRestartLimit: max=1 — first attempt allowed, second rejected', () => {
  expect(hasExceededRestartLimit(1, 1)).toBe(false);
  expect(hasExceededRestartLimit(2, 1)).toBe(true);
});

// ---------------------------------------------------------------------------
// Combined: the race-condition guard depends on isGatewayProcessAlive
//
// Simulates the decision made in doStartGateway when waitForGatewayReady
// returns false: we should only call stopGatewayProcess when the process is
// still alive, so that we don't call it on an already-dead process (which
// would add the process to expectedGatewayExits after the exit event has
// already fired, leaving the restart timer active and causing a loop).
// ---------------------------------------------------------------------------

test('race-condition guard: alive process should be stopped after failed startup', () => {
  // process with pid set, exitCode null → still alive
  const aliveProcess = { pid: 9999, exitCode: null } as Parameters<typeof isGatewayProcessAlive>[0];
  let stopCalled = false;
  const stopGatewayProcess = (child: unknown) => {
    if (child === aliveProcess) stopCalled = true;
  };

  // Simulate the doStartGateway !ready branch
  if (isGatewayProcessAlive(aliveProcess)) {
    stopGatewayProcess(aliveProcess);
  }

  expect(stopCalled).toBe(true);
});

test('race-condition guard: dead process must NOT be stopped (avoids re-triggering exit handler)', () => {
  // process with exitCode non-null → already exited, exit handler already ran
  const deadProcess = { pid: 9999, exitCode: 1 } as Parameters<typeof isGatewayProcessAlive>[0];
  let stopCalled = false;
  const stopGatewayProcess = (_child: unknown) => {
    stopCalled = true;
  };

  // Simulate the doStartGateway !ready branch
  if (isGatewayProcessAlive(deadProcess)) {
    stopGatewayProcess(deadProcess);
  }

  expect(stopCalled).toBe(false);
});

test('race-condition guard: null process must NOT be stopped', () => {
  const noProcess = null;
  let stopCalled = false;
  const stopGatewayProcess = (_child: unknown) => {
    stopCalled = true;
  };

  if (isGatewayProcessAlive(noProcess)) {
    stopGatewayProcess(noProcess);
  }

  expect(stopCalled).toBe(false);
});
