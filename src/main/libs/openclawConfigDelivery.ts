import {
  OPENCLAW_PLUGIN_INDEX_MANAGED_KEYS,
  OpenClawEnginePhase,
} from '../../shared/openclawEngine/constants';
import {
  CONFIG_APPLICATION_CHECK_TIMEOUT_MS,
  confirmOpenClawConfigApplied,
  isOpenClawConfigApplied,
  type OpenClawConfigSnapshot,
} from './openclawConfigApplication';
import { logOpenClawConfigLockDiagnostics } from './openclawConfigDiagnostics';
import {
  type ConfigDeliveryDiagnostic,
  configDiagnosticDigest,
  ConfigDiagnosticErrorKind,
  ConfigDiagnosticOutcome,
  ConfigDiagnosticStage,
  ConfigRecoveryAction,
  ConfigRecoveryEvidence,
} from './openclawConfigObservation';

/**
 * Running-Gateway writes use config.apply's application receipt. A successful
 * save can still require restart, so confirm the exact persisted and applied
 * revisions before releasing dependent work. The caller owns pending recovery.
 */

export const OpenClawConfigDeliveryMode = {
  /** The current target matches a gateway snapshot whose application is confirmed. */
  Applied: 'applied',
  /** Gateway not running; the file on disk will be read at next start. */
  Skipped: 'skipped',
  /** Application unconfirmed; the caller must retain and reconcile the target. */
  Fallback: 'fallback',
  /**
   * Gateway rejected the payload as invalid config. A restart cannot fix an
   * invalid payload (and would interrupt the user for nothing), so no restart
   * is scheduled — the failure is surfaced as an error instead.
   */
  Rejected: 'rejected',
} as const;
export type OpenClawConfigDeliveryMode =
  typeof OpenClawConfigDeliveryMode[keyof typeof OpenClawConfigDeliveryMode];

/**
 * Reason prefix for deferred restarts scheduled by the fallback path. Their
 * goal is target application; a confirmed self-reload may satisfy them without
 * a supervisor respawn. The target need not have been persisted yet.
 */
export const CONFIG_DELIVERY_FALLBACK_REASON_PREFIX = 'config-delivery-fallback:';
export const DEFERRED_SYNC_REASON_PREFIX = 'deferred:';

export const OpenClawConfigRpcMethod = {
  Get: ConfigDiagnosticStage.Get,
  Apply: ConfigDiagnosticStage.Apply,
} as const;

export function isConfigDeliveryFallbackReason(reason: string): boolean {
  const originalReason = reason.startsWith(DEFERRED_SYNC_REASON_PREFIX)
    ? reason.slice(DEFERRED_SYNC_REASON_PREFIX.length)
    : reason;
  return originalReason.startsWith(CONFIG_DELIVERY_FALLBACK_REASON_PREFIX);
}

/** A later env/IM/plugin restart must survive a successful delivery retry. */
export function mergeDeferredGatewayRestartReason(current: string | null, incoming: string): string {
  return !current || (isConfigDeliveryFallbackReason(current) && !isConfigDeliveryFallbackReason(incoming))
    ? incoming
    : current;
}

export type OpenClawConfigRpcClient = {
  request: <T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    opts?: { expectFinal?: boolean; timeoutMs?: number | null },
  ) => Promise<T>;
};

export type OpenClawConfigDeliveryInput = {
  reason: string;
  gatewayPhase: OpenClawEnginePhase;
  /** Latest desired content, rebased on current disk state without a live file write. */
  readConfigFile: () => string;
  /** Used only for read-only diagnostics when config.apply reports lock contention. */
  configPath?: string;
  /**
   * Resolve a connected gateway RPC client, waiting for a starting gateway to
   * come up. Must resolve to null (not throw) when unavailable.
   */
  ensureRpcClient: () => Promise<OpenClawConfigRpcClient | null>;
  /** Omit when rechecking a queued restart; the caller owns the final fallback. */
  scheduleDeferredRestart?: (reason: string) => void;
  /** Observation only; exceptions are isolated from delivery and scheduling. */
  onDiagnostic?: (event: ConfigDeliveryDiagnostic) => void;
};

