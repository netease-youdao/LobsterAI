import { describe, expect, test } from 'vitest';

import {
  advanceGatewayStartupStage,
  DEFAULT_GATEWAY_STARTUP_WAIT_POLICY,
  evaluateGatewayStartupWait,
  gatewayStartupProgressPercent,
  GatewayStartupStage,
  GatewayStartupWaitOutcome,
  isGatewayStartupWaitOver,
  resolveGatewayStartupStage,
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

describe('gateway startup stages', () => {
  test('recognizes milestones in plain and colored gateway output', () => {
    expect(resolveGatewayStartupStage('2026-10-30T15:39:20.286+09:00 [gateway] loading configuration…'))
      .toBe(GatewayStartupStage.LoadingConfig);
    expect(resolveGatewayStartupStage('\u001b[36m[gateway]\u001b[39m \u001b[36mstarting HTTP server...\u001b[39m'))
      .toBe(GatewayStartupStage.StartingHttp);
    expect(resolveGatewayStartupStage('[gateway] starting channels and sidecars...'))
      .toBe(GatewayStartupStage.StartingChannels);
    expect(resolveGatewayStartupStage('[gateway] resolving authentication…')).toBeNull();
  });

  test('takes the latest milestone of a chunk and never moves backwards', () => {
    expect(resolveGatewayStartupStage('[gateway] loading configuration…\n[gateway] starting HTTP server...'))
      .toBe(GatewayStartupStage.StartingHttp);
    expect(advanceGatewayStartupStage(GatewayStartupStage.Spawned, GatewayStartupStage.LoadingConfig))
      .toBe(GatewayStartupStage.LoadingConfig);
    expect(advanceGatewayStartupStage(GatewayStartupStage.StartingHttp, GatewayStartupStage.LoadingConfig))
      .toBe(GatewayStartupStage.StartingHttp);
    expect(advanceGatewayStartupStage(GatewayStartupStage.StartingHttp, null)).toBe(GatewayStartupStage.StartingHttp);
  });
});

describe('gatewayStartupProgressPercent', () => {
  test('a typical 13s start moves well past the initial 10%', () => {
    // 2026-10-30 field log: 5.7s until "loading configuration", ready 3.3s later.
    expect(gatewayStartupProgressPercent(GatewayStartupStage.Spawned, 0)).toBe(20);
    expect(gatewayStartupProgressPercent(GatewayStartupStage.Spawned, 5_700)).toBeGreaterThanOrEqual(34);
    expect(gatewayStartupProgressPercent(GatewayStartupStage.LoadingConfig, 0)).toBe(55);
    expect(gatewayStartupProgressPercent(GatewayStartupStage.StartingChannels, 1_000)).toBeGreaterThanOrEqual(85);
  });

  test('each stage stays below the next one and below completion', () => {
    expect(gatewayStartupProgressPercent(GatewayStartupStage.Spawned, 900_000))
      .toBeLessThan(gatewayStartupProgressPercent(GatewayStartupStage.LoadingConfig, 0));
    expect(gatewayStartupProgressPercent(GatewayStartupStage.LoadingConfig, 900_000))
      .toBeLessThan(gatewayStartupProgressPercent(GatewayStartupStage.StartingHttp, 0));
    expect(gatewayStartupProgressPercent(GatewayStartupStage.StartingHttp, 900_000))
      .toBeLessThan(gatewayStartupProgressPercent(GatewayStartupStage.StartingChannels, 0));
    expect(gatewayStartupProgressPercent(GatewayStartupStage.StartingChannels, 5_000_000)).toBe(94);
  });
});
