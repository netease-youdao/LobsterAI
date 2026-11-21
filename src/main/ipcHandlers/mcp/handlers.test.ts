import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0', isPackaged: false },
  BrowserWindow: { fromWebContents: () => null },
  ipcMain: { handle: vi.fn() },
  session: { defaultSession: { fetch: vi.fn() } },
  shell: { openExternal: vi.fn() },
}));

import { createSerializedMcpConfigSync } from './handlers';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createSerializedMcpConfigSync', () => {
  test('serializes overlapping toggle calls in strict FIFO order without stale races', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const syncDshConfig = vi.fn(async ({ reason }: { reason: string }) => {
      order.push(`start:${reason}`);
      if (reason === 'toggle-off') {
        await firstGate;
      }
      order.push(`end:${reason}`);
      return { success: true, changed: true };
    });

    const syncMcpConfig = createSerializedMcpConfigSync(syncDshConfig, 5_000);
    const first = syncMcpConfig('toggle-off');
    const second = syncMcpConfig('toggle-on');

    await Promise.resolve();
    expect(order).toEqual(['start:toggle-off']);

    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual([
      'start:toggle-off',
      'end:toggle-off',
      'start:toggle-on',
      'end:toggle-on',
    ]);
  });

  test('swallows and logs sync errors without unhandled rejections and stays bounded on slow syncs', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    const syncDshConfig = vi.fn(async ({ reason }: { reason: string }) => {
      if (reason === 'throws') throw new Error('boom');
      if (reason === 'fails') return { success: false, changed: false };
      if (reason === 'slow') {
        await slowGate;
        return { success: true, changed: true };
      }
      return { success: true, changed: true };
    });

    const syncMcpConfig = createSerializedMcpConfigSync(syncDshConfig, 25);
    await expect(syncMcpConfig('throws')).resolves.toBeUndefined();
    await expect(syncMcpConfig('fails')).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    const started = Date.now();
    await expect(syncMcpConfig('slow')).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(500);

    // Cleanly settle background slow promise.
    releaseSlow();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});
