import { createHmac, randomBytes } from 'node:crypto';

import type { ConfigDeliveryState } from '../../shared/openclawEngine/configDelivery';

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
  Rejected: 'rejected',
  NextStart: 'next-start',
  RestartRequired: 'restart-required',
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
  WaitBusy: 'wait-busy',
  WaitEvidence: 'wait-evidence',
  RetainPending: 'retain-pending',
  RetryDelivery: 'retry-delivery',
  VerifyApplied: 'verify-applied',
  ReportRejection: 'report-rejection',
  LoadAtStart: 'load-at-start',
  AwaitIdleRestart: 'await-idle-restart',
} as const;

/** Pure shadow policy. No executor, timer, RPC client or scheduling callback. */
export function observeConfigRecovery(input: {
  evidence: ConfigRecoveryEvidence;
  actualAction: ConfigRecoveryAction;
  workloadState: ConfigWorkloadState;
}) {
  const suggestion = input.evidence === ConfigRecoveryEvidence.Accepted
    ? ConfigRecoverySuggestion.VerifyApplied
    : input.evidence === ConfigRecoveryEvidence.Rejected
      ? ConfigRecoverySuggestion.ReportRejection
      : input.evidence === ConfigRecoveryEvidence.NextStart
        ? ConfigRecoverySuggestion.LoadAtStart
        : input.evidence === ConfigRecoveryEvidence.RestartRequired
          ? input.workloadState === ConfigWorkloadState.Busy ? ConfigRecoverySuggestion.WaitBusy
            : input.workloadState === ConfigWorkloadState.Unknown ? ConfigRecoverySuggestion.WaitEvidence
              : ConfigRecoverySuggestion.AwaitIdleRestart
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
  Set: 'config.set',
  Patch: 'config.patch',
  Complete: 'complete',
} as const;
export type ConfigDiagnosticStage = typeof ConfigDiagnosticStage[keyof typeof ConfigDiagnosticStage];

export const ConfigDiagnosticOutcome = {
  Started: 'started',
  Succeeded: 'succeeded',
  Pending: 'pending',
  RestartRequired: 'restart-required',
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
  receiptState?: ConfigDeliveryState;
  restartPaths?: string[];
};

/** Keep schema fields, never dynamic agent/plugin IDs, unknown keys or path values. */
export function sanitizeConfigRestartPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const roots = new Set(['gateway', 'plugins', 'agents', 'skills', 'env', 'discovery', 'mcp', 'secrets',
    'channels', 'commands', 'models', 'tools', 'hooks', 'cron', 'browser', 'talk', 'session']);
  const fields = new Set(['auth', 'mode', 'token', 'password', 'bind', 'port', 'reload', 'tailscale',
    'load', 'paths', 'installs', 'entries', 'enabled', 'allow', 'deny', 'slots', 'memory', 'mdns',
    'wideArea', 'apps', 'egressProxy', 'terminal', 'controlUi', 'defaults', 'vars']);
  return [...new Set(value.slice(0, 32).filter((item): item is string => typeof item === 'string')
    .map(item => {
      const segments = item.slice(0, 512).split('.');
      if (!roots.has(segments[0])) return '<unknown>';
      const safe = [segments[0]];
      for (const segment of segments.slice(1, 4)) {
        if (!fields.has(segment) || ['entries', 'installs', 'vars'].includes(safe.at(-1)!)) {
          safe.push('<key>'); break;
        }
        safe.push(segment);
      }
      return safe.join('.');
    }))];
}

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
