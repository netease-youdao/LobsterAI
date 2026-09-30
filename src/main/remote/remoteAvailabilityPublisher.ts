import { randomUUID } from 'crypto';

import type { RemoteOwner } from '../../shared/remote/constants';
import { payloadHash, stableJson } from './canonical';
import { availabilityControlSnapshot,type ControlSnapshot } from './remoteAvailabilitySource';
import { AvailabilityReadState, type AvailabilityRequest, type AvailabilitySession, RemoteAvailabilityStore } from './remoteAvailabilityStore';
import type { HistoryContext, HistoryOperation } from './remoteHistoryStore';
import { RemoteLiveProjectionJob } from './remoteLiveProjectionJob';
import { recoveryEvents, recoveryRequired, recoverySourceManifest } from './remoteRecoveryProof';
import type { CoreRemoteBinding, RemoteStore } from './remoteStore';
import { remoteDiagnosticLog, remoteSyncErrorMetadata } from './remoteSyncLog';
import { observeSyncCommit, SyncTelemetry } from './remoteSyncTelemetry';
import { captureRemoteTelemetry } from './remoteTelemetry';

export interface AvailabilityContext { environment?: string; scope: string; owner: RemoteOwner; deviceId: string; generation: string; supported: boolean; historySupported?: boolean }
interface Dependencies {
  store: RemoteStore;
  context(): AvailabilityContext | null;
  admitted(localId: string): boolean;
  request(path: string, method: string, body: unknown, version: number, timeoutMs?: number): Promise<any>;
}
const recordKey = (record: { eventType: string; payload: Record<string, any> }): string => `${record.eventType}:${record.payload.run?.runId
  || record.payload.messageId || record.payload.approval?.approvalId || record.payload.question?.questionId || record.payload.session?.sessionId || ''}`;
const backoff = [1000, 3000, 10000, 30000, 60000];

