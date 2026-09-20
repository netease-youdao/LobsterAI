import { createHash, randomUUID } from 'node:crypto';

import { ConfigDeliveryState } from '../../shared/openclawEngine/configDelivery';
export { type ConfigDeliveryReceipt,ConfigDeliveryState } from '../../shared/openclawEngine/configDelivery';
import {
  OPENCLAW_PLUGIN_INDEX_MANAGED_KEYS,
  OpenClawEnginePhase,
} from '../../shared/openclawEngine/constants';
import {
  type ConfigDeliveryDiagnostic, configDiagnosticDigest, ConfigDiagnosticErrorKind,
  ConfigDiagnosticOutcome, ConfigDiagnosticStage, ConfigRecoveryAction, ConfigRecoveryEvidence,
  sanitizeConfigRestartPaths,
} from './openclawConfigObservation';

export const OpenClawConfigRpcMethod = {
  Get: ConfigDiagnosticStage.Get, Set: ConfigDiagnosticStage.Set, Patch: ConfigDiagnosticStage.Patch,
} as const;

/**
 * Delivers a generated candidate through the live gateway mutation owner.
 *
 * A write ACK only confirms persistence. Mutation receipts settle application;
 * timeouts remain pending and never authorize a restart or another write.
 */
export const OpenClawConfigDeliveryMode = {
  RpcPatch: 'rpc-patch',
  RpcSet: 'rpc-set',
  // Compatibility alias for callers/tests that used the old single RPC mode.
  Rpc: 'rpc-set',
  Skipped: 'skipped',
  Fallback: 'fallback',
  Rejected: 'rejected',
} as const;
export type OpenClawConfigDeliveryMode =
  typeof OpenClawConfigDeliveryMode[keyof typeof OpenClawConfigDeliveryMode];

export const CONFIG_DELIVERY_FALLBACK_REASON_PREFIX = 'config-delivery-fallback:';

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
  readConfigFile: () => string;
  /** Immutable generated candidate. A live gateway is its only disk writer. */
  candidateRaw?: string;
  mutationId?: string;
  gatewayGeneration?: number;
  rebuildCandidate?: () => string;
  signal?: AbortSignal;
  ensureRpcClient: () => Promise<OpenClawConfigRpcClient | null>;
  scheduleDeferredRestart?: (reason: string) => void;
  changedTopLevelKeys?: string[];
  preferIncremental?: boolean;
  deadlineAtMs?: number;
  nowMs?: () => number;
  onDiagnostic?: (event: ConfigDeliveryDiagnostic) => void;
};

export type OpenClawConfigDeliveryResult = {
  mode: OpenClawConfigDeliveryMode;
  detail: string;
  restartScheduled: boolean;
  elapsedMs: number;
  state: typeof ConfigDeliveryState[keyof typeof ConfigDeliveryState];
  mutationId: string;
  desiredRevision?: string;
  persistedRevision?: string;
  appliedRevision?: string;
  restartPaths?: string[];
};

const CONFIG_GET_TIMEOUT_MS = 10_000;
const CONFIG_SET_TIMEOUT_MS = 15_000;
type DeliveryRecord = {
  key: string;
  generation: number;
  mutationId: string;
  submitted: boolean;
  result?: OpenClawConfigDeliveryResult;
  inFlight?: Promise<OpenClawConfigDeliveryResult>;
};
// One current desired revision, scoped to the runtime process generation. Keep
// uncertain writes here even when the disk already matches the candidate.
let currentDelivery: DeliveryRecord | undefined;
export function hasPendingOpenClawConfigDelivery(gatewayGeneration?: number): boolean {
  return Boolean(currentDelivery && (gatewayGeneration === undefined || currentDelivery.generation === gatewayGeneration)
    && (currentDelivery.inFlight || currentDelivery.result?.state === ConfigDeliveryState.Pending));
}
export function __resetOpenClawConfigDeliveryStateForTests(): void { currentDelivery = undefined; }

function canonicalCandidate(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalCandidate);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => [key, canonicalCandidate(child)]));
}

function candidateIdentity(raw: string): string {
  const candidate = JSON.parse(stripPluginIndexManagedKeysFromRawConfig(raw));
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) delete candidate.meta;
  return configDiagnosticDigest(JSON.stringify(canonicalCandidate(candidate)));
}