export type OpenClawConfigDeliveryResult = {
  mode: OpenClawConfigDeliveryMode;
  detail: string;
  restartScheduled: boolean;
  elapsedMs: number;
  /** Native throttling is a deferred retry, never a reason to respawn. */
  retryAfterMs?: number;
};

const CONFIG_GET_TIMEOUT_MS = 10_000;
const CONFIG_APPLY_TIMEOUT_MS = 15_000;
// Genuine competing writes still need bounded retries after the candidate-cache
// backport. Re-read both the public revision and the rebased intent each time.
const CONFIG_HASH_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 4_000] as const;
const isBaseHashConflict = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /base hash|changed since last load/i.test(message);
};

const isConfigValidationRejection = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  // v2026.8.1 can wrap validation failures in an UNAVAILABLE RPC error.
  // Restarting cannot repair the rejected payload, regardless of the wrapper.
  return /invalid config|config validation failed|CONFIG_VALIDATION_FAILED|INVALID_REQUEST/i.test(message);
};

/**
 * Remove `plugins` keys the gateway's `config.apply` schema rejects (they are
 * owned by the plugin index, not the config file — see
 * OPENCLAW_PLUGIN_INDEX_MANAGED_KEYS). The on-disk file tolerates them via a
 * load-time migration, but the RPC validation is strict, so leaving them in
 * turns every hot delivery into a guaranteed fallback restart. Returns the
 * input unchanged when there is nothing to strip or it is not JSON.
 */
export function stripPluginIndexManagedKeysFromRawConfig(raw: string): string {
  try {
    const config = JSON.parse(raw) as Record<string, unknown>;
    const plugins = config?.plugins;
    if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins)) {
      return raw;
    }
    const pluginsRecord = plugins as Record<string, unknown>;
    const managedKeys: readonly string[] = OPENCLAW_PLUGIN_INDEX_MANAGED_KEYS;
    if (!managedKeys.some((key) => key in pluginsRecord)) {
      return raw;
    }
    const cleaned = Object.fromEntries(
      Object.entries(pluginsRecord).filter(([key]) => !managedKeys.includes(key)),
    );
    if (Object.keys(cleaned).length === 0) {
      delete config.plugins;
    } else {
      config.plugins = cleaned;
    }
    return `${JSON.stringify(config, null, 2)}\n`;
  } catch {
    return raw;
  }
}

const describeError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 200);
};

