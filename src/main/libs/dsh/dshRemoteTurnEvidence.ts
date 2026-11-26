import { setTimeout as delay } from 'node:timers/promises';

import { DshOpsAction } from '../../../shared/dshEngine/hostConstants';
import type { RemoteStore } from '../../remote/remoteStore';
import type { CoworkSessionRecoverySnapshot } from '../agentEngine/types';
import type { DshTypertClient } from './dshTypertClient';

/** Discriminator on persisted gatewayRun records. Older OpenClaw records have a boot UUID. */
export const DSH_REMOTE_BINDING_VERSION = 'dsh-v1';

export const DshRemoteTurnStatus = {
  Unknown: 'unknown', Queued: 'queued', Running: 'running',
  Succeeded: 'succeeded', Failed: 'failed', Cancelled: 'cancelled',
} as const;
type DshRemoteTurnStatus = typeof DshRemoteTurnStatus[keyof typeof DshRemoteTurnStatus];
type Evidence = { status: DshRemoteTurnStatus; hasActiveRun?: boolean; records?: Record<string, unknown>[]; hasMore?: boolean };
interface Binding {
  gatewayBootId: string;
  sessionKey: string;
  runId: string;
  remoteRunId: string;
}

export class DshRemoteTurnEvidence {
  private readonly observers = new Map<string, { requestId: string; abort: AbortController }>();

  stopObservation(sessionId: string): void {
    this.observers.get(sessionId)?.abort.abort();
    this.observers.delete(sessionId);
  }

  observe(sessionId: string, runId: string, snapshot: CoworkSessionRecoverySnapshot,
    onTerminal: (status: 'succeeded' | 'failed' | 'cancelled') => void, onLost: () => void, beforeApply?: () => void): boolean {
    const client = this.getClient();
    const binding = this.binding(sessionId, snapshot.runId);
    if (!client || !binding || snapshot.status !== DshRemoteTurnStatus.Running || binding.remoteRunId !== runId
      || binding.sessionKey !== snapshot.sessionKey || snapshot.gatewayBootId !== DSH_REMOTE_BINDING_VERSION) return false;
    if (this.observers.get(sessionId)?.requestId === binding.runId) return true;
    this.stopObservation(sessionId);
    const abort = new AbortController();
    this.observers.set(sessionId, { requestId: binding.runId, abort });
    // Observation cannot start an agent, enqueue input, or resend a pending decision.
    void (async () => {
      let settled = false;
      try {
        const stream = client.followSession({ address: { kind: 'session', sessionId: binding.sessionKey },
          assistantStream: false, activate: false }, abort.signal);
        for await (const frame of stream) {
          if (abort.signal.aborted || this.binding(sessionId, binding.runId)?.remoteRunId !== runId) return;
          const type = (frame.event as { type?: string } | undefined)?.type;
          if (frame.type !== 'snapshot' && type !== 'turn/end' && type !== 'agent/inbox/spliced') continue;
          const evidence = await this.query(sessionId, binding.runId, beforeApply);
          beforeApply?.();
          if (!abort.signal.aborted && evidence?.hasActiveRun === false && (evidence.status === DshRemoteTurnStatus.Cancelled
            || evidence.status === DshRemoteTurnStatus.Failed || evidence.status === DshRemoteTurnStatus.Succeeded)) {
            onTerminal(evidence.status);
            settled = true;
            return;
          }
        }
      } catch { /* A later recovery probe can acquire a fresh read-only stream. */ }
      finally {
        if (this.observers.get(sessionId)?.abort === abort) {
          this.stopObservation(sessionId);
          if (!settled) onLost();
        }
      }
    })();
    return true;
  }

  constructor(
    private readonly getStore: () => RemoteStore | undefined,
    private readonly getClient: () => DshTypertClient | null,
    private readonly applyPage?: (id: string, nativeId: string, requestId: string, events: Record<string, unknown>[]) => void,
  ) {}