const isBaseHashConflict = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /base hash|changed since last load/i.test(message);
};

const isConfigValidationRejection = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /invalid config|invalid[_ ]request/i.test(message);
};

export function stripPluginIndexManagedKeysFromRawConfig(raw: string): string {
  try {
    const config = JSON.parse(raw) as Record<string, unknown>;
    const plugins = config.plugins;
    if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return raw;

    const pluginsRecord = plugins as Record<string, unknown>;
    if (!OPENCLAW_PLUGIN_INDEX_MANAGED_KEYS.some(key => key in pluginsRecord)) return raw;

    const cleaned = Object.fromEntries(
      Object.entries(pluginsRecord)
        .filter(([key]) => !OPENCLAW_PLUGIN_INDEX_MANAGED_KEYS.includes(
          key as typeof OPENCLAW_PLUGIN_INDEX_MANAGED_KEYS[number],
        )),
    );
    if (Object.keys(cleaned).length > 0) config.plugins = cleaned;
    else delete config.plugins;
    return `${JSON.stringify(config, null, 2)}\n`;
  } catch {
    return raw;
  }
}

function classifyDiagnosticError(error: unknown): ConfigDiagnosticErrorKind {
  if (isBaseHashConflict(error)) return ConfigDiagnosticErrorKind.HashConflict;
  if (isConfigValidationRejection(error)) return ConfigDiagnosticErrorKind.Validation;
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out|deadline/i.test(message)) return ConfigDiagnosticErrorKind.Timeout;
  if (/closed|disconnected|unavailable/i.test(message)) return ConfigDiagnosticErrorKind.Unavailable;
  return ConfigDiagnosticErrorKind.Other;
}

const resolveConfigSnapshot = (snapshot: unknown): Record<string, unknown> | null => {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const source = snapshot as Record<string, unknown>;
  for (const key of ['resolved', 'parsed', 'config', 'value']) {
    const candidate = source[key];
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      return candidate as Record<string, unknown>;
    }
  }
  if (typeof source.raw === 'string') {
    try {
      const parsed = JSON.parse(source.raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return source;
};

export async function readOpenClawGatewayAgentIds(
  client: OpenClawConfigRpcClient,
  timeoutMs = CONFIG_GET_TIMEOUT_MS,
): Promise<Set<string>> {
  const snapshot = await client.request(
    'config.get',
    {},
    { timeoutMs: Math.max(1, timeoutMs) },
  );
  const config = resolveConfigSnapshot(snapshot);
  return collectConfiguredAgentIds(config?.agents);
}

/**
 * Agent ids from either config shape: the legacy `agents.list` array of `{ id }` and the
 * keyed `agents.entries` map that openclaw.json uses now (an `entries` array is accepted too).
 * Reading only `list` made expert-team verification report every new member as missing.
 */
export function collectConfiguredAgentIds(agents: unknown): Set<string> {
  const ids = new Set<string>();
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return ids;
  const record = agents as Record<string, unknown>;
  const addFromArray = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const id = (entry as Record<string, unknown>).id;
      if (typeof id === 'string' && id.trim()) ids.add(id.trim());
    }
  };
  addFromArray(record.list);
  const entries = record.entries;
  if (Array.isArray(entries)) addFromArray(entries);
  else if (entries && typeof entries === 'object') {
    for (const key of Object.keys(entries as Record<string, unknown>)) {
      if (key.trim()) ids.add(key.trim());
    }
  }
  return ids;
}

type MutationReceipt = {
  restartPaths?: unknown;
  mutationId?: string;
  state?: string;
  desiredRevision?: string;
  persistedRevision?: string;
  appliedRevision?: string;
};
type ConfigReadback = {
  restartPaths?: unknown;
  hash?: string;
  configRevisionHash?: string;
  appliedConfigHash?: string;
  capabilities?: { configMutationReceipts?: number };
  persistedCandidateMatches?: boolean;
  mutation?: MutationReceipt | null;
};