/** Independent control and current-content lanes. Legacy history errors never own either lane's retry clock. */
export class RemoteAvailabilityPublisher {
  readonly ledger: RemoteAvailabilityStore;
  private readonly encoder = new RemoteLiveProjectionJob();
  private controlWork: Promise<void> | null = null;
  private liveWork: Promise<void> | null = null;
  private historyWork: Promise<void> | null = null;
  private checkpointDeadline = 0;
  private controlDeadline = 0;
  private readonly pendingCursors = new Map<string, string>();
  private checkpointRevision: { localId: string; revision: string } | null = null;
  private readonly historyRetry = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly failures = new Map<string, { count: number; retryAt: number }>();
  private readonly liveScan = new Map<string, number>();
  private readonly scanOffsets = new Map<string, number>();
  private readonly contentRepresentations = new Map<string, string>();
  constructor(private readonly deps: Dependencies) { this.ledger = new RemoteAvailabilityStore(deps.store.db.name); }
  start(): void { this.stopped = false; this.wake(); }
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = null; this.encoder.cancel(); this.contentRepresentations.clear(); }
  dispose(): void { this.stop(); this.ledger.close(); }
  ownsHistory(localId: string): boolean {
    const context = this.deps.context();
    return !!context && this.ledger.hasSession(context.scope, localId);
  }
  controlReady(localId: string): boolean {
    const context = this.deps.context();
    try { return !!context && this.ledger.session(context.scope, localId)?.phase === 'active'; }
    catch { return false; /* Unknown control evidence never permits execution or a legacy writer. */ }
  }
  health(): { sessions: number; pendingSessions: number; degraded: boolean } | null {
    const context = this.deps.context();
    return context ? this.ledger.health(context.scope) : null;
  }
  sessionHealth(localId: string): { ready: boolean; pending: boolean; degraded: boolean } | null {
    const context = this.deps.context();
    if (!context || !this.ledger.hasSession(context.scope, localId)) return null;
    try {
      const state = this.ledger.session(context.scope, localId)!;
      const revision = this.deps.store.db.prepare('SELECT revision FROM remote_control_revisions WHERE session_id=?').get(localId) as { revision: number } | undefined;
      const pending = !!this.ledger.db.prepare('SELECT 1 FROM availability_requests WHERE scope=? AND local_id=? LIMIT 1').get(context.scope, localId);
      const degraded = !!this.ledger.db.prepare('SELECT 1 FROM availability_faults WHERE scope=? AND local_id=? LIMIT 1').get(context.scope, localId);
      return { ready: state.phase === 'active', pending: pending || state.controlRevision !== String(revision?.revision || 1), degraded };
    } catch { return { ready: false, pending: true, degraded: true }; }
  }
  wake(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.tick(); }, 200); this.timer.unref?.();
  }
  private current(context: AvailabilityContext): boolean {
    const next = this.deps.context();
    return !this.stopped && next?.scope === context.scope && next.deviceId === context.deviceId && next.generation === context.generation;
  }
  private tick(): void {
    let context: AvailabilityContext | null;
    try { context = this.deps.context(); } catch (error) { this.fail('context', error); this.wake(); return; }
    if (this.stopped || !context || !context.generation) return;
    if (!this.controlWork) {
      const work = this.controls(context).catch(error => this.fail(`${context.scope}:control`, error)).finally(() => {
        if (this.controlWork === work) this.controlWork = null;
      });
      this.controlWork = work;
    }
    if (!this.liveWork) {
      const work = this.live(context).catch(error => this.fail(`${context.scope}:live`, error)).finally(() => {
        if (this.liveWork === work) this.liveWork = null;
      });
      this.liveWork = work;
    }
    if (!this.historyWork) {
      const work = this.history(context).catch(error => this.fail(`${context.scope}:history`, error)).finally(() => {
        if (this.historyWork === work) this.historyWork = null;
      }); this.historyWork = work;
    }
    // Local scheduling only. Idle sessions generate no periodic HTTP traffic.
    this.timer = setTimeout(() => { this.timer = null; this.tick(); }, 1000); this.timer.unref?.();
  }
  private eligible(key: string): boolean { return (this.failures.get(key)?.retryAt || 0) <= Date.now(); }
  private fail(key: string, error: unknown): void {
    const previous = this.failures.get(key), count = (previous?.count || 0) + 1;
    const retryAfter = Number((error as { retryAfterMs?: number })?.retryAfterMs);
    const delay = Math.max(backoff[Math.min(count - 1, backoff.length - 1)], Number.isFinite(retryAfter) ? retryAfter : 0);
    if (this.failures.size >= 1024 && !this.failures.has(key)) this.failures.delete(this.failures.keys().next().value!);
    this.failures.set(key, { count, retryAt: Date.now() + delay });
    captureRemoteTelemetry().emit(SyncTelemetry.Event.Deferred, { stage: SyncTelemetry.Stage.Reconcile,
      outcome: SyncTelemetry.Outcome.Deferred, retryAfterMs: delay, failureCount: count,
      reason: error instanceof Error && /RECEIPT_INVALID$/u.test(error.message) ? SyncTelemetry.Reason.InvalidReceipt
        : error instanceof Error && /BUDGET$/u.test(error.message) ? SyncTelemetry.Reason.Budget : SyncTelemetry.Reason.RequestFailed });
    if (!previous || count === 3) remoteDiagnosticLog('remote.sync.task_deferred', { operationId: /^[A-Za-z0-9_-]{1,64}$/u.test(key) ? key : undefined, error, retryAfterMs: delay, reason: 'REQUEST_FAILED' }, 'warn');
  }
  private body(context: AvailabilityContext, state: AvailabilitySession): Record<string, any> {
    return { owner: context.owner, deviceId: context.deviceId, sessionId: state.sessionId, localSessionId: state.localId,
      mode: 'online', writerGeneration: state.writerGeneration };
  }
  private save(context: AvailabilityContext, state: AvailabilitySession, key: string, lane: 'control' | 'live', path: string,
    body: Record<string, any>, version: number, lookup: string | null, lookupVersion = version, method = 'POST'): AvailabilityRequest {
    return this.ledger.saveRequest({ key, lane, scope: context.scope, localId: state.localId, method, pathname: path, version,
      body: { ...this.body(context, state), ...body }, lookup, lookupVersion, attempted: false, createdAt: Date.now() });
  }
  private async send(context: AvailabilityContext, request: AvailabilityRequest): Promise<any> {
    const telemetry = captureRemoteTelemetry({ remoteOwnerId: context.owner.userId, ownerScopeId: context.owner.scopeKey,
      deviceId: context.deviceId, localSessionId: request.localId, sessionId: request.body.sessionId, lane: request.lane,
      operationId: request.body.publicationId || request.body.batchId || request.body.operationId || request.key.split(':')[0],
      operationKind: request.lane === 'live' ? SyncTelemetry.Kind.Live : request.pathname === '/sync/mode-activations'
        ? SyncTelemetry.Kind.Activation : request.pathname === '/control/facts/batches' ? SyncTelemetry.Kind.Facts : SyncTelemetry.Kind.Bootstrap });
    if (!this.current(context)) throw new Error('REMOTE_AVAILABILITY_CONTEXT_CHANGED');
    if (request.lane === 'control') this.checkpointGuard();
    if (request.attempted && request.lookup) {
      try {
        const result = await this.deps.request(request.lookup, 'GET', undefined, request.lookupVersion, request.lane === 'control' ? this.checkpointTimeout() : undefined);
        if (request.lane === 'control') this.checkpointGuard();
        if (!this.current(context)) throw new Error('REMOTE_AVAILABILITY_CONTEXT_CHANGED');
        if (result) {
          telemetry.emit(SyncTelemetry.Event.Reconciled, { stage: SyncTelemetry.Stage.Reconcile, outcome: SyncTelemetry.Outcome.Pending,
            reconcileTrigger: 'receipt_missing', receiptState: result.state, persistOutcome: 'pending' });
          return result;
        }
      } catch (error) {
        // Not found is not proof of failure: replay the same immutable operation, never allocate another ID.
        const failure = error as { httpStatus?: number; code?: number };
        if (failure.httpStatus !== 404 && failure.code !== 404) {
          telemetry.emit(SyncTelemetry.Event.Unknown, { stage: SyncTelemetry.Stage.Reconcile, phase: SyncTelemetry.Stage.Reconcile,
            publicationKind: request.lane === 'live' ? SyncTelemetry.Kind.Live : request.pathname === '/control/facts/batches'
              ? SyncTelemetry.Kind.Facts : SyncTelemetry.Kind.Bootstrap, businessStatus: 'unknown',
            outcome: SyncTelemetry.Outcome.Unknown, reason: SyncTelemetry.Reason.RequestFailed });
          throw error;
        }
        telemetry.emit(SyncTelemetry.Event.Reconciled, { stage: SyncTelemetry.Stage.Replay, outcome: SyncTelemetry.Outcome.Pending,
          reconcileTrigger: 'receipt_missing', reason: SyncTelemetry.Reason.Pending });
      }
    }
    this.ledger.attempted(request);
    const { coreRevision: _coreRevision, ackCoreRevision: _ackCoreRevision, knownCheckpointId: _knownCheckpointId, ...body } = request.body;
    const result = await this.deps.request(request.pathname, request.method,
      { ...body, connectionGeneration: context.generation }, request.version, request.lane === 'control' ? this.checkpointTimeout() : undefined);
    if (request.lane === 'control') this.checkpointGuard();
    if (!this.current(context)) throw new Error('REMOTE_AVAILABILITY_CONTEXT_CHANGED');
    return result;
  }
  private candidates(context: AvailabilityContext, lane: string): CoreRemoteBinding[] {
    const key = `${context.scope}:${lane}`,offset = this.scanOffsets.get(key) || 0;
    const rows = this.deps.store.controlBindings(context.owner,32,offset);
    this.scanOffsets.set(key,rows.length < 32 ? 0 : offset + rows.length);
    const turnKey = `${key}:turn`, turn = this.scanOffsets.get(turnKey) || 0; this.scanOffsets.set(turnKey,turn+1);
    const ordered = rows.length ? [...rows.slice(turn % rows.length),...rows.slice(0,turn % rows.length)] : rows;
    const recent = lane === 'history' ? [] : this.deps.store.controlBindings(context.owner,8,0,'recent');
    const priority = lane !== 'history' ? recent.slice(turn % Math.max(1,recent.length), turn % Math.max(1,recent.length) + 1) : recent;
    return [...new Map([...priority,...ordered].map(row => [row.local_id,row])).values()].filter(row => {
      try { return !row.migration_frozen && !this.deps.store.isSyncClosed(row.local_id)
        && this.deps.admitted(row.local_id) && (!row.device_id || row.device_id === context.deviceId); }
      catch (error) { this.fail(`${context.scope}:${lane}:${row.local_id}`, error); return false; }
    });
  }
  private async controls(context: AvailabilityContext): Promise<void> {
    if (!this.eligible(`${context.scope}:control`)) return;
    const roundDeadline = Date.now() + 2000;
    for (const row of this.candidates(context, 'control')) {
      if (!this.current(context) || Date.now() >= roundDeadline) return;
      const key = `${context.scope}:control:${row.local_id}`;
      if (!this.eligible(key)) continue;
      try {
        this.controlDeadline = Math.min(roundDeadline, Date.now() + 1000);
        await this.controlSession(context, row);
        this.failures.delete(key);
      } catch (error) { if (this.current(context)) this.fail(key, error); }
      finally { this.controlDeadline = 0; }
    }
  }
  private async controlSession(context: AvailabilityContext, row: CoreRemoteBinding): Promise<void> {
    const telemetry = captureRemoteTelemetry({ remoteOwnerId: context.owner.userId, ownerScopeId: context.owner.scopeKey,
      deviceId: context.deviceId, localSessionId: row.local_id, sessionId: row.session_id, lane: 'control' });
    let state = this.ledger.session(context.scope, row.local_id);
    if (!state) {
      if (!context.supported) return;
      // Fence locally BEFORE the uncertain activation request. Never resume a legacy writer after this point.
      state = { scope: context.scope, localId: row.local_id, sessionId: row.session_id, writerGeneration: randomUUID(),
        controlEpoch: randomUUID(), phase: 'activating', operationId: randomUUID(), pendingCommandIds: [], pendingRunIds: [],
        controlRevision: '0', factSeq: '0', records: {} };
      this.ledger.saveSession(state);
    }
    if (state.phase === 'activating') {
      const request = this.save(context, state, `${state.operationId}:activation`, 'control', '/sync/mode-activations',
        { operationId: state.operationId }, 3, `/sync/mode-activations/${state.operationId}`);
      const result = await this.send(context, request);
      if (result.writerGeneration !== state.writerGeneration || !['fenced', 'active'].includes(result.state)) throw new Error('REMOTE_ACTIVATION_RECEIPT_INVALID');
      state.pendingCommandIds = result.pendingCommandIds || [];
      state.pendingApprovalIds = result.pendingApprovalIds || []; state.pendingQuestionIds = result.pendingQuestionIds || [];
      for (const field of ['streamEpoch','historyGeneration','historyResolvedSourceSeq'] as const) if (typeof result[field] === 'string') state[field] = result[field];
      state.pendingRunIds = [...new Set([...(result.pendingRunIds || []), ...(result.pendingCommands || []).filter((command: any) => command.runId && !(command.status === 'accepted' && command.claimId == null))
        .map((command: any) => command.runId)])] as string[];
      state.phase = 'bootstrap'; state.operationId = randomUUID();
      observeSyncCommit(telemetry, () => this.ledger.db.transaction(() => {
        this.ledger.saveSession(state!); this.ledger.complete(request.key);
      })(), { operationId: request.body.operationId, operationKind: SyncTelemetry.Kind.Activation });
      telemetry.emit(SyncTelemetry.Event.Acknowledged, { operationId: request.body.operationId,
        operationKind: SyncTelemetry.Kind.Activation, publicationKind: SyncTelemetry.Kind.Activation,
        stage: SyncTelemetry.Stage.Activation, phase: SyncTelemetry.Stage.LocalAck, outcome: SyncTelemetry.Outcome.Completed,
        businessStatus: result.state, writerGeneration: state.writerGeneration, persistOutcome: 'success' });
      this.deps.store.bindRemote(row.local_id, row.session_id, context.deviceId);
    }
    if (state.phase === 'bootstrap') {
      try { await this.bootstrap(context, state); }
      catch (error) {
        const terminalReceipt = (error as { bootstrapReceipt?: { state?: string } }).bootstrapReceipt;
        if (terminalReceipt && ['aborted','expired','superseded'].includes(terminalReceipt.state || '')) {
          this.ledger.db.transaction(() => {
            this.ledger.archiveBootstrap(context.scope,state!.localId,state!.operationId,terminalReceipt);
            state!.phase = 'activating'; state!.operationId = randomUUID(); this.ledger.saveSession(state!);
          })();
          return;
        }
        const data = (error as { data?: { reasonDetail?: string; pendingCommandIds?: string[] } }).data;
        if (data && ['COMMAND_LEDGER_CHANGED','CONTROL_LEDGER_CHANGED'].includes(data.reasonDetail || '')) {
          const originalId = state.operationId;
          const originalBegin = this.ledger.request(`${originalId}:begin`);
          if (!originalBegin) throw new Error('REMOTE_BOOTSTRAP_BEGIN_EVIDENCE_MISSING');
          const { mode: _mode, connectionGeneration: _generation, ...beginBusiness } = originalBegin.body;
          const abort = this.save(context, state, `${originalId}:abort`, 'control', `/control/bootstrap/${originalId}/abort`,
            { controlEpoch: state.controlEpoch, beginRequestHash: payloadHash(beginBusiness) }, 1, null);
          const result = await this.send(context, abort);
          if (result.state === 'committed') { await this.bootstrap(context, state); return; }
          if (!['aborted', 'expired', 'superseded'].includes(result.state)) throw new Error('REMOTE_BOOTSTRAP_ABORT_UNRESOLVED');
          this.ledger.db.transaction(() => {
            this.ledger.archiveBootstrap(context.scope, state!.localId, originalId, result);
            state!.phase = 'activating'; state!.operationId = randomUUID(); this.ledger.saveSession(state!);
          })();
        }
        throw error;
      }
      return;
    }
    await this.facts(context, state);
  }
  private async bootstrap(context: AvailabilityContext, state: AvailabilitySession, options?: { snapshot: ControlSnapshot; extra: Record<string, unknown> }): Promise<void> {
    const telemetry = captureRemoteTelemetry({ remoteOwnerId: context.owner.userId, ownerScopeId: context.owner.scopeKey,
      deviceId: context.deviceId, localSessionId: state.localId, sessionId: state.sessionId, operationId: state.operationId,
      operationKind: SyncTelemetry.Kind.Bootstrap, publicationKind: SyncTelemetry.Kind.Bootstrap, lane: 'control',
      writerGeneration: state.writerGeneration, controlEpoch: state.controlEpoch });
    const checkpointKey = `${state.operationId}:checkpoint`;
    let saved = this.ledger.request(checkpointKey);
    if (!saved) {
      const snapshot = options?.snapshot || availabilityControlSnapshot(this.deps.store, state.localId, state.pendingRunIds, false, { approvalIds: state.pendingApprovalIds, questionIds: state.pendingQuestionIds });
      const parts: Array<{ records: typeof snapshot.records; payloadHash: string }> = [];
      for (const record of snapshot.records) {
        let part = parts.at(-1);
        if (!part || Buffer.byteLength(stableJson([...part.records, record])) > 60 * 1024) {
          part = { records: [], payloadHash: '' }; parts.push(part);
        }
        part.records.push(record); part.payloadHash = payloadHash(part.records);
      }
      if (parts.length > 4) throw new Error('REMOTE_CONTROL_CHECKPOINT_BUDGET');
      const descriptors = parts.map((part, partNo) => ({ partNo, payloadHash: part.payloadHash, recordCount: part.records.length }));
      const kindCounts = Object.fromEntries([...new Set(snapshot.records.map(record => record.eventType))]
        .map(type => [type, snapshot.records.filter(record => record.eventType === type).length]));
      // This non-HTTP local request preserves the full baseline until commit is authoritatively reconciled.
      saved = this.save(context, state, checkpointKey, 'control', '', { revision: snapshot.revision,
        throughFactSeq: String(BigInt(snapshot.revision) > BigInt(state.factSeq) ? BigInt(snapshot.revision) : BigInt(state.factSeq)), extra: options?.extra || {}, parts,
        recordHashes: Object.fromEntries(snapshot.records.map(record => [recordKey(record), payloadHash(record)])),
        manifestHash: payloadHash(descriptors), kindCounts }, 1, null);
    }
    const checkpoint = saved.body;
    const begin = this.save(context, state, `${state.operationId}:begin`, 'control', '/control/bootstrap', {
      operationId: state.operationId, controlEpoch: state.controlEpoch, throughFactSeq: checkpoint.throughFactSeq, ...checkpoint.extra,
      coreCheckpointId: state.operationId, manifestHash: checkpoint.manifestHash,
      partCount: checkpoint.parts.length, kindCounts: checkpoint.kindCounts,
      pendingRunIds: state.pendingRunIds || [], pendingApprovalIds: state.pendingApprovalIds || [], pendingQuestionIds: state.pendingQuestionIds || [],
      pendingCommandIds: state.pendingCommandIds, pendingCommandIdsDigest: payloadHash([...state.pendingCommandIds].sort()),
    }, 1, `/control/operations/${state.operationId}`);
    const began = await this.send(context, begin);
    let receipt = began;
    if (began.state !== 'committed') {
      if (['aborted','expired','superseded'].includes(began.state)) throw Object.assign(new Error('REMOTE_BOOTSTRAP_TERMINAL'),{ httpStatus:409,bootstrapReceipt:began });
      for (let partNo = 0; partNo < checkpoint.parts.length; partNo++) {
        const part = this.save(context, state, `${state.operationId}:part:${partNo}`, 'control', `/control/bootstrap/${state.operationId}/parts/${partNo}`,
          { controlEpoch: state.controlEpoch, ...checkpoint.parts[partNo] }, 1, null, 1, 'PUT');
        await this.send(context, part); // Idempotent part replay is safe; preserve it until baseline commit.
      }
      const commit = this.save(context, state, `${state.operationId}:commit`, 'control', `/control/bootstrap/${state.operationId}/commit`,
        { controlEpoch: state.controlEpoch, manifestHash: checkpoint.manifestHash }, 1, `/control/operations/${state.operationId}`);
      // A nonterminal operation query cannot substitute for the commit itself.
      commit.lookup = null;
      const result = await this.send(context, commit);
      if (result.state !== 'committed' || result.controlReady !== true) throw new Error('REMOTE_BOOTSTRAP_RECEIPT_INVALID');
      receipt = result;
    }
    observeSyncCommit(telemetry, () => this.ledger.db.transaction(() => {
      this.ledger.db.prepare('INSERT OR IGNORE INTO availability_receipts VALUES(?,?)').run(state.operationId, stableJson(receipt));
      const currentState = this.ledger.session(context.scope,state.localId);
      if (!currentState || BigInt(currentState.factSeq) <= BigInt(checkpoint.throughFactSeq)) {
        state.phase = 'active'; state.factSeq = String(checkpoint.throughFactSeq); state.controlRevision = String(checkpoint.revision); state.records = checkpoint.recordHashes;
        this.ledger.saveSession(state);
      } else Object.assign(state,currentState);
      for (const request of this.ledger.pending(context.scope, 'control', state.localId))
        if (request.key.startsWith(`${state.operationId}:`)) this.ledger.complete(request.key);
    })());
    telemetry.emit(SyncTelemetry.Event.Acknowledged, { stage: SyncTelemetry.Stage.Bootstrap, phase: SyncTelemetry.Stage.LocalAck,
      outcome: SyncTelemetry.Outcome.Completed, businessStatus: receipt.state, lastFactSeq: state.factSeq,
      partCount: checkpoint.parts.length, persistOutcome: 'success' });
    for (const objectKey of Object.keys(checkpoint.recordHashes)) this.deps.store.db.prepare('DELETE FROM remote_control_pending WHERE session_id=? AND object_key=? AND revision<=?').run(state.localId, objectKey, checkpoint.revision);
    if (this.deps.store.db.prepare('SELECT 1 FROM remote_control_pending WHERE session_id=? LIMIT 1').get(state.localId)) {
      state.controlRevision = '0'; this.ledger.saveSession(state);
    }
  }
  private async facts(context: AvailabilityContext, state: AvailabilitySession): Promise<void> {
    const telemetry = captureRemoteTelemetry({ remoteOwnerId: context.owner.userId, ownerScopeId: context.owner.scopeKey,
      deviceId: context.deviceId, localSessionId: state.localId, sessionId: state.sessionId, lane: 'control',
      operationKind: SyncTelemetry.Kind.Facts, publicationKind: SyncTelemetry.Kind.Facts, writerGeneration: state.writerGeneration,
      controlEpoch: state.controlEpoch });
    let request = this.ledger.pending(context.scope, 'control', state.localId).find(value => value.pathname === '/control/facts/batches');
    if (!request) {
      const coreRevision = (this.deps.store.db.prepare('SELECT revision FROM remote_control_revisions WHERE session_id=?').get(state.localId) as { revision: number } | undefined)?.revision || 1;
      if (String(coreRevision) === state.controlRevision) return;
      const snapshot = availabilityControlSnapshot(this.deps.store, state.localId);
      const changed = snapshot.records.filter(record => state.records[recordKey(record)] !== payloadHash(record));
      const records: typeof changed = [];
      for (const record of changed) {
        if (records.length >= 16 || Buffer.byteLength(stableJson([...records, record])) > 60 * 1024) break;
        records.push(record);
      }
      if (!records.length) {
        if (changed.length) throw new Error('REMOTE_CONTROL_FACT_OBJECT_BUDGET');
        state.controlRevision = snapshot.revision; this.ledger.saveSession(state); return;
      }
      if (records.length > 16 || Buffer.byteLength(stableJson(records)) > 60 * 1024) throw new Error('REMOTE_CONTROL_FACT_BATCH_BUDGET');
      const batchId = randomUUID();
      const facts = records.map((record, index) => ({ ...record, factSeq: String(BigInt(state.factSeq) + BigInt(index + 1)),
        eventId: randomUUID(), occurredAt: new Date().toISOString() }));
      request = this.save(context, state, batchId, 'control', '/control/facts/batches', {
        batchId, controlEpoch: state.controlEpoch, firstFactSeq: facts[0].factSeq, lastFactSeq: facts.at(-1)!.factSeq, facts,
      }, 1, `/control/operations/${batchId}`);
      // Keep source revision in a separate immutable local field, not the public hash.
      request.body.coreRevision = records.length === changed.length ? snapshot.revision : state.controlRevision;
      request.body.ackCoreRevision = snapshot.revision;
      request.body.knownCheckpointId = state.operationId;
      this.ledger.updateRequest(request);
    }
    const result = await this.send(context, request);
    if (!['committed', 'covered_by_checkpoint'].includes(result.state) || BigInt(result.lastFactSeq) < BigInt(request.body.lastFactSeq)) throw new Error('REMOTE_CONTROL_FACT_RECEIPT_INVALID');
    observeSyncCommit(telemetry, () => this.ledger.db.transaction(() => {
      const current = this.ledger.session(context.scope,state.localId)!;
      Object.assign(state,current);
      const newerCheckpoint = BigInt(current.factSeq) > BigInt(request!.body.lastFactSeq)
        || request!.body.knownCheckpointId && current.operationId !== request!.body.knownCheckpointId;
      state.factSeq = String([current.factSeq,result.lastFactSeq,request!.body.lastFactSeq].map(value => BigInt(value)).reduce((a,b) => a > b ? a : b));
      if (!newerCheckpoint) {
        state.controlRevision = request!.body.coreRevision;
        for (const fact of request!.body.facts) state.records[recordKey(fact)] = payloadHash({ eventType: fact.eventType, payload: fact.payload });
      }
      this.ledger.saveSession(state); this.ledger.complete(request!.key);
    })());
    telemetry.emit(SyncTelemetry.Event.Acknowledged, { operationId: request.body.batchId,
      stage: SyncTelemetry.Stage.Facts, phase: SyncTelemetry.Stage.LocalAck, outcome: SyncTelemetry.Outcome.Completed,
      businessStatus: result.state, firstFactSeq: request.body.firstFactSeq, lastFactSeq: result.lastFactSeq,
      recordCount: request.body.facts.length, persistOutcome: 'success' });
    for (const fact of request.body.facts) this.deps.store.db.prepare('DELETE FROM remote_control_pending WHERE session_id=? AND object_key=? AND revision<=?')
      .run(state.localId, recordKey(fact), request.body.ackCoreRevision || request.body.coreRevision);
    if (this.deps.store.db.prepare('SELECT 1 FROM remote_control_pending WHERE session_id=? LIMIT 1').get(state.localId)) {
      const latest = this.ledger.session(context.scope,state.localId)!; latest.controlRevision = '0'; this.ledger.saveSession(latest);
    }
  }
  /** History reconciliation is optional and independently scheduled; it never owns command or live retries. */
  private async history(context: AvailabilityContext): Promise<void> {
    if (!this.eligible(`${context.scope}:history`)) return;
    for (const row of this.candidates(context, 'history')) {
      if (!this.current(context)) return;
      const key = `${context.scope}:${row.local_id}`;
      let operation: HistoryOperation | undefined;
      const telemetry = captureRemoteTelemetry({ remoteOwnerId: context.owner.userId, ownerScopeId: context.owner.scopeKey,
        deviceId: context.deviceId, localSessionId: row.local_id, sessionId: row.session_id, lane: 'history',
        operationKind: SyncTelemetry.Kind.History });
      try {
      const state = this.ledger.session(context.scope,row.local_id);
      if (!state || state.phase !== 'active') continue;
      if ((this.historyRetry.get(key) || 0) > Date.now()) continue;
      if (!this.ledger.objectRetryAllowed(context.scope,state.localId,'history-recovery')) continue;
      this.historyRetry.set(key,Date.now() + 30 * 60_000);
      const historyContext: HistoryContext = { scope: context.scope, localId: state.localId, sessionId: state.sessionId,
        writerGeneration: state.writerGeneration, owner: context.owner, deviceId: context.deviceId };
        const history = this.deps.store.history;
        const session = history.prepare(historyContext);
        if (!session) continue;
        operation = history.pending(historyContext).find(item => item.kind === 'recovery');
        if (!operation) {
          if (!context.historySupported) continue;
          const metadata = history.legacyMetadata(historyContext);
          if (metadata.sourceSeq === metadata.exactAckSeq || BigInt(metadata.sourceSeq) <= BigInt(session.resolvedSourceSeq)) continue;
          const query = new URLSearchParams({ deviceId: context.deviceId, sessionId: state.sessionId, localSessionId: state.localId,
            writerGeneration: state.writerGeneration, mode: 'online', connectionGeneration: context.generation });
          const server = await this.deps.request(`/sync/state?${query}`, 'GET', undefined, 3);
          if (!this.current(context)) return;
          const after = String(server.historyResolvedSourceSeq);
          if (!/^(0|[1-9][0-9]*)$/u.test(after) || !server.streamEpoch) throw new Error('REMOTE_HISTORY_STATE_INVALID');
          if (BigInt(after) >= BigInt(metadata.sourceSeq)) continue;
          // At most 64 archived events / 512 KiB enter one attempt; unknown events stop only history.
          const rows = history.legacySourcePage(historyContext,after,metadata.sourceSeq,64);
          if (!rows.length) throw new Error('REMOTE_HISTORY_SOURCE_EVIDENCE_MISSING');
          const events = recoveryEvents(rows,after);
          const refreshKey = `${context.scope}:${state.localId}:history-refresh`;
          const refreshId = this.ledger.request(refreshKey)?.body.operationId || randomUUID();
          const recoveryId = `recovery_${payloadHash(refreshId).slice(0,32)}`, checkpointId = randomUUID();
          operation = await this.serialControl(context,async () => {
            const latest = this.ledger.session(context.scope,state.localId)!;
            this.checkpointRevision = { localId:state.localId,revision:String((this.deps.store.db.prepare('SELECT revision FROM remote_control_revisions WHERE session_id=?').get(state.localId) as { revision:number } | undefined)?.revision || 1) };
            // Resolve an older unknown fact receipt before sealing a newer baseline.
            if (this.ledger.pending(context.scope,'control',state.localId).some(item => item.pathname === '/control/facts/batches'))
              await this.facts(context,latest);
            const refresh = this.save(context,latest,refreshKey,'control','/sync/mode-activations',
              { operationId: refreshId },3,`/sync/mode-activations/${refreshId}`);
            const current = await this.send(context,refresh);
            if (current.writerGeneration !== latest.writerGeneration || current.state !== 'active') throw new Error('REMOTE_RECOVERY_CONTROL_NOT_READY');
            const required = recoveryRequired(events);
            const checkpointState: AvailabilitySession = { ...latest, operationId: checkpointId,
              pendingCommandIds: current.pendingCommandIds || [], pendingApprovalIds: current.pendingApprovalIds || [], pendingQuestionIds: current.pendingQuestionIds || [],
              pendingRunIds: [...new Set([...(current.pendingRunIds || []), ...(current.pendingCommands || [])
                .filter((command: any) => command.runId && !(command.status === 'accepted' && command.claimId == null)).map((command: any) => command.runId)])] as string[] };
            const snapshot = availabilityControlSnapshot(this.deps.store,state.localId,
              [...new Set([...checkpointState.pendingRunIds,...required.runIds])],true,
              { approvalIds: [...new Set([...checkpointState.pendingApprovalIds!,...required.approvalIds])],
                questionIds: [...new Set([...checkpointState.pendingQuestionIds!,...required.questionIds])],deletedMessageIds: required.deletedMessageIds });
            this.checkpointRevision = { localId:state.localId,revision:snapshot.revision };
            const through = String(BigInt(snapshot.revision) > BigInt(latest.factSeq) ? BigInt(snapshot.revision) : BigInt(latest.factSeq));
            const sourceManifest = recoverySourceManifest(events,snapshot,through), frozen = events.at(-1)!.sourceSeq;
            const extra = { sourceManifestHash: payloadHash(sourceManifest), frozenThroughSourceSeq: frozen, expectedResolvedSourceSeq: after };
            // Persist both original business intents before the first checkpoint or recovery write.
            const intent = history.sealOperation({ id: recoveryId,context: historyContext,kind: 'recovery',request: {
              checkpointState, snapshot, extra,
              begin: { ...this.body(context,latest), recoveryId, recoveryMode: 'merge_recent',policyVersion: '1',streamEpoch: server.streamEpoch,
                expectedHistoryGeneration: String(server.historyGeneration),expectedResolvedSourceSeq: after,frozenThroughSourceSeq: frozen,
                sealedLocalRevision: checkpointId,controlCheckpointReceiptId: checkpointId,sourceManifest,objects: [] },
            } });
            this.ledger.complete(refresh.key);
            await this.bootstrap(context,checkpointState,{ snapshot,extra });
            return intent;
          });
        } else await this.serialControl(context,async () => {
          const checkpointState = operation!.request.checkpointState as AvailabilitySession;
          this.checkpointRevision = { localId:state.localId,revision:String((this.deps.store.db.prepare('SELECT revision FROM remote_control_revisions WHERE session_id=?').get(state.localId) as { revision:number } | undefined)?.revision || 1) };
          if (!this.ledger.db.prepare('SELECT 1 FROM availability_receipts WHERE operation_id=?').get(checkpointState.operationId))
            await this.bootstrap(context,checkpointState,{ snapshot: operation!.request.snapshot as ControlSnapshot,extra: operation!.request.extra as Record<string,unknown> });
        });
        await this.recoverHistory(context,operation);
      } catch (error) {
        const status = (error as { httpStatus?: number }).httpStatus;
        if (operation && (status === 400 || status === 409)) {
          try { await this.abortRecovery(context,operation); } catch { /* Unknown abort stays durable for reconciliation. */ }
        }
        telemetry.emit(operation ? SyncTelemetry.Event.HistoryDeferred : SyncTelemetry.Event.Stage, { operationId: operation?.id,
          publicationKind: SyncTelemetry.Kind.History, phase: SyncTelemetry.Stage.HistoryRecovery, businessStatus: 'pending',
          stage: SyncTelemetry.Stage.HistoryRecovery, outcome: SyncTelemetry.Outcome.Deferred,
          reason: SyncTelemetry.Reason.RequestFailed });
        // No service readiness/WS flag is changed by a history-only failure.
        remoteDiagnosticLog('remote.history.deferred', { localSessionId: row.local_id, lane: 'history', error, reason: 'REQUEST_FAILED' }, 'warn');
        if (error instanceof SyntaxError || (error instanceof Error && /REMOTE_(RECOVERY|HISTORY)_.*(EVIDENCE|UNCOVERED|CONFLICT|MISSING|INVALID)/u.test(error.message)))
          this.ledger.objectFault(context.scope,row.local_id,'history-recovery',payloadHash(remoteSyncErrorMetadata(error)));
        this.historyRetry.set(key,Date.now() + Math.max(status === 400 || status === 409 ? 30 * 60_000 : 60_000,Number((error as { retryAfterMs?: number }).retryAfterMs) || 0));
      }
    }
  }
  private async abortRecovery(context: AvailabilityContext, operation: HistoryOperation): Promise<void> {
    await this.serialControl(context,async () => {
      const state = operation.request.checkpointState as AvailabilitySession;
      const begin = this.ledger.request(`${state.operationId}:begin`);
      if (begin && !this.ledger.db.prepare('SELECT 1 FROM availability_receipts WHERE operation_id=?').get(state.operationId)) {
        const { mode: _mode,connectionGeneration: _generation,...business } = begin.body;
        const abort = this.save(context,state,`${state.operationId}:abort`,'control',`/control/bootstrap/${state.operationId}/abort`,
          { controlEpoch: state.controlEpoch,beginRequestHash: payloadHash(business) },1,null);
        const receipt = await this.send(context,abort);
        if (receipt.state === 'committed') await this.bootstrap(context,state);
        else if (['aborted','expired','superseded'].includes(receipt.state)) this.ledger.archiveBootstrap(context.scope,state.localId,state.operationId,receipt);
        else throw new Error('REMOTE_HISTORY_CHECKPOINT_ABORT_UNKNOWN');
      }
      const request = operation.request.begin as Record<string,unknown>;
      const { mode: _mode,connectionGeneration: _generation,...business } = request;
      const result = await this.deps.request(`/sync/recoveries/${operation.id}/abort`,'POST',
        { ...this.body(context,state),connectionGeneration: context.generation,beginRequestHash: payloadHash(business) },3,this.checkpointTimeout());
      if (!this.current(context)) throw new Error('REMOTE_AVAILABILITY_CONTEXT_CHANGED');
      if (!['aborted','expired','committed'].includes(result.state)) throw new Error('REMOTE_HISTORY_ABORT_UNKNOWN');
      const previous = this.deps.store.history.session(operation.context)!;
      this.deps.store.history.completeOperation(operation.context,operation.id,result,result.state === 'committed'
        ? { historyGeneration: result.historyGeneration,resolvedSourceSeq: result.resolvedSourceSeq }
        : { historyGeneration: previous.historyGeneration,resolvedSourceSeq: previous.resolvedSourceSeq });
    });
  }
  private checkpointTimeout(): number | undefined {
    const deadline = this.checkpointDeadline || this.controlDeadline;
    return deadline ? Math.max(1,deadline-Date.now()) : undefined;
  }
  private checkpointGuard(): void {
    if (this.controlDeadline && Date.now() >= this.controlDeadline) throw new Error('REMOTE_CONTROL_TURN_YIELDED');
    if (!this.checkpointDeadline) return;
    const revision = this.checkpointRevision;
    const current = revision && this.deps.store.db.prepare('SELECT revision FROM remote_control_revisions WHERE session_id=?').get(revision.localId) as { revision: number } | null;
    if (Date.now() >= this.checkpointDeadline || revision && String(current?.revision || 1) !== revision.revision)
      throw new Error('REMOTE_HISTORY_CHECKPOINT_YIELDED');
  }
  private async serialControl<T>(context: AvailabilityContext, action: () => Promise<T>): Promise<T> {
    while (this.controlWork) await this.controlWork;
    if (!this.current(context)) throw new Error('REMOTE_AVAILABILITY_CONTEXT_CHANGED');
    this.checkpointDeadline = Date.now() + 3000;
    const operation = action(), lock = operation.then(() => {},() => {});
    this.controlWork = lock;
    try { return await operation; } finally { if (this.controlWork === lock) this.controlWork = null; this.checkpointDeadline = 0; this.checkpointRevision = null; }
  }
  private async recoverHistory(context: AvailabilityContext, operation: HistoryOperation): Promise<void> {
    const telemetry = captureRemoteTelemetry({ remoteOwnerId: context.owner.userId, ownerScopeId: context.owner.scopeKey,
      deviceId: context.deviceId, localSessionId: operation.context.localId, sessionId: operation.context.sessionId,
      operationId: operation.id, operationKind: SyncTelemetry.Kind.History, lane: 'history' });
    const history = this.deps.store.history, begin = operation.request.begin as Record<string,any>;
    const state = this.ledger.session(context.scope,operation.context.localId)!;
    const prefix = `/sync/recoveries/${operation.id}`;
    let result: any;
    try { result = await this.deps.request(prefix,'GET',undefined,3); }
    catch (error) { if ((error as { httpStatus?: number }).httpStatus !== 404) throw error; }
    if (!this.current(context)) throw new Error('REMOTE_AVAILABILITY_CONTEXT_CHANGED');
    telemetry.emit(SyncTelemetry.Event.Reconciled, { stage: result ? SyncTelemetry.Stage.Reconcile : SyncTelemetry.Stage.Replay,
      outcome: SyncTelemetry.Outcome.Pending, reconcileTrigger: 'receipt_missing', receiptState: result?.state });
    if (!result) result = await this.deps.request('/sync/recoveries','POST',{ ...begin,connectionGeneration: context.generation },3);
    if (!this.current(context)) throw new Error('REMOTE_AVAILABILITY_CONTEXT_CHANGED');
    if (['aborted','expired'].includes(result.state)) {
      const session = history.session(operation.context)!;
      history.completeOperation(operation.context,operation.id,result,{ historyGeneration: session.historyGeneration,resolvedSourceSeq: session.resolvedSourceSeq });
      return;
    }
    if (result.state !== 'committed') {
      // Recent content already uses independent live publication. Empty merge preserves all healthy history and explicitly records the sealed gap.
      const objects: unknown[] = [], manifest = { parts: [{ partNo: 0,payloadHash: payloadHash(objects),bytes: 2,objectCount: 0 }],objectPlanHash: payloadHash(objects) };
      const manifestHash = payloadHash(manifest), common = { ...this.body(context,state),connectionGeneration: context.generation };
      await this.deps.request(`${prefix}/parts/0`,'PUT',{ ...common,objects,manifest,manifestHash },3);
      if (!this.current(context)) throw new Error('REMOTE_AVAILABILITY_CONTEXT_CHANGED');
      result = await this.deps.request(`${prefix}/commit`,'POST',{ ...common,manifestHash },3);
    }
    if (!this.current(context)) throw new Error('REMOTE_AVAILABILITY_CONTEXT_CHANGED');
    if (result.state !== 'committed' || result.recoveryId !== operation.id || result.resolvedSourceSeq !== begin.frozenThroughSourceSeq)
      throw new Error('REMOTE_HISTORY_RECEIPT_INVALID');
    history.completeOperation(operation.context,operation.id,result,{ historyGeneration: result.historyGeneration,resolvedSourceSeq: result.resolvedSourceSeq });
  }
  private async live(context: AvailabilityContext): Promise<void> {
    if (!this.eligible(`${context.scope}:live`)) return;
    let sent = 0, encoded = 0;
    for (const row of this.candidates(context, 'live')) {
      if (!this.current(context) || sent >= 2 || encoded >= 4) return;
      const taskKey = `${context.scope}:live:${row.local_id}`;
      const telemetry = captureRemoteTelemetry({ remoteOwnerId: context.owner.userId, ownerScopeId: context.owner.scopeKey,
        deviceId: context.deviceId, localSessionId: row.local_id, sessionId: row.session_id, lane: 'live',
        operationKind: SyncTelemetry.Kind.Live });
      if (!this.eligible(taskKey)) continue;
      try {
        const state = this.ledger.session(context.scope, row.local_id);
        if (!state || state.phase !== 'active') {
          telemetry.emit(SyncTelemetry.Event.Stage, { stage: SyncTelemetry.Stage.ProjectionQueue,
            outcome: SyncTelemetry.Outcome.Skipped, reason: SyncTelemetry.Reason.Guard });
          continue;
        }
        const rowStart = sent;
      // Seed only a bounded recent window. Old history is handled by explicit recovery, never by this live lane.
      this.deps.store.db.prepare(`INSERT INTO remote_live_revisions(session_id,object_id,revision,deleted)
        SELECT session_id,id,1,0 FROM (SELECT session_id,id FROM cowork_messages WHERE session_id=? ORDER BY sequence DESC LIMIT 64) WHERE 1
        ON CONFLICT(session_id,object_id) DO NOTHING`).run(row.local_id);
      this.deps.store.db.prepare(`INSERT INTO remote_live_tool_sources(session_id,message_id,tool_id)
        SELECT session_id,id,COALESCE(CASE WHEN json_valid(metadata) THEN COALESCE(json_extract(metadata,'$.toolUseId'),json_extract(metadata,'$.toolCallId')) END,id)
        FROM (SELECT session_id,id,metadata FROM cowork_messages WHERE session_id=? AND type IN ('tool_use','tool_result') ORDER BY sequence DESC LIMIT 64) WHERE 1
        ON CONFLICT(session_id,message_id) DO NOTHING`).run(row.local_id);
      this.deps.store.db.prepare(`INSERT INTO remote_live_tools SELECT DISTINCT session_id,tool_id,1 FROM remote_live_tool_sources WHERE session_id=?
        ON CONFLICT(session_id,tool_id) DO NOTHING`).run(row.local_id);
      const candidates = this.deps.store.db.prepare(`SELECT r.object_id,r.revision,'message' AS kind,m.sequence AS position
        FROM remote_live_revisions r JOIN cowork_messages m ON m.id=r.object_id AND m.session_id=r.session_id
        WHERE r.session_id=? AND r.deleted=0 AND m.type IN ('user','assistant','system','tool_use','tool_result')
        UNION ALL SELECT t.tool_id AS object_id,t.revision,'tool' AS kind,MAX(m.sequence) AS position
        FROM remote_live_tools t JOIN remote_live_tool_sources ts ON ts.session_id=t.session_id AND ts.tool_id=t.tool_id
        JOIN cowork_messages m ON m.session_id=ts.session_id AND m.id=ts.message_id WHERE t.session_id=? GROUP BY t.tool_id
        ORDER BY position DESC,kind DESC LIMIT 64`).all(row.local_id,row.local_id) as Array<{ object_id: string; revision: number; kind: 'message' | 'tool' }>;
        // Corrupt body bytes cannot hide the original operation or let a newer version bypass it.
        const page = this.ledger.scanPending(context.scope, 'live', row.local_id, this.pendingCursors.get(taskKey));
        if (page.nextCursor) this.pendingCursors.set(taskKey, page.nextCursor); else this.pendingCursors.delete(taskKey);
        for (const item of page.rows) {
          if (sent > rowStart || sent >= 2 || !this.current(context)) break;
          if (item.state === AvailabilityReadState.Corrupt) {
            telemetry.emit(SyncTelemetry.Event.Quarantined, { operationId: item.key, objectId: item.objectId,
              stage: SyncTelemetry.Stage.Reconcile, phase: SyncTelemetry.Stage.Reconcile, outcome: SyncTelemetry.Outcome.Blocked, failureScope: 'object',
              reason: SyncTelemetry.Reason.RecordInvalid });
            remoteDiagnosticLog('remote.record.quarantined', { localSessionId: row.local_id, operationId: item.key,
              objectId: item.objectId, lane: 'live', reason: item.reason }, 'warn');
            continue;
          }
          const request = item.value;
          if (!this.eligible(request.key)) continue;
          sent++;
          try { await this.publishLive(context, request); this.failures.delete(request.key); }
          catch (error) { if (this.current(context)) this.fail(request.key, error); }
        }
        for (const candidate of candidates) {
          if (sent > rowStart || sent >= 2 || encoded >= 4 || !this.current(context)) break;
          const objectKey = `${candidate.kind}:${candidate.object_id}`, key = `${taskKey}:${objectKey}`;
          const fingerprint = payloadHash({ kind: candidate.kind, objectId: candidate.object_id, revision: String(candidate.revision) });
          let encoding = false;
          try {
            if (!this.eligible(key) || !this.ledger.objectRetryAllowed(context.scope, row.local_id, objectKey, Date.now(), fingerprint)
              || (this.liveScan.get(key) || 0) > Date.now()) continue;
            if (this.ledger.object(context.scope, row.local_id, objectKey)?.sourceRevision === String(candidate.revision)
              || this.ledger.hasPendingObject(context.scope, row.local_id, candidate.kind, candidate.object_id)) continue;
            encoding = true; encoded++;
            const projection = await this.encoder.project(this.deps.store.db, { database: this.deps.store.db.name,
              localId: row.local_id, sessionId: row.session_id, deviceId: context.deviceId, owner: context.owner,
              environment: context.environment, objectId: candidate.object_id, objectKind: candidate.kind, revision: String(candidate.revision) });
            encoding = false;
            if (!this.current(context)) return;
            if (this.liveScan.size >= 1024) this.liveScan.delete(this.liveScan.keys().next().value!);
            this.liveScan.set(key, Date.now() + 1000);
            if (!projection) {
              this.ledger.skipObject(context.scope, row.local_id, objectKey, String(candidate.revision));
              telemetry.emit(SyncTelemetry.Event.Stage, { stage: SyncTelemetry.Stage.Projection, outcome: SyncTelemetry.Outcome.Skipped,
                objectId: candidate.object_id, objectRevision: String(candidate.revision), reason: SyncTelemetry.Reason.LocalOnly });
              continue;
            }
            telemetry.emit(SyncTelemetry.Event.Stage, { stage: SyncTelemetry.Stage.Projection,
              outcome: SyncTelemetry.Outcome.Completed,
              objectId: candidate.object_id, objectRevision: String(candidate.revision), representation: projection.representation,
              contentUnavailableReason: projection.payload.contentUnavailableReason });
            const publicationId = randomUUID();
            const request = this.save(context, state, publicationId, 'live', '/sync/live-projections', { publicationId,
              ...projection, policyVersion: '1' }, 3, `/sync/live-projections/${publicationId}?sessionId=${encodeURIComponent(row.session_id)}&writerGeneration=${encodeURIComponent(state.writerGeneration)}`);
            remoteDiagnosticLog('remote.publication.sealed', { operationId: publicationId, localSessionId: row.local_id, objectId: candidate.object_id, lane: 'live' });
            sent++; await this.publishLive(context, request); this.failures.delete(key);
          } catch (error) {
            if (!this.current(context)) return;
            if (encoding) {
              telemetry.emit(SyncTelemetry.Event.Quarantined, { stage: SyncTelemetry.Stage.Projection,
                outcome: SyncTelemetry.Outcome.Failed, phase: SyncTelemetry.Stage.Projection, failureScope: 'object', objectId: candidate.object_id,
                objectRevision: String(candidate.revision), reason: SyncTelemetry.Reason.EncodingFailed });
              try { this.ledger.objectFault(context.scope, row.local_id, objectKey, fingerprint); }
              catch (recordError) { this.fail(taskKey, recordError); }
              remoteDiagnosticLog('remote.record.quarantined', { localSessionId: row.local_id, objectId: candidate.object_id,
                revision: String(candidate.revision), lane: 'live', reason: 'ENCODING_FAILED', error }, 'warn');
            }
            this.fail(key, error);
          }
        }
      } catch (error) { if (this.current(context)) this.fail(taskKey, error); }
    }
  }
  private async publishLive(context: AvailabilityContext, request: AvailabilityRequest): Promise<void> {
    const telemetry = captureRemoteTelemetry({ remoteOwnerId: context.owner.userId, ownerScopeId: context.owner.scopeKey,
      deviceId: context.deviceId, localSessionId: request.localId, sessionId: request.body.sessionId, lane: 'live',
      operationId: request.body.publicationId, operationKind: SyncTelemetry.Kind.Live, objectId: request.body.objectId,
      objectRevision: request.body.sourceObjectRevision });
    const result = await this.send(context, request);
    if (result.publicationId !== request.body.publicationId || !['accepted', 'superseded', 'rejected'].includes(result.state)) throw new Error('REMOTE_LIVE_RECEIPT_INVALID');
    if (result.state === 'rejected') this.ledger.objectFault(context.scope, request.localId, `${request.body.objectKind}:${request.body.objectId}`,
      payloadHash({ kind: request.body.objectKind, objectId: request.body.objectId, revision: request.body.sourceObjectRevision }));
    if (result.state === 'rejected' && request.body.representation === 'complete' && request.body.objectKind === 'message') {
      const state = this.ledger.session(context.scope, request.localId);
      if (!state) throw new Error('REMOTE_AVAILABILITY_STATE_MISSING');
      const payload = { ...request.body.payload, blocks: [], contentState: 'desktop_only', contentUnavailableReason: 'CONTENT_UNAVAILABLE' };
      const publicationId = randomUUID();
      observeSyncCommit(telemetry, () => this.ledger.db.transaction(() => {
        this.save(context, state, publicationId, 'live', '/sync/live-projections', { publicationId, objectKind: 'message',
          objectId: request.body.objectId, sourceObjectRevision: request.body.sourceObjectRevision, representation: 'desktop_only',
          policyVersion: '1', payload, payloadHash: payloadHash(payload) }, 3,
        `/sync/live-projections/${publicationId}?sessionId=${encodeURIComponent(state.sessionId)}&writerGeneration=${encodeURIComponent(state.writerGeneration)}`);
        this.ledger.completeObject(request, result);
      })());
      telemetry.emit(SyncTelemetry.Event.Acknowledged, { publicationKind: SyncTelemetry.Kind.Live,
        stage: SyncTelemetry.Stage.LocalAck, phase: SyncTelemetry.Stage.LocalAck, outcome: SyncTelemetry.Outcome.Completed,
        businessStatus: result.state, representation: request.body.representation, persistOutcome: 'success' });
      telemetry.emit(SyncTelemetry.Event.Sealed, { operationId: publicationId, publicationKind: SyncTelemetry.Kind.Live,
        stage: SyncTelemetry.Stage.Sealed, phase: SyncTelemetry.Stage.Sealed, outcome: SyncTelemetry.Outcome.Completed,
        representation: 'desktop_only', businessStatus: 'pending', persistOutcome: 'success' });
      return;
    }
    this.ledger.completeObject(request, result);
    if (result.state === 'accepted' && ['complete', 'desktop_only'].includes(request.body.representation)) {
      const key = `${context.scope}:${request.localId}:${request.body.objectKind}:${request.body.objectId}`;
      const previous = this.contentRepresentations.get(key), representation = request.body.representation as string;
      if (this.contentRepresentations.size >= 1024 && !this.contentRepresentations.has(key))
        this.contentRepresentations.delete(this.contentRepresentations.keys().next().value!);
      this.contentRepresentations.set(key, representation);
      if (representation === 'desktop_only' && previous !== representation || previous === 'desktop_only' && representation === 'complete')
        telemetry.emit(SyncTelemetry.Event.Content, { stage: SyncTelemetry.Stage.LocalAck,
          outcome: representation === 'desktop_only' ? SyncTelemetry.Outcome.Degraded : SyncTelemetry.Outcome.Recovered,
          businessStatus: result.state, representation, contentUnavailableReason: request.body.payload?.contentUnavailableReason });
    }
    remoteDiagnosticLog('remote.publication.acknowledged', { operationId: request.key, localSessionId: request.localId, objectId: request.body.objectId, lane: 'live', result: result.state });
  }
}
