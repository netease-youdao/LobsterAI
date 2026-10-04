import { describe, expect, test } from 'vitest';

import {
  DEFAULT_GATEWAY_STARTUP_WAIT_POLICY,
  evaluateGatewayStartupWait,
  gatewayStartupProgressPercent,
  GatewayStartupWaitOutcome,
  isGatewayStartupWaitOver,
} from './openclawGatewayStartupWait';

const policy = { baseTimeoutMs: 300_000, idleTimeoutMs: 240_000, maxWaitMs: 900_000 };

describe('evaluateGatewayStartupWait', () => {
  test('never judges a gateway before the base deadline, even when it is silent', () => {
    expect(evaluateGatewayStartupWait(0, 0, policy)).toBe(GatewayStartupWaitOutcome.Waiting);
    expect(evaluateGatewayStartupWait(299_999, 299_999, policy)).toBe(GatewayStartupWaitOutcome.Waiting);
  });

  test('gives up at the base deadline when the gateway produced no recent output', () => {
    expect(evaluateGatewayStartupWait(300_000, 300_000, policy)).toBe(GatewayStartupWaitOutcome.Stalled);
    expect(evaluateGatewayStartupWait(300_000, 240_000, policy)).toBe(GatewayStartupWaitOutcome.Stalled);
  });

  test('keeps a slow start that is still producing output', () => {
    // 2026-09-26 field log: last output at 297.2s, ready at 304s, stopped at 300s.
    expect(evaluateGatewayStartupWait(300_000, 2_800, policy)).toBe(GatewayStartupWaitOutcome.Extended);
    // The same machine went 128s without output while loading plugins.
    expect(evaluateGatewayStartupWait(430_000, 128_000, policy)).toBe(GatewayStartupWaitOutcome.Extended);
    expect(evaluateGatewayStartupWait(430_000, 239_999, policy)).toBe(GatewayStartupWaitOutcome.Extended);
    expect(evaluateGatewayStartupWait(430_000, 240_000, policy)).toBe(GatewayStartupWaitOutcome.Stalled);
  });

  test('enforces the absolute limit even while output continues', () => {
    expect(evaluateGatewayStartupWait(899_999, 0, policy)).toBe(GatewayStartupWaitOutcome.Extended);
    expect(evaluateGatewayStartupWait(900_000, 0, policy)).toBe(GatewayStartupWaitOutcome.LimitReached);
  });

  test('only stalled and limit-reached outcomes end the wait', () => {
    expect(Object.values(GatewayStartupWaitOutcome).filter(isGatewayStartupWaitOver)).toEqual([
      GatewayStartupWaitOutcome.Stalled,
      GatewayStartupWaitOutcome.LimitReached,
    ]);
  });

  test('keeps the historical five-minute base deadline by default', () => {
    expect(DEFAULT_GATEWAY_STARTUP_WAIT_POLICY.baseTimeoutMs).toBe(300_000);
    expect(DEFAULT_GATEWAY_STARTUP_WAIT_POLICY.idleTimeoutMs).toBeGreaterThan(188_000);
    expect(DEFAULT_GATEWAY_STARTUP_WAIT_POLICY.maxWaitMs).toBeGreaterThan(DEFAULT_GATEWAY_STARTUP_WAIT_POLICY.baseTimeoutMs);
  });
});

describe('gatewayStartupProgressPercent', () => {
  test('matches the previous 10-90% ramp within the base deadline', () => {
    expect(gatewayStartupProgressPercent(0, policy)).toBe(10);
    expect(gatewayStartupProgressPercent(150_000, policy)).toBe(50);
    expect(gatewayStartupProgressPercent(300_000, policy)).toBe(90);
  });

  test('creeps toward 95% while extended and never reaches completion', () => {
    expect(gatewayStartupProgressPercent(600_000, policy)).toBe(93);
    expect(gatewayStartupProgressPercent(900_000, policy)).toBe(95);
    expect(gatewayStartupProgressPercent(5_000_000, policy)).toBe(95);
  });
});