export async function deliverOpenClawConfigToGateway(
  input: OpenClawConfigDeliveryInput,
): Promise<OpenClawConfigDeliveryResult> {
  let candidateRaw: string;
  let key: string;
  try {
    candidateRaw = stripPluginIndexManagedKeysFromRawConfig(input.candidateRaw ?? input.readConfigFile());
    key = candidateIdentity(candidateRaw);
  } catch {
    return deliverConfigMutation(input);
  }
  const generation = input.gatewayGeneration ?? 0;
  const previous = currentDelivery;
  const record: DeliveryRecord = previous?.key === key && previous.generation === generation ? previous
    : { key, generation, mutationId: input.mutationId ?? randomUUID(), submitted: false };
  currentDelivery = record;
  if (record.inFlight) return record.inFlight;
  const priorApplied = record.result?.state === ConfigDeliveryState.Applied ? record.result : undefined;
  if (record.result && record.result.state !== ConfigDeliveryState.Pending && !priorApplied) return record.result;
  if (priorApplied) {
    // Another writer may have changed the runtime since this receipt settled.
    // Verify the current persisted/applied identity before reusing a success.
    record.submitted = false;
    record.mutationId = randomUUID();
  }
  const pending = deliverConfigMutation({ ...input, candidateRaw, mutationId: record.mutationId }, {
    reconcileOnly: record.submitted,
    onSubmitted: (id) => { record.submitted = true; record.mutationId = id; },
    priorApplied,
  });
  record.inFlight = pending;
  try {
    const result = await pending;
    record.result = result;
    record.mutationId = result.mutationId;
    return result;
  } finally { record.inFlight = undefined; }
}

