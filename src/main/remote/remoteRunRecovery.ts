import { type RemoteOwner, RemoteRunStatus } from '../../shared/remote/constants';
import type { CoworkStore } from '../coworkStore';
import type { CoworkRuntime } from '../libs/agentEngine/types';
import { payloadHash, sameOwner } from './canonical';
import type { RemoteRun } from './remoteStore';
import { remoteLogMessage } from './remoteSyncLog';

const terminal = new Set<string>([RemoteRunStatus.Succeeded, RemoteRunStatus.Failed, RemoteRunStatus.Cancelled, RemoteRunStatus.Interrupted]);
const sameActor = (a: RemoteOwner | null, b: RemoteOwner | null): boolean => a === null ? b === null : sameOwner(a, b);
const stopKey = (id: string): string => `pendingRunStop:${id}`;
interface StopIntent { runId: string; owner: RemoteOwner | null; targetId: string | null }
interface Options {
  owner(): RemoteOwner | null;
  generation(): unknown;
  targetId(): string | null;
  canRecover(): boolean;
  reconcile(id: string): Promise<boolean>;
  changed?(id: string): void;
}

/** Retry only observation and explicit stop intents, never the original prompt. */
export class RemoteRunRecovery {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private work: Promise<void> | null = null;
  private requested = false;
  private readonly stops = new Map<string, { runId: string; work: Promise<boolean> }>();

  constructor(private readonly store: CoworkStore, private readonly runtime: CoworkRuntime, private readonly options: Options) {}

  rememberStop(id: string): boolean {
    this.store.remote.assertActor(id, this.options.owner());
    const run = this.store.remote.run(id);
    if (!run || terminal.has(run.status)) return false;
    this.store.remote.put(stopKey(id), { runId: run.runId, owner: this.options.owner(), targetId: this.options.targetId() } satisfies StopIntent);
    return true;
  }

  requestStop(id: string, timeoutMs?: number): Promise<boolean> {
    if (!this.rememberStop(id)) return Promise.resolve(true);
    return this.confirmStop(id, timeoutMs).finally(() => this.gatewayReady());
  }

  private intent(id: string): StopIntent | null {
    const intent = this.store.remote.get<StopIntent>(stopKey(id));
    const run = this.store.remote.run(id);
    if (!intent || !run || intent.runId !== run.runId || terminal.has(run.status)) return null;
    // Persisted state can predate this version or be incomplete; never abort a run on invalid evidence.
    if (intent.owner !== null && (!intent.owner || typeof intent.owner.userId !== 'string'
      || typeof intent.owner.scopeKey !== 'string')) return null;
    if (intent.targetId !== null && typeof intent.targetId !== 'string') return null;
    return sameActor(intent.owner, this.options.owner()) && intent.targetId === this.options.targetId() ? intent : null;
  }

