import { createHmac, randomBytes } from 'node:crypto';

// Process-local correlation only. Never log raw config, tokens or session keys.
const diagnosticKey = randomBytes(32);
export function configDiagnosticDigest(value: string): string {
  return createHmac('sha256', diagnosticKey).update(value).digest('hex').slice(0, 16);
}

export const ConfigWorkloadState = {
  Busy: 'busy',
  Idle: 'idle',
  Unknown: 'unknown',
} as const;
export type ConfigWorkloadState = typeof ConfigWorkloadState[keyof typeof ConfigWorkloadState];

export const ConfigRecoveryEvidence = {
  Unconfirmed: 'unconfirmed',
  Accepted: 'accepted',
  Applied: 'applied',
  Rejected: 'rejected',
  NextStart: 'next-start',
} as const;
export type ConfigRecoveryEvidence = typeof ConfigRecoveryEvidence[keyof typeof ConfigRecoveryEvidence];

export const ConfigRecoveryAction = {
  None: 'none',
  Scheduled: 'scheduled',
  RateLimited: 'rate-limited',
  CallerFallback: 'caller-fallback',
} as const;
export type ConfigRecoveryAction = typeof ConfigRecoveryAction[keyof typeof ConfigRecoveryAction];

export const ConfigRecoverySuggestion = {
  None: 'none',
  WaitBusy: 'wait-busy',
  WaitEvidence: 'wait-evidence',
  RetainPending: 'retain-pending',
  RetryDelivery: 'retry-delivery',
  VerifyApplied: 'verify-applied',
  ReportRejection: 'report-rejection',
  LoadAtStart: 'load-at-start',
} as const;

/** Pure shadow policy. No executor, timer, RPC client or scheduling callback. */
export function observeConfigRecovery(input: {
  evidence: ConfigRecoveryEvidence;
  actualAction: ConfigRecoveryAction;
  workloadState: ConfigWorkloadState;
}) {
  const suggestion = input.evidence === ConfigRecoveryEvidence.Applied
    ? ConfigRecoverySuggestion.None
    : input.evidence === ConfigRecoveryEvidence.Accepted
      ? ConfigRecoverySuggestion.VerifyApplied
    : input.evidence === ConfigRecoveryEvidence.Rejected
      ? ConfigRecoverySuggestion.ReportRejection
      : input.evidence === ConfigRecoveryEvidence.NextStart
        ? ConfigRecoverySuggestion.LoadAtStart
        : input.actualAction === ConfigRecoveryAction.RateLimited
          ? ConfigRecoverySuggestion.RetainPending
          : input.workloadState === ConfigWorkloadState.Busy
            ? ConfigRecoverySuggestion.WaitBusy
            : input.workloadState === ConfigWorkloadState.Unknown
              ? ConfigRecoverySuggestion.WaitEvidence
              : ConfigRecoverySuggestion.RetryDelivery;
  return { observationOnly: true, ...input, suggestion } as const;
}

export const ConfigDiagnosticStage = {
  Read: 'read',
  Connect: 'connect',
  Get: 'config.get',
  Apply: 'config.apply',
  Verify: 'verify-applied',
  Complete: 'complete',
} as const;
export type ConfigDiagnosticStage = typeof ConfigDiagnosticStage[keyof typeof ConfigDiagnosticStage];

export const ConfigDiagnosticOutcome = {
  Started: 'started',
  Succeeded: 'succeeded',
  Failed: 'failed',
} as const;
export type ConfigDiagnosticOutcome = typeof ConfigDiagnosticOutcome[keyof typeof ConfigDiagnosticOutcome];

export const ConfigDiagnosticErrorKind = {
  HashConflict: 'hash-conflict',
  Validation: 'validation',
  Timeout: 'timeout',
  Unavailable: 'unavailable',
  Other: 'other',
} as const;
export type ConfigDiagnosticErrorKind = typeof ConfigDiagnosticErrorKind[keyof typeof ConfigDiagnosticErrorKind];

export type ConfigDeliveryDiagnostic = {
  stage: ConfigDiagnosticStage;
  outcome: ConfigDiagnosticOutcome;
  attempt: number;
  elapsedMs: number;
  timeoutMs?: number;
  payloadDigest?: string;
  payloadBytes?: number;
  rawRevision?: string;
  resolvedRevision?: string;
  appliedRevision?: string;
  errorKind?: ConfigDiagnosticErrorKind;
  evidence?: ConfigRecoveryEvidence;
  actualAction?: ConfigRecoveryAction;
};

/** Logging must never become part of the config delivery/restart contract. */
export function writeConfigDiagnostic(fields: Record<string, unknown>, warn = false): void {
  try {
    const line = `[OpenClawConfigDiagnostic] ${JSON.stringify({ hostPid: process.pid, ...fields })}`;
    if (warn) console.warn(line);
    else console.debug(line);
  } catch {
    // Best effort: even a broken log transport must not affect the user action.
  }
}
