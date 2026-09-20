import { afterEach, expect, test, vi } from 'vitest';

import {
  configDiagnosticDigest, ConfigRecoveryAction, ConfigRecoveryEvidence,
  ConfigRecoverySuggestion, ConfigWorkloadState, observeConfigRecovery, writeConfigDiagnostic,
} from './openclawConfigObservation';

afterEach(() => vi.restoreAllMocks());

test.each([
  [ConfigRecoveryEvidence.Accepted, ConfigRecoveryAction.None, ConfigWorkloadState.Idle, ConfigRecoverySuggestion.VerifyApplied],
  [ConfigRecoveryEvidence.Unconfirmed, ConfigRecoveryAction.RateLimited, ConfigWorkloadState.Idle, ConfigRecoverySuggestion.RetainPending],
  [ConfigRecoveryEvidence.Unconfirmed, ConfigRecoveryAction.CallerFallback, ConfigWorkloadState.Busy, ConfigRecoverySuggestion.WaitBusy],
  [ConfigRecoveryEvidence.Unconfirmed, ConfigRecoveryAction.Scheduled, ConfigWorkloadState.Unknown, ConfigRecoverySuggestion.WaitEvidence],
  [ConfigRecoveryEvidence.Unconfirmed, ConfigRecoveryAction.Scheduled, ConfigWorkloadState.Idle, ConfigRecoverySuggestion.RetryDelivery],
  [ConfigRecoveryEvidence.Rejected, ConfigRecoveryAction.None, ConfigWorkloadState.Idle, ConfigRecoverySuggestion.ReportRejection],
  [ConfigRecoveryEvidence.NextStart, ConfigRecoveryAction.None, ConfigWorkloadState.Unknown, ConfigRecoverySuggestion.LoadAtStart],
  [ConfigRecoveryEvidence.RestartRequired, ConfigRecoveryAction.None, ConfigWorkloadState.Idle, ConfigRecoverySuggestion.AwaitIdleRestart],
  [ConfigRecoveryEvidence.RestartRequired, ConfigRecoveryAction.None, ConfigWorkloadState.Busy, ConfigRecoverySuggestion.WaitBusy],
] as const)('shadow policy reports %s / %s / %s without scheduling', (evidence, actualAction, workloadState, suggestion) => {
  vi.useFakeTimers();
  try {
    const input = Object.freeze({ evidence, actualAction, workloadState });
    expect(observeConfigRecovery(input)).toEqual({ observationOnly: true, ...input, suggestion });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test('diagnostic digest is correlatable in-process and contains no source text', () => {
  const raw = '{"token":"synthetic-secret","path":"private-path"}';
  expect(configDiagnosticDigest(raw)).toMatch(/^[a-f0-9]{16}$/);
  expect(configDiagnosticDigest(raw)).toBe(configDiagnosticDigest(raw));
  expect(configDiagnosticDigest(raw)).not.toBe(configDiagnosticDigest(`${raw} `));
});

test('a broken diagnostic transport cannot throw into product logic', () => {
  vi.spyOn(console, 'debug').mockImplementation(() => { throw new Error('log unavailable'); });
  vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('log unavailable'); });
  expect(() => writeConfigDiagnostic({ syncId: 1 })).not.toThrow();
  expect(() => writeConfigDiagnostic({ syncId: 1 }, true)).not.toThrow();
});