  private confirmStop(id: string, timeoutMs?: number): Promise<boolean> {
    const intent = this.intent(id);
    if (!intent) return Promise.resolve(false);
    const pending = this.stops.get(id);
    if (pending) return pending.runId === intent.runId ? pending.work : Promise.resolve(false);
    const generation = this.options.generation();
    const deadline = Date.now() + (timeoutMs ?? 17000);
    const binding = payloadHash(this.store.remote.get(`gatewayRun:${id}`));
    const guard = this.store.remote.deletionGuard(id).version;
    const current = (): boolean => Date.now() <= deadline && generation === this.options.generation()
      && sameActor(intent.owner, this.options.owner()) && intent.targetId === this.options.targetId()
      && this.store.remote.run(id)?.runId === intent.runId
      && payloadHash(this.store.remote.get(stopKey(id))) === payloadHash(intent)
      && binding === payloadHash(this.store.remote.get(`gatewayRun:${id}`))
      && guard === this.store.remote.deletionGuard(id).version;
    remoteLogMessage('info', '[RemoteRunRecovery] Stop confirmation started', { sessionId: id, runId: intent.runId, timeoutMs: timeoutMs ?? 17000 });
    const operation = (async () => {
      try {
        this.store.remote.assertActor(id, this.options.owner());
        const confirmed = await this.runtime.cancelSessionConfirmed?.(id, timeoutMs);
        // A terminal event can win while the RPC is in flight. Never overwrite it.
        const accepted = current();
        if (accepted) {
          this.store.remote.updateRun(id, confirmed ? RemoteRunStatus.Cancelled : RemoteRunStatus.Reconciling);
          if (confirmed) {
            this.store.remote.remove(stopKey(id));
            this.options.changed?.(id);
          }
        }
        remoteLogMessage('info', '[RemoteRunRecovery] Stop confirmation finished', {
          sessionId: id, runId: intent.runId, confirmed: confirmed === true, accepted,
        });
        return confirmed === true && accepted;
      } catch {
        remoteLogMessage('warn', '[RemoteRunRecovery] Stop confirmation deferred', { sessionId: id, runId: intent.runId });
        try { if (current()) this.store.remote.updateRun(id, RemoteRunStatus.Reconciling); } catch { /* Preserve durable stop intent. */ }
        return false;
      }
    })().finally(() => { if (this.stops.get(id)?.work === operation) this.stops.delete(id); });
    this.stops.set(id, { runId: intent.runId, work: operation });
    return operation;
  }

  /** Called after ordinary handshake AND account recovery activation. */
  gatewayReady(): void {
    if (this.stopped) return;
    this.requested = true;
    if (this.work) return;
    if (this.timer) clearTimeout(this.timer);
    this.schedule(0, 0);
  }

  private schedule(delay: number, attempt: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.options.canRecover()) return;
      this.requested = false;
      this.work = this.recover().catch(error => {
        console.warn('[RemoteRunRecovery] Recovery deferred:', error);
        return true;
      }).then(pending => {
        this.work = null;
        if (this.stopped) return;
        if (this.requested) this.schedule(1000, attempt);
        else if (pending && attempt < 3) this.schedule([1000, 3000, 10000][attempt], attempt + 1);
      });
    }, delay);
    this.timer.unref?.();
  }

  private async recover(): Promise<boolean> {
    await this.store.remote.waitRunRecovery();
    const generation = this.options.generation();
    let after: string | undefined, pending = false;
    do {
      if (this.stopped || !this.options.canRecover() || generation !== this.options.generation()) break;
      const page = this.store.remote.scanEntries<RemoteRun>('run:', { after, limit: 32 });
      after = page.nextCursor || undefined;
      for (const row of page.rows) {
        if (row.state !== 'valid') continue;
        const { key, value: run } = row;
        if (this.stopped || !this.options.canRecover() || generation !== this.options.generation()) return pending;
        const id = key.slice('run:'.length);
        if (!sameActor(this.store.remote.owner(id), this.options.owner())) continue;
        if (terminal.has(run.status)) {
          if (this.store.remote.get<StopIntent>(stopKey(id))?.runId === run.runId) this.store.remote.remove(stopKey(id));
          continue;
        }
        const intent = this.intent(id);
        if (run.status !== RemoteRunStatus.Reconciling && !intent) continue;
        try {
          remoteLogMessage('debug', '[RemoteRunRecovery] Recovering run after Gateway readiness', {
            sessionId: id, runId: run.runId, stopRequested: !!intent,
          });
          await this.options.reconcile(id);
          if (this.stopped || !this.options.canRecover() || generation !== this.options.generation()) return pending;
          if (this.intent(id)) await this.confirmStop(id, 5000);
          pending ||= this.store.remote.run(id)?.status === RemoteRunStatus.Reconciling || !!this.intent(id);
        } catch { pending = true; }
      }
      // Large terminal histories must not monopolize the Electron main thread.
      if (after) await new Promise<void>(resolve => setImmediate(resolve));
    } while (after);
    return pending;
  }

  dispose(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Original stopSession cleanup has already run; the live client now verifies its outcome. */
  async finishShutdown(ids: string[], timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(ids.map(id => this.confirmStop(id, Math.max(1, deadline - Date.now())))),
        new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }
}