async function requestConfigApply(
  client: OpenClawConfigRpcClient,
  readConfigFile: () => string,
  diagnose: (build: () => ConfigDeliveryDiagnostic) => void,
  attempt: number,
): Promise<ConfigRecoveryEvidence> {
  const request = async <T,>(stage: ConfigDiagnosticStage, params: unknown, timeoutMs: number): Promise<T> => {
    const startedAt = Date.now();
    diagnose(() => ({ stage, attempt, outcome: ConfigDiagnosticOutcome.Started, elapsedMs: 0, timeoutMs }));
    try {
      const result = await client.request<T>(stage, params, { timeoutMs });
      diagnose(() => ({
        stage, attempt, outcome: ConfigDiagnosticOutcome.Succeeded, elapsedMs: Date.now() - startedAt, timeoutMs,
        rawRevision: result && typeof result === 'object' && 'hash' in result && typeof result.hash === 'string'
          ? configDiagnosticDigest(result.hash) : undefined,
      }));
      return result;
    } catch (error) {
      diagnose(() => ({
        stage, attempt, outcome: ConfigDiagnosticOutcome.Failed, elapsedMs: Date.now() - startedAt, timeoutMs,
        errorKind: classifyDiagnosticError(error),
      }));
      throw error;
    }
  };
  const snapshot = await request<OpenClawConfigSnapshot>(
    OpenClawConfigRpcMethod.Get,
    {},
    CONFIG_GET_TIMEOUT_MS,
  );
  const baseHash = typeof snapshot?.hash === 'string' && snapshot.hash.trim()
    ? snapshot.hash.trim()
    : undefined;
  // A watcher migration or another writer may have changed the file while we
  // awaited the hash. Never replay the payload captured before a retry wait.
  const readStartedAt = Date.now();
  let raw: string;
  try {
    raw = readConfigFile();
    if (!raw.trim()) throw new Error('config file is empty');
  } catch (error) {
    diagnose(() => ({
      stage: ConfigDiagnosticStage.Read, attempt, outcome: ConfigDiagnosticOutcome.Failed,
      elapsedMs: Date.now() - readStartedAt, errorKind: classifyDiagnosticError(error),
    }));
    throw error;
  }
  const payload = stripPluginIndexManagedKeysFromRawConfig(raw);
  diagnose(() => ({
    stage: ConfigDiagnosticStage.Read, attempt, outcome: ConfigDiagnosticOutcome.Succeeded, elapsedMs: Date.now() - readStartedAt,
    payloadDigest: configDiagnosticDigest(payload), payloadBytes: Buffer.byteLength(payload),
    rawRevision: typeof snapshot?.hash === 'string' ? configDiagnosticDigest(snapshot.hash) : undefined,
    resolvedRevision: typeof snapshot?.configRevisionHash === 'string' ? configDiagnosticDigest(snapshot.configRevisionHash) : undefined,
    appliedRevision: typeof snapshot?.appliedConfigHash === 'string' ? configDiagnosticDigest(snapshot.appliedConfigHash) : undefined,
  }));
  if (isOpenClawConfigApplied(snapshot, payload)) return ConfigRecoveryEvidence.Applied;
  if (!baseHash) throw new Error('config.get returned no revision for a conditional write');
  const receipt = await request<{ hash?: string }>(
    OpenClawConfigRpcMethod.Apply,
    { raw: payload, ...(baseHash ? { baseHash } : {}) },
    CONFIG_APPLY_TIMEOUT_MS,
  );
  const applied = await confirmOpenClawConfigApplied({
    readConfigFile: () => stripPluginIndexManagedKeysFromRawConfig(readConfigFile()),
    persistedHash: receipt?.hash,
    persistedRaw: payload,
    readSnapshot: () => client.request<OpenClawConfigSnapshot>(
      OpenClawConfigRpcMethod.Get, {}, { timeoutMs: CONFIG_APPLICATION_CHECK_TIMEOUT_MS },
    ),
  });
  return applied ? ConfigRecoveryEvidence.Applied : ConfigRecoveryEvidence.Unconfirmed;
}

function classifyDiagnosticError(error: unknown): ConfigDiagnosticErrorKind {
  if (isBaseHashConflict(error)) return ConfigDiagnosticErrorKind.HashConflict;
  if (isConfigValidationRejection(error)) return ConfigDiagnosticErrorKind.Validation;
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out/i.test(message)) return ConfigDiagnosticErrorKind.Timeout;
  if (/closed|disconnected|unavailable/i.test(message)) return ConfigDiagnosticErrorKind.Unavailable;
  return ConfigDiagnosticErrorKind.Other;
}

/**
 * Push the current config file content to a running gateway and return how the
 * delivery concluded. Never throws: transient failures degrade to the
 * deferred-restart fallback, while invalid payloads return `Rejected` so the
 * caller can surface the configuration error without restarting in a loop.
 */