async function deliverConfigMutation(
  input: OpenClawConfigDeliveryInput,
  existing?: { reconcileOnly: boolean; onSubmitted: (id: string) => void; priorApplied?: OpenClawConfigDeliveryResult },
): Promise<OpenClawConfigDeliveryResult> {
  const now = input.nowMs ?? Date.now;
  const sleep = (ms: number) => new Promise<void>(resolve => {
    const signal = input.signal;
    const finishWait = () => { clearTimeout(timer); signal?.removeEventListener('abort', finishWait); resolve(); };
    const timer = setTimeout(finishWait, ms);
    signal?.addEventListener('abort', finishWait, { once: true });
    if (signal?.aborted) finishWait();
  });
  const started = now();
  let mutationId = input.mutationId ?? randomUUID();
  let desiredRevision: string | undefined;
  let persistedRevision: string | undefined;
  let appliedRevision: string | undefined;
  let restartPaths: string[] | undefined;
  let attempt = 0;
  let payloadDigest: string | undefined;
  let mode: OpenClawConfigDeliveryMode = OpenClawConfigDeliveryMode.Skipped;
  const diagnose = (event: ConfigDeliveryDiagnostic) => {
    try { input.onDiagnostic?.(event); } catch { /* Observation never owns delivery. */ }
  };
  const timeoutFor = (max: number) => {
    const remaining = input.deadlineAtMs === undefined ? max : input.deadlineAtMs - now();
    if (remaining <= 0) throw new Error('config delivery deadline exceeded');
    return Math.max(1, Math.min(max, remaining));
  };
  const finish = (state: OpenClawConfigDeliveryResult['state'], detail: string): OpenClawConfigDeliveryResult => {
    if (state === ConfigDeliveryState.Rejected) mode = OpenClawConfigDeliveryMode.Rejected;
    diagnose({ stage: ConfigDiagnosticStage.Complete, attempt, elapsedMs: now() - started,
      outcome: state === ConfigDeliveryState.Applied ? ConfigDiagnosticOutcome.Succeeded
        : state === ConfigDeliveryState.RestartRequired ? ConfigDiagnosticOutcome.RestartRequired
          : state === ConfigDeliveryState.Pending ? ConfigDiagnosticOutcome.Pending : ConfigDiagnosticOutcome.Failed,
      receiptState: state, restartPaths,
      evidence: state === ConfigDeliveryState.Rejected ? ConfigRecoveryEvidence.Rejected
        : state === ConfigDeliveryState.Applied ? ConfigRecoveryEvidence.Accepted
          : state === ConfigDeliveryState.RestartRequired ? ConfigRecoveryEvidence.RestartRequired
            : ConfigRecoveryEvidence.Unconfirmed, actualAction: ConfigRecoveryAction.None });
    return { mode, state, detail, mutationId, desiredRevision, persistedRevision, appliedRevision, restartPaths,
      restartScheduled: false, elapsedMs: now() - started };
  };
  if (input.gatewayPhase !== OpenClawEnginePhase.Running) {
    return finish(ConfigDeliveryState.Pending, 'configuration will be checked when the gateway is ready');
  }
  let raw: string;
  try {
    raw = stripPluginIndexManagedKeysFromRawConfig(input.candidateRaw ?? input.readConfigFile());
    if (!raw.trim()) return finish(ConfigDeliveryState.Rejected, 'configuration is empty');
    JSON.parse(raw);
  } catch {
    return finish(ConfigDeliveryState.Rejected, 'configuration could not be read or parsed');
  }
  payloadDigest = configDiagnosticDigest(raw);
  diagnose({ stage: ConfigDiagnosticStage.Read, outcome: ConfigDiagnosticOutcome.Succeeded,
    attempt, elapsedMs: 0, payloadDigest, payloadBytes: Buffer.byteLength(raw) });
  let client: OpenClawConfigRpcClient | null;
  try { client = await input.ensureRpcClient(); }
  catch { return finish(ConfigDeliveryState.Pending, 'gateway connection unavailable'); }
  if (!client) return finish(ConfigDeliveryState.Pending, 'gateway connection unavailable');
  const rpc = async (method: string, params: unknown, maximumMs: number): Promise<ConfigReadback> => {
    if (input.signal?.aborted) throw new Error('configuration delivery cancelled');
    const at = now();
    const timeoutMs = timeoutFor(maximumMs);
    const stage = method as ConfigDiagnosticStage;
    diagnose({ stage, attempt, outcome: ConfigDiagnosticOutcome.Started, elapsedMs: 0,
      timeoutMs, payloadDigest });
    try {
      const result = await client!.request<ConfigReadback>(method, params, { timeoutMs });
      if (input.signal?.aborted) throw new Error('configuration delivery cancelled');
      diagnose({ stage, attempt, outcome: ConfigDiagnosticOutcome.Succeeded, elapsedMs: now() - at,
        timeoutMs, rawRevision: result.hash ? configDiagnosticDigest(result.hash) : undefined,
        resolvedRevision: result.configRevisionHash ? configDiagnosticDigest(result.configRevisionHash) : undefined,
        appliedRevision: result.appliedConfigHash ? configDiagnosticDigest(result.appliedConfigHash) : undefined });
      return result;
    } catch (error) {
      diagnose({ stage, attempt, outcome: ConfigDiagnosticOutcome.Failed, elapsedMs: now() - at,
        timeoutMs, errorKind: classifyDiagnosticError(error) });
      throw error;
    }
  };
  const acceptReceipt = (snapshot: ConfigReadback): OpenClawConfigDeliveryResult | null => {
    const receipt = snapshot.mutation;
    if (receipt?.mutationId !== mutationId) return null;
    desiredRevision = receipt.desiredRevision ?? desiredRevision;
    persistedRevision = receipt.persistedRevision ?? persistedRevision;
    appliedRevision = receipt.appliedRevision ?? appliedRevision;
    if (receipt.state === ConfigDeliveryState.RestartRequired) {
      restartPaths = sanitizeConfigRestartPaths(receipt.restartPaths ?? snapshot.restartPaths);
      return finish(ConfigDeliveryState.RestartRequired, 'runtime requires an idle gateway replacement');
    }
    if (receipt.state === ConfigDeliveryState.Rejected) return finish(ConfigDeliveryState.Rejected, 'runtime rejected the configuration');
    if (receipt.state === ConfigDeliveryState.Applied && desiredRevision && appliedRevision === desiredRevision) {
      return finish(ConfigDeliveryState.Applied, 'runtime confirmed this mutation was applied');
    }
    return null;
  };
  const reconcile = async (): Promise<OpenClawConfigDeliveryResult> => {
    const readbackStarted = now();
    for (const offset of [1_000, 3_000, 10_000, 30_000]) {
      if (input.signal?.aborted) break;
      const wait = Math.max(0, readbackStarted + offset - now());
      if (input.deadlineAtMs !== undefined && now() + wait >= input.deadlineAtMs) break;
      await sleep(wait);
      if (input.signal?.aborted) break;
      try {
        const result = await rpc(OpenClawConfigRpcMethod.Get, { mutationId }, 3_000);
        const completed = acceptReceipt(result);
        if (completed) return completed;
      } catch { /* Bounded read-only reconciliation; no restart or resubmission. */ }
    }
    return finish(ConfigDeliveryState.Pending, 'configuration application is still unconfirmed');
  };
  if (existing?.reconcileOnly) return reconcile();
  let snapshot: ConfigReadback;
  let expectedRawHash: string | undefined;
  let persistedMatchesCandidate = false;
  if (existing?.priorApplied) {
    try {
      const persistedRaw = input.readConfigFile();
      expectedRawHash = createHash('sha256').update(persistedRaw).digest('hex');
      persistedMatchesCandidate = candidateIdentity(persistedRaw) === candidateIdentity(raw);
    } catch { /* Without persisted identity evidence, a cached success cannot be reused. */ }
  }
  try { snapshot = await rpc(OpenClawConfigRpcMethod.Get, expectedRawHash ? { expectedRawHash } : {}, CONFIG_GET_TIMEOUT_MS); }
  catch { return finish(ConfigDeliveryState.Pending, 'could not read gateway configuration'); }
  if (existing?.priorApplied && persistedMatchesCandidate && snapshot.persistedCandidateMatches === true
    && snapshot.hash === existing.priorApplied.persistedRevision && snapshot.configRevisionHash
    && snapshot.configRevisionHash === snapshot.appliedConfigHash) {
    return { ...existing.priorApplied, elapsedMs: now() - started };
  }
  const supportsReceipts = snapshot.capabilities?.configMutationReceipts === 1;
  // Old runtime cannot safely gate a restart before its watcher sees the write.
  // Wait for the paired runtime instead of racing an ungoverned config update.
  if (!supportsReceipts) return finish(ConfigDeliveryState.Pending, 'gateway configuration receipts are unavailable; paired runtime required');
  const incremental = input.preferIncremental !== false && input.changedTopLevelKeys?.length === 1
    && input.changedTopLevelKeys[0] === 'agents';
  const method = incremental ? OpenClawConfigRpcMethod.Patch : OpenClawConfigRpcMethod.Set;
  mode = incremental ? OpenClawConfigDeliveryMode.RpcPatch : OpenClawConfigDeliveryMode.RpcSet;
  for (attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const payload = incremental ? JSON.stringify({ agents: JSON.parse(raw).agents }) : raw;
      if (input.signal?.aborted) break;
      existing?.onSubmitted(mutationId);
      const ack = await rpc(method, { raw: payload, baseHash: snapshot.hash, mutationId, allowRestart: false }, CONFIG_SET_TIMEOUT_MS);
      const completed = acceptReceipt(ack);
      if (completed) return completed;
      break;
    } catch (error) {
      if (isBaseHashConflict(error)) {
        if (attempt === 1 && input.rebuildCandidate) {
          try {
            snapshot = await rpc(OpenClawConfigRpcMethod.Get, {}, CONFIG_GET_TIMEOUT_MS);
            raw = stripPluginIndexManagedKeysFromRawConfig(input.rebuildCandidate());
            JSON.parse(raw);
            mutationId = randomUUID();
            continue;
          } catch { /* Keep the candidate pending until the next reconciliation. */ }
        }
        return finish(ConfigDeliveryState.Pending, 'configuration changed concurrently; regenerate the candidate before retrying');
      }
      if (isConfigValidationRejection(error)) return finish(ConfigDeliveryState.Rejected, 'runtime rejected the configuration');
      // A timeout is an unknown write outcome. Never issue another mutation.
      break;
    }
  }
  return reconcile();
}

export const DEFERRED_SYNC_REASON_PREFIX = 'deferred:';
export function isConfigDeliveryFallbackReason(reason: string): boolean {
  const original = reason.startsWith(DEFERRED_SYNC_REASON_PREFIX)
    ? reason.slice(DEFERRED_SYNC_REASON_PREFIX.length) : reason;
  return original.startsWith(CONFIG_DELIVERY_FALLBACK_REASON_PREFIX);
}
export function mergeDeferredGatewayRestartReason(current: string | null, incoming: string): string {
  return !current || (isConfigDeliveryFallbackReason(current) && !isConfigDeliveryFallbackReason(incoming))
    ? incoming : current;
}
