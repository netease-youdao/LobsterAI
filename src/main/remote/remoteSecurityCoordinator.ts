import { randomUUID } from 'crypto';

import { payloadHash } from './canonical';
import type { RemoteIdentity } from './installationIdentity';
import { remoteDiagnostics } from './remoteDiagnostics';
import { type RemoteSecurityCommit,RemoteSecurityJournal, RemoteSecurityJournalError, RemoteSecurityRecovery } from './remoteSecurityJournal';
import type { RemoteStore } from './remoteStore';
import { SyncTelemetry } from './remoteSyncTelemetry';
import { captureRemoteTelemetry } from './remoteTelemetry';

/** External durability is paid only at an execution boundary, never by a normal message write. */
export class RemoteSecurityCoordinator {
  private ready: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private failure: Error | null = null;
  private waiting = 0;
  private recovery: Promise<void> | null = null;
  private recoveryAttempts = 0;
  private nextRecoveryAt = 0;
  private closed = false;
  constructor(private store: RemoteStore, private journal: RemoteSecurityJournal, private identity: RemoteIdentity, checkpoint: number) {
    const telemetry = captureRemoteTelemetry({ domain: 'security_journal' });
    const storedIdentity = store.get<string>('databaseInstance');
    const oldCheckpoint = store.get<number>('databaseCheckpoint') || 0;
    const legacyVerified = (!storedIdentity || storedIdentity === identity.databaseId) && checkpoint === oldCheckpoint;
    const migrated = store.get<boolean>('securityJournalMigrated') === true;
    store.setSecurityRecoveryRequired(true);
    store.setOwnershipSigner((id, userId, scopeKey, operationId) => this.journal.signOwnership({
      sessionId: id, ownerUserId: userId, scopeKey, ownershipRevision: 1, operationId,
    }));
    this.ready = this.initialize(identity, migrated, legacyVerified).catch(error => {
      this.failure = error instanceof Error ? error : new RemoteSecurityJournalError('Security initialization failed');
      store.setSecurityRecoveryRequired(true); remoteDiagnostics.record('security.unknown');
      telemetry.emit(SyncTelemetry.Event.Admission, { fromState: 'initializing', toState: 'blocked', reason: SyncTelemetry.Reason.EvidenceUnknown });
      console.warn('[RemoteSecurity] Mobile execution requires local recovery', { reason: 'security_evidence_unknown' });
    });
  }
  private evidence() {
    return { head: this.store.get<RemoteSecurityCommit>('securityJournalHead'), restored: false,
      hasConflict: this.store.get<boolean>('securityJournalConflict') === true };
  }
  private async validateOwnership(identity: RemoteIdentity, migrated: boolean, legacyVerified: boolean): Promise<void> {
    let cursor = '';
    while (true) {
      const rows = this.store.db.prepare(`SELECT session_id,owner_user_id,owner_scope_key FROM cowork_session_ownership
        WHERE ownership_status='confirmed' AND session_id>? ORDER BY session_id LIMIT 24`).all(cursor) as Array<{ session_id: string; owner_user_id: string; owner_scope_key: string }>;
      if (!rows.length) return;
      this.store.transaction(() => {
        for (const row of rows) {
          let proof: { operationId: string; signature: string } | null = null;
          try { proof = this.store.get(`ownershipProof:${row.session_id}`); } catch { /* Invalid signed evidence is isolated to its task. */ }
          const fact = { sessionId: row.session_id, ownerUserId: row.owner_user_id, scopeKey: row.owner_scope_key, ownershipRevision: 1 };
          if (proof && this.journal.verifyOwnership({ ...fact, operationId: proof.operationId }, proof.signature)) continue;
          const pending = this.store.db.prepare('SELECT * FROM remote_ownership_pending WHERE session_id=?').get(row.session_id) as { owner_user_id: string; owner_scope_key: string; operation_id: string; database_id: string | null } | undefined;
          const pendingMatches = pending && pending.owner_user_id === row.owner_user_id && pending.owner_scope_key === row.owner_scope_key
            && (pending.database_id === identity.databaseId || !migrated && legacyVerified && !pending.database_id);
          if (!proof && (pendingMatches || !migrated && legacyVerified)) {
            const operationId = pending?.operation_id || randomUUID();
            this.store.put(`ownershipProof:${row.session_id}`, { operationId, signature: this.journal.signOwnership({ ...fact, operationId }) });
            this.store.db.prepare('DELETE FROM remote_ownership_pending WHERE session_id=?').run(row.session_id);
          } else if (!proof && pending) {
            // No same-installation proof: keep the local owner fact; remote admission remains disabled.
            throw new RemoteSecurityJournalError('Pending ownership belongs to an unverified installation');
          } else this.store.db.prepare("UPDATE cowork_session_ownership SET ownership_status='quarantined' WHERE session_id=?").run(row.session_id);
        }
      });
      cursor = rows.at(-1)!.session_id;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  private async initialize(identity: RemoteIdentity, migrated: boolean, legacyVerified: boolean): Promise<void> {
    const telemetry = captureRemoteTelemetry({ domain: 'security_journal' });
    await this.store.waitRunRecovery();
    if (!await this.store.verifyExecutionDatabaseHealth()) throw new RemoteSecurityJournalError('Core database health is unknown');
    const evidence = this.evidence();
    const result = await this.journal.initialize({ ...evidence, hasConflict: evidence.hasConflict || (!migrated && !legacyVerified),
      legacyCheckpointVerified: !migrated && legacyVerified });
    if (result.status === RemoteSecurityRecovery.CancellationRequired) {
      // A predecessor DB can be a restored backup. Never turn this into permission to replay.
      throw new RemoteSecurityJournalError('Pending execution journal requires explicit recovery');
    }
    await this.validateOwnership(identity, migrated, legacyVerified);
    this.store.transaction(() => {
      this.store.put('databaseInstance', identity.databaseId);
      this.store.put('securityJournalMigrated', true);
    });
    await this.classifyRunCorruption();
    this.store.setSecurityRecoveryRequired(false); remoteDiagnostics.record('security.recovered');
    telemetry.emit(SyncTelemetry.Event.Admission, { fromState: 'initializing', toState: 'ready', reason: SyncTelemetry.Reason.None });
  }
  private async classifyRunCorruption(): Promise<void> {
    let cursor: string | null = '';
    do {
      cursor = this.store.classifyRunCorruption((sessionId, owner) => {
        const proof = this.store.get<{ operationId: string; signature: string }>(`ownershipProof:${sessionId}`);
        return !!proof && this.journal.verifyOwnership({ sessionId, ownerUserId: owner.userId, scopeKey: owner.scopeKey,
          ownershipRevision: 1, operationId: proof.operationId }, proof.signature);
      }, cursor, record => {
        const head = this.evidence().head;
        return !!head && record.sequence <= head.sequence && (record.sequence !== head.sequence || record.recordDigest === head.recordDigest)
          && this.journal.verifyCommit(record);
      });
      if (cursor) await new Promise<void>(resolve => setImmediate(resolve));
    } while (cursor);
  }
  async available(): Promise<void> {
    await this.ready;
    if (this.failure && !this.waiting && !this.closed && this.recoveryAttempts < 4 && Date.now() >= this.nextRecoveryAt) await this.recover();
    if (this.failure) throw this.failure;
    if (this.store.needsSecurityRecovery()) throw new RemoteSecurityJournalError('Local security evidence requires recovery');
  }
  /** Coalesced evidence-only recovery; never runs an old apply closure or cancels pending work. */
  recover(): Promise<void> {
    if (this.recovery) return this.recovery;
    if (this.waiting || this.closed) return Promise.reject(new RemoteSecurityJournalError('Security operations are still active'));
    this.recoveryAttempts++;
    this.nextRecoveryAt = Date.now() + [1000, 5000, 15000, 60000][Math.min(this.recoveryAttempts - 1, 3)]!;
    const operation = (async () => {
      try {
        await this.ready;
        if (!await this.store.verifyExecutionDatabaseHealth()) throw new RemoteSecurityJournalError('Core database health is unknown');
        const result = await this.journal.recover(this.evidence());
        if (result.status === RemoteSecurityRecovery.CancellationRequired) throw new RemoteSecurityJournalError('Pending execution journal requires explicit recovery');
        await this.validateOwnership(this.identity, true, false);
        if (this.closed) throw new RemoteSecurityJournalError('Security coordinator is closed');
        await this.classifyRunCorruption();
        this.store.setSecurityRecoveryRequired(false);
        this.failure = null;
        this.recoveryAttempts = 0;
        remoteDiagnostics.record('security.recovered');
      } catch (error) {
        this.failure = error instanceof Error ? error : new RemoteSecurityJournalError('Execution durability is unknown');
        this.store.setSecurityRecoveryRequired(true);
      }
    })().finally(() => { if (this.recovery === operation) this.recovery = null; });
    this.recovery = operation;
    return operation;
  }
  async commit<T>(operationId: string, operation: unknown, apply: () => T): Promise<T> {
    const telemetry = captureRemoteTelemetry({ domain: 'security_journal' });
    if (this.waiting >= 20) {
      telemetry.emit(SyncTelemetry.Event.Admission, { fromState: 'ready', toState: 'blocked', reason: SyncTelemetry.Reason.Budget });
      throw new RemoteSecurityJournalError('Security transition queue is full');
    }
    this.waiting++;
    const work = this.queue.catch((): void => undefined).then(async () => {
      if (this.recovery) await this.recovery;
      await this.available();
      const record = await this.journal.prepare({ operationId, operationDigest: payloadHash(operation) });
      const result = this.store.transaction(() => {
        const value = apply();
        this.store.put('securityJournalHead', record);
        this.store.recordCommittedExecution(operationId, operation, record);
        return value;
      });
      await this.journal.finalize(record, () => this.evidence());
      return result;
    }).catch(error => {
      this.failure = error instanceof Error ? error : new RemoteSecurityJournalError('Execution durability is unknown');
      this.store.setSecurityRecoveryRequired(true); remoteDiagnostics.record('security.unknown');
      telemetry.emit(SyncTelemetry.Event.Admission, { fromState: 'ready', toState: 'blocked', reason: SyncTelemetry.Reason.EvidenceUnknown });
      throw error;
    }).finally(() => { this.waiting--; });
    this.queue = work;
    return work;
  }
  close(): void { this.closed = true; this.journal.close(); }
}
