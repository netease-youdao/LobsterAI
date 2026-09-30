import { describe, expect, it, vi } from 'vitest';

import { RemoteAccountTransition } from './remoteAccountTransition';

vi.mock('./remoteSyncLog', () => ({ remoteDiagnosticLog: vi.fn() }));

describe('account transition execution barrier', () => {
  it('keeps execution blocked after failure but permits a later verified transition', async () => {
    const queue = new RemoteAccountTransition();
    await expect(queue.run(async () => { throw new Error('gateway not stopped'); })).rejects.toThrow('gateway not stopped');
    await expect(queue.wait()).rejects.toThrow('gateway not stopped');
    let permitted = false;
    await queue.run(async current => { if (current()) permitted = true; });
    await expect(queue.wait()).resolves.toBeUndefined();
    expect(permitted).toBe(true);
  });

  it('never releases a waiting caller on a superseded transition', async () => {
    const queue = new RemoteAccountTransition();
    let completeFirst!: () => void;
    let completeSecond!: () => void;
    let firstCurrent = true;
    const first = queue.run(async current => {
      await new Promise<void>(resolve => { completeFirst = resolve; });
      firstCurrent = current();
    });
    await Promise.resolve();
    let released = false;
    const waiting = queue.wait().then(() => { released = true; });
    const second = queue.run(async current => {
      await new Promise<void>(resolve => { completeSecond = resolve; });
      expect(current()).toBe(true);
    });
    completeFirst();
    await first;
    await Promise.resolve();
    expect(firstCurrent).toBe(false);
    expect(released).toBe(false);
    completeSecond();
    await second;
    await waiting;
    expect(released).toBe(true);
  });
});