  binding(sessionId: string, requestId?: string): Binding | null {
    const store = this.getStore();
    if (!store) return null;
    const binding = store.get<Binding>(`gatewayRun:${sessionId}`);
    if (binding?.gatewayBootId !== DSH_REMOTE_BINDING_VERSION || !binding.sessionKey || !binding.runId
      || binding.remoteRunId !== store.run(sessionId)?.runId || (requestId && requestId !== binding.runId)) return null;
    return binding;
  }

  async query(sessionId: string, requestId?: string, beforeApply?: () => void): Promise<CoworkSessionRecoverySnapshot | null> {
    const binding = this.binding(sessionId, requestId);
    const client = this.getClient();
    if (!binding || !client) return null;
    const store = this.getStore();
    const cursorKey = `dshReplayCursor:${sessionId}:${binding.runId}`;
    let evidence: Evidence;
    for (;;) {
      const afterSeq = beforeApply && store ? store.get<number>(cursorKey) ?? -1 : undefined;
      evidence = await client.callOps<Evidence>(DshOpsAction.InspectRemoteTurn, {
        sessionId: binding.sessionKey, requestId: binding.runId, afterSeq,
      }, AbortSignal.timeout(4_000));
      if (this.binding(sessionId, binding.runId)?.sessionKey !== binding.sessionKey) return null;
      beforeApply?.();
      if (afterSeq === undefined || !this.applyPage || !store || !evidence.records?.length) break;
      const events = evidence.records;
      const lastSeq = events.at(-1)?.seq;
      if (typeof lastSeq !== 'number' || lastSeq <= afterSeq) throw new Error('Invalid DSH transcript page');
      store.transaction(() => {
        beforeApply?.();
        this.applyPage!(sessionId, binding.sessionKey, binding.runId, events);
        store.put(cursorKey, lastSeq);
      });
      if (!evidence.hasMore) break;
    }
    const status = evidence.status === DshRemoteTurnStatus.Queued ? DshRemoteTurnStatus.Running : evidence.status;
    return {
      sessionKey: binding.sessionKey, gatewayBootId: DSH_REMOTE_BINDING_VERSION, runId: binding.runId,
      status, ...(typeof evidence.hasActiveRun === 'boolean' ? { hasActiveRun: evidence.hasActiveRun } : {}),
    };
  }

  async ownsInteraction(sessionId: string, requestId: string, nativeId: string, toolName: string, callId?: string | null): Promise<boolean> {
    const binding = this.binding(sessionId, requestId);
    const client = this.getClient();
    if (!binding || !client) return false;
    const proof = await client.callOps(DshOpsAction.InspectRemoteTurn, { sessionId: binding.sessionKey, requestId,
      interaction: { toolName, callId, ...(binding.sessionKey !== nativeId ? { childId: nativeId } : {}) } }, AbortSignal.timeout(3_000));
    return proof.interactionOwned === true && this.binding(sessionId, requestId)?.sessionKey === binding.sessionKey;
  }

  async cancel(sessionId: string, timeoutMs = 17_000): Promise<boolean> {
    const binding = this.binding(sessionId);
    const client = this.getClient();
    if (!binding || !client) return false;
    const signal = AbortSignal.timeout(Math.max(1, timeoutMs));
    const params = { sessionId: binding.sessionKey, requestId: binding.runId };
    // Inspect first, so a late recovery request never cancels a different input.
    const initial = await client.callOps<Evidence>(DshOpsAction.InspectRemoteTurn, params, signal);
    if (this.binding(sessionId, binding.runId)?.sessionKey !== binding.sessionKey) return false;
    if (initial.status === DshRemoteTurnStatus.Cancelled) return true;
    if (initial.status !== DshRemoteTurnStatus.Queued && initial.status !== DshRemoteTurnStatus.Running) return false;
    let evidence = await client.callOps<Evidence>(DshOpsAction.CancelRemoteTurn, params, signal);
    while (evidence.status === DshRemoteTurnStatus.Queued || evidence.status === DshRemoteTurnStatus.Running) {
      if (this.binding(sessionId, binding.runId)?.sessionKey !== binding.sessionKey) return false;
      await delay(200, undefined, { signal });
      evidence = await client.callOps<Evidence>(DshOpsAction.InspectRemoteTurn, params, signal);
    }
    return evidence.status === DshRemoteTurnStatus.Cancelled;
  }
}
