import net from 'net';
import { describe, expect, test, vi } from 'vitest';

import {
  detectLoopbackBlock,
  LOOPBACK_SELF_TEST_TIMEOUT_CODE,
  LoopbackSelfTestOutcome,
  type LoopbackSelfTestResult,
  runLoopbackSelfTest,
} from './loopbackSelfTest';

/** A client socket that fails the way Windows reports a dropped loopback SYN. */
const failingSocket = (code: string): net.Socket => {
  const socket = new net.Socket();
  process.nextTick(() => socket.emit('error', Object.assign(new Error(`connect ${code}`), { code })));
  return socket;
};

describe('runLoopbackSelfTest', () => {
  test('connects to its own 127.0.0.1 listener', async () => {
    const result = await runLoopbackSelfTest();

    expect(result.outcome).toBe(LoopbackSelfTestOutcome.Ok);
    expect(result.code).toBeUndefined();
  });

  test('treats a connect that times out as dropped', async () => {
    const result = await runLoopbackSelfTest({ connect: () => failingSocket('ETIMEDOUT') });

    expect(result).toMatchObject({ outcome: LoopbackSelfTestOutcome.Blocked, code: 'ETIMEDOUT' });
  });

  test('treats a connect that never completes as dropped', async () => {
    // An unconnected socket emits nothing, like a SYN the firewall swallowed.
    const result = await runLoopbackSelfTest({ timeoutMs: 20, connect: () => new net.Socket() });

    expect(result).toMatchObject({
      outcome: LoopbackSelfTestOutcome.Blocked,
      code: LOOPBACK_SELF_TEST_TIMEOUT_CODE,
    });
  });

  test('does not blame the firewall for refusals, which an allow rule cannot fix', async () => {
    const result = await runLoopbackSelfTest({ connect: () => failingSocket('ECONNREFUSED') });

    expect(result).toMatchObject({ outcome: LoopbackSelfTestOutcome.Inconclusive, code: 'ECONNREFUSED' });
  });
});

describe('detectLoopbackBlock', () => {
  const blocked: LoopbackSelfTestResult = { outcome: LoopbackSelfTestOutcome.Blocked, code: 'ETIMEDOUT', elapsedMs: 300 };
  const ok: LoopbackSelfTestResult = { outcome: LoopbackSelfTestOutcome.Ok, elapsedMs: 1 };

  test('reports a block only when every attempt was dropped', async () => {
    const selfTest = vi.fn(async () => blocked);

    await expect(detectLoopbackBlock({ selfTest, retryDelayMs: 0 })).resolves.toEqual({
      blocked: true,
      attempts: 2,
      last: blocked,
    });
    expect(selfTest).toHaveBeenCalledTimes(2);
  });

  test('lets one stalled attempt pass when the retry connects', async () => {
    const selfTest = vi.fn()
      .mockResolvedValueOnce(blocked)
      .mockResolvedValueOnce(ok);

    await expect(detectLoopbackBlock({ selfTest, retryDelayMs: 0 })).resolves.toEqual({
      blocked: false,
      attempts: 2,
      last: ok,
    });
  });

  test('stops after the first attempt that is not dropped', async () => {
    const inconclusive: LoopbackSelfTestResult = {
      outcome: LoopbackSelfTestOutcome.Inconclusive,
      code: 'EADDRNOTAVAIL',
      elapsedMs: 1,
    };
    const selfTest = vi.fn(async () => inconclusive);

    await expect(detectLoopbackBlock({ selfTest })).resolves.toEqual({
      blocked: false,
      attempts: 1,
      last: inconclusive,
    });
    expect(selfTest).toHaveBeenCalledOnce();
  });
});
