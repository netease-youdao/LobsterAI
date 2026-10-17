import { afterEach, expect, test, vi } from 'vitest';

import { DiskCleanupStoppedError, DiskCleanupStopReason, UNTHROTTLED_DISK_CLEANUP } from './openclawDiskCleanupThrottle';

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  compile: vi.fn(async (..._args: unknown[]) => [] as string[]),
  backups: vi.fn(async (..._args: unknown[]) => ({ removedRuns: [] as string[], strippedPaths: [] as string[] })),
  temps: vi.fn(async (..._args: unknown[]) => [] as string[]),
  archives: vi.fn(async (..._args: unknown[]) => [] as string[]),
  browser: vi.fn(async (..._args: unknown[]) => [] as string[]),
}));
vi.mock('./openclawCompileCache', () => ({ pruneStaleOpenClawCompileCaches: mocks.compile }));
vi.mock('./openclawCompatibilityRepair', () => ({ pruneOpenClawRepairBackups: mocks.backups }));
vi.mock('./openclawSessionStoreTempCleanup', () => ({ pruneOrphanOpenClawSessionStoreTemps: mocks.temps }));
vi.mock('./openclawSessionImportArchiveCleanup', () => ({ pruneExpiredOpenClawSessionImportArchives: mocks.archives }));
vi.mock('./openclawBrowserCachePrune', () => ({
  OPENCLAW_BROWSER_CACHE_PRUNE_INTERVAL_MS: 1000, pruneOpenClawBrowserCaches: mocks.browser,
}));

const {
  OPENCLAW_STARTUP_DISK_CLEANUP_DELAY_MS, OPENCLAW_STARTUP_DISK_CLEANUP_RETRY_MS,
  runOpenClawStartupDiskCleanup, scheduleOpenClawStartupDiskCleanup,
} = await import('./openclawStartupDiskCleanup');

const params = { baseDir: '/base', stateDir: '/base/state', compileCacheDir: '/base/state/.compile-cache' };
const throttle = UNTHROTTLED_DISK_CLEANUP;
const stopped = () => new DiskCleanupStoppedError(DiskCleanupStopReason.Budget);

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.order.length = 0;
});

test('a pass runs each step once, in order, sharing one throttle', async () => {
  for (const [name, mock] of Object.entries({ temps: mocks.temps, archives: mocks.archives, browser: mocks.browser, compile: mocks.compile })) {
    mock.mockImplementationOnce(async () => {
      mocks.order.push(name);
      return [];
    });
  }
  mocks.backups.mockImplementationOnce(async () => {
    mocks.order.push('backups');
    return { removedRuns: [], strippedPaths: [] };
  });

  expect(await runOpenClawStartupDiskCleanup({ ...params, stateDir: '/order/state' }, { now: 10_000, throttle })).toBe(true);

  expect(mocks.order).toEqual(['temps', 'archives', 'browser', 'backups', 'compile']);
  expect(mocks.temps).toHaveBeenCalledWith('/order/state', { now: 10_000, throttle });
  expect(mocks.archives).toHaveBeenCalledWith('/order/state', { now: 10_000, throttle });
  expect(mocks.browser).toHaveBeenCalledWith('/order/state', { throttle });
  expect(mocks.backups).toHaveBeenCalledWith('/base', { now: 10_000, throttle });
  expect(mocks.compile).toHaveBeenCalledWith(params.compileCacheDir, undefined, throttle);
});

test('the browser pass is throttled per state dir only after it completes', async () => {
  mocks.browser.mockRejectedValueOnce(stopped());
  expect(await runOpenClawStartupDiskCleanup(params, { now: 10_000, throttle })).toBe(false);
  // Stopped during the browser step: it is retried on the next pass.
  expect(await runOpenClawStartupDiskCleanup(params, { now: 10_100, throttle })).toBe(true);
  expect(await runOpenClawStartupDiskCleanup(params, { now: 10_500, throttle })).toBe(true);
  expect(await runOpenClawStartupDiskCleanup({ ...params, stateDir: '/other/state' }, { now: 10_500, throttle })).toBe(true);
  expect(await runOpenClawStartupDiskCleanup(params, { now: 11_200, throttle })).toBe(true);

  expect(mocks.browser.mock.calls.map(([stateDir]) => stateDir))
    .toEqual(['/base/state', '/base/state', '/other/state', '/base/state']);
});

test('a stopped step ends the pass; an ordinary failure does not', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  mocks.archives.mockRejectedValueOnce(new Error('boom'));
  expect(await runOpenClawStartupDiskCleanup({ ...params, stateDir: '/failing/state' }, { now: 50_000, throttle })).toBe(true);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('session import archives'), expect.any(Error));
  expect(mocks.compile).toHaveBeenCalledTimes(1);

  mocks.archives.mockRejectedValueOnce(stopped());
  expect(await runOpenClawStartupDiskCleanup({ ...params, stateDir: '/failing/state' }, { now: 60_000, throttle })).toBe(false);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('paused at "session import archives" (budget)'));
  expect(mocks.compile).toHaveBeenCalledTimes(1);
  log.mockRestore();
  warn.mockRestore();
});

test('on battery power the pass is skipped and nothing is touched', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await runOpenClawStartupDiskCleanup(params, { isOnBatteryPower: () => true, throttle })).toBe(false);
  for (const mock of [mocks.temps, mocks.archives, mocks.browser, mocks.backups, mocks.compile]) expect(mock).not.toHaveBeenCalled();
  // A power source that cannot be read counts as AC power.
  expect(await runOpenClawStartupDiskCleanup({ ...params, stateDir: '/unknown/state' }, {
    isOnBatteryPower: () => { throw new Error('unsupported'); }, throttle,
  })).toBe(true);
  log.mockRestore();
});

test('scheduling waits for the delay, coalesces restarts, and retries a pass that stopped early', async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const scheduled = { ...params, stateDir: '/scheduled/state' };
  let onBattery = true;

  scheduleOpenClawStartupDiskCleanup(scheduled, { isOnBatteryPower: () => onBattery });
  scheduleOpenClawStartupDiskCleanup(scheduled, { isOnBatteryPower: () => onBattery });
  await vi.advanceTimersByTimeAsync(OPENCLAW_STARTUP_DISK_CLEANUP_DELAY_MS);
  expect(mocks.temps).not.toHaveBeenCalled();

  // Still pending: a gateway restart does not add a second pass.
  scheduleOpenClawStartupDiskCleanup(scheduled, { isOnBatteryPower: () => onBattery });
  onBattery = false;
  await vi.advanceTimersByTimeAsync(OPENCLAW_STARTUP_DISK_CLEANUP_RETRY_MS);
  expect(mocks.temps).toHaveBeenCalledTimes(1);
  expect(mocks.compile).toHaveBeenCalledTimes(1);

  // Once a pass finishes, the next gateway start schedules a new one.
  scheduleOpenClawStartupDiskCleanup(scheduled, { isOnBatteryPower: () => onBattery });
  await vi.advanceTimersByTimeAsync(OPENCLAW_STARTUP_DISK_CLEANUP_DELAY_MS);
  expect(mocks.temps).toHaveBeenCalledTimes(2);
  log.mockRestore();
});
