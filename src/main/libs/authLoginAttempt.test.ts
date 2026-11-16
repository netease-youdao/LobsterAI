import { describe, expect, test } from 'vitest';

import { AuthLoginAttempt } from './authLoginAttempt';

describe('AuthLoginAttempt', () => {
  test('cancel rejects late callbacks and a new login invalidates the previous generation', async () => {
    const attempt = new AuthLoginAttempt();
    const first = attempt.begin();
    attempt.cancel();
    expect(attempt.acceptsCallback()).toBe(false);
    await expect(attempt.runExchange(async () => true)).rejects.toThrow('cancelled');
    const second = attempt.begin();
    expect(attempt.isCurrent(first)).toBe(false);
    expect(attempt.isCurrent(second)).toBe(true);
    await expect(attempt.runExchange(async () => true)).resolves.toBe(true);
  });

  test('retry waits for a cancelled exchange to roll back before snapshotting credentials', async () => {
    const attempt = new AuthLoginAttempt();
    attempt.begin();
    let account = 'original';
    let release = () => {};
    const pending = new Promise<void>(resolve => { release = resolve; });
    let signal: AbortSignal | undefined;
    const first = attempt.runExchange(async context => {
      signal = context.signal;
      const previous = account;
      account = 'incomplete';
      await pending;
      if (!context.isCurrent()) account = previous;
    });
    await Promise.resolve();
    expect(account).toBe('incomplete');

    attempt.cancel();
    expect(signal?.aborted).toBe(true);
    attempt.begin();
    let secondStarted = false;
    const second = attempt.runExchange(async () => {
      secondStarted = true;
      return account;
    });
    await Promise.resolve();
    expect(secondStarted).toBe(false);
    release();
    await first;
    await expect(second).resolves.toBe('original');
    await attempt.waitForExchange();
  });

  test('only the latest of queued exchanges starts after the previous one settles', async () => {
    const attempt = new AuthLoginAttempt();
    let release = () => {};
    const first = attempt.runExchange(() => new Promise<void>(resolve => { release = resolve; }));
    await Promise.resolve();
    const second = attempt.runExchange(async () => 'obsolete');
    const rejected = expect(second).rejects.toThrow('cancelled');
    const third = attempt.runExchange(async () => 'latest');
    release();
    await first;
    await rejected;
    await expect(third).resolves.toBe('latest');
  });
});