export async function deliverOpenClawConfigToGateway(
  input: OpenClawConfigDeliveryInput,
): Promise<OpenClawConfigDeliveryResult> {
  const now = Date.now;
  const startedAtMs = now();
  let diagnosticAttempt = 0;
  const diagnose = (build: () => ConfigDeliveryDiagnostic): void => {
    try {
      if (input.onDiagnostic) input.onDiagnostic(build());
    } catch {
      // Diagnostics are deliberately outside the delivery result contract.
    }
  };
  const finish = (
    mode: OpenClawConfigDeliveryMode,
    detail: string,
    restartScheduled = false,
    retryAfterMs?: number,
  ): OpenClawConfigDeliveryResult => {
    const result: OpenClawConfigDeliveryResult = {
      mode,
      detail,
      restartScheduled,
      elapsedMs: now() - startedAtMs,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
    const log = mode === OpenClawConfigDeliveryMode.Rejected
      ? console.error
      : mode === OpenClawConfigDeliveryMode.Fallback ? console.warn : console.log;
    log(
      `[ConfigDelivery] mode=${result.mode} reason=${input.reason} detail=${result.detail}`
      + ` restartScheduled=${result.restartScheduled} elapsedMs=${result.elapsedMs}`,
    );
    diagnose(() => ({
      stage: ConfigDiagnosticStage.Complete, attempt: diagnosticAttempt, elapsedMs: result.elapsedMs,
      outcome: mode === OpenClawConfigDeliveryMode.Fallback || mode === OpenClawConfigDeliveryMode.Rejected
        ? ConfigDiagnosticOutcome.Failed : ConfigDiagnosticOutcome.Succeeded,
      evidence: mode === OpenClawConfigDeliveryMode.Applied ? ConfigRecoveryEvidence.Applied
        : mode === OpenClawConfigDeliveryMode.Rejected ? ConfigRecoveryEvidence.Rejected
          : mode === OpenClawConfigDeliveryMode.Skipped ? ConfigRecoveryEvidence.NextStart : ConfigRecoveryEvidence.Unconfirmed,
      actualAction: restartScheduled ? ConfigRecoveryAction.Scheduled
          : mode === OpenClawConfigDeliveryMode.Fallback ? ConfigRecoveryAction.CallerFallback : ConfigRecoveryAction.None,
    }));
    return result;
  };

  const fallback = (detail: string, retryAfterMs?: number): OpenClawConfigDeliveryResult => {
    if (!input.scheduleDeferredRestart) {
      return finish(OpenClawConfigDeliveryMode.Fallback, detail, false, retryAfterMs);
    }
    input.scheduleDeferredRestart(`${CONFIG_DELIVERY_FALLBACK_REASON_PREFIX}${input.reason}`);
    return finish(OpenClawConfigDeliveryMode.Fallback, detail, true, retryAfterMs);
  };

  const diagnoseLockFailure = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    if (input.configPath && /file[_ ]lock[_ ]timeout/i.test(message)) {
      logOpenClawConfigLockDiagnostics(input.configPath, `config-delivery:${input.reason}`);
    }
  };

  if (
    input.gatewayPhase !== OpenClawEnginePhase.Running
    && input.gatewayPhase !== OpenClawEnginePhase.Starting
  ) {
    return finish(
      OpenClawConfigDeliveryMode.Skipped,
      `gateway not running (phase=${input.gatewayPhase}); config loads at next start`,
    );
  }

  let raw: string;
  const readStartedAt = Date.now();
  try {
    raw = input.readConfigFile();
    diagnose(() => ({
      stage: ConfigDiagnosticStage.Read, attempt: 0, outcome: ConfigDiagnosticOutcome.Succeeded,
      elapsedMs: Date.now() - readStartedAt, payloadDigest: configDiagnosticDigest(raw), payloadBytes: Buffer.byteLength(raw),
    }));
  } catch (error) {
    diagnose(() => ({
      stage: ConfigDiagnosticStage.Read, attempt: 0, outcome: ConfigDiagnosticOutcome.Failed,
      elapsedMs: Date.now() - readStartedAt, errorKind: classifyDiagnosticError(error),
    }));
    return fallback(`config file read failed: ${describeError(error)}`);
  }
  if (!raw.trim()) {
    return fallback('config file is empty');
  }
  let client: OpenClawConfigRpcClient | null = null;
  const connectStartedAt = Date.now();
  try {
    client = await input.ensureRpcClient();
  } catch (error) {
    diagnose(() => ({
      stage: ConfigDiagnosticStage.Connect, attempt: 0, outcome: ConfigDiagnosticOutcome.Failed,
      elapsedMs: Date.now() - connectStartedAt, errorKind: classifyDiagnosticError(error),
    }));
    return fallback(`gateway client unavailable: ${describeError(error)}`);
  }
  diagnose(() => ({
    stage: ConfigDiagnosticStage.Connect, attempt: 0,
    outcome: client ? ConfigDiagnosticOutcome.Succeeded : ConfigDiagnosticOutcome.Failed,
    elapsedMs: Date.now() - connectStartedAt,
  }));
  if (!client) {
    return fallback('gateway client unavailable');
  }

  for (let attempt = 0; ; attempt += 1) {
    diagnosticAttempt = attempt + 1;
    try {
      const evidence = await requestConfigApply(client, input.readConfigFile, diagnose, diagnosticAttempt);
      if (evidence === ConfigRecoveryEvidence.Applied) {
        return finish(OpenClawConfigDeliveryMode.Applied, 'target config application confirmed');
      }
      return fallback('config.apply saved the target; runtime application remains pending');
    } catch (error) {
      diagnoseLockFailure(error);
      if (!isBaseHashConflict(error)) {
        if (isConfigValidationRejection(error)) {
          return finish(
            OpenClawConfigDeliveryMode.Rejected,
            `config.apply rejected payload: ${describeError(error)}; restart skipped`,
          );
        }
        if (!isConfigValidationRejection(error)) {
          const applied = await confirmOpenClawConfigApplied({
            readConfigFile: () => stripPluginIndexManagedKeysFromRawConfig(input.readConfigFile()),
            readSnapshot: async () => {
              const probeStartedAt = Date.now();
              try {
                const snapshot = await client.request<OpenClawConfigSnapshot>(
                  OpenClawConfigRpcMethod.Get, {}, { timeoutMs: CONFIG_APPLICATION_CHECK_TIMEOUT_MS },
                );
                diagnose(() => ({
                  stage: ConfigDiagnosticStage.Verify, attempt: diagnosticAttempt,
                  outcome: ConfigDiagnosticOutcome.Succeeded, elapsedMs: Date.now() - probeStartedAt,
                  timeoutMs: CONFIG_APPLICATION_CHECK_TIMEOUT_MS,
                }));
                return snapshot;
              } catch (probeError) {
                diagnose(() => ({
                  stage: ConfigDiagnosticStage.Verify, attempt: diagnosticAttempt,
                  outcome: ConfigDiagnosticOutcome.Failed, elapsedMs: Date.now() - probeStartedAt,
                  timeoutMs: CONFIG_APPLICATION_CHECK_TIMEOUT_MS, errorKind: classifyDiagnosticError(probeError),
                }));
                throw probeError;
              }
            },
          });
          if (applied) return finish(OpenClawConfigDeliveryMode.Applied, 'current config application confirmed after timeout');
        }
        const retryAfterMs = error && typeof error === 'object' && 'retryAfterMs' in error
          && typeof error.retryAfterMs === 'number' && Number.isFinite(error.retryAfterMs)
          && error.retryAfterMs >= 0 ? error.retryAfterMs : undefined;
        return fallback(`config.apply failed: ${describeError(error)}`, retryAfterMs);
      }
      if (attempt >= CONFIG_HASH_RETRY_DELAYS_MS.length) {
        return fallback(`config.apply hash retries exhausted: ${describeError(error)}`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, CONFIG_HASH_RETRY_DELAYS_MS[attempt]));
    }
  }
}
