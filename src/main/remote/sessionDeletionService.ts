import { type RemoteOwner, RemoteRunStatus, type RemoteRunStatusValue } from '../../shared/remote/constants';
import { RemoteDeletion } from '../../shared/remote/deletions';
import { RemoteTelemetryEvent as TelemetryEvent } from '../../shared/remote/telemetry';
import type { CoworkStore } from '../coworkStore';
import { t } from '../i18n';
import type { CoworkRuntime } from '../libs/agentEngine/types';
import { sameOwner } from './canonical';
import { captureRemoteTelemetry } from './remoteTelemetry';

/** Shared local record deletion; remote authorization belongs to the deletion control lane. */
const CleanupPrefix = 'deletionCleanup:';
const terminal = new Set<RemoteRunStatusValue>([
  RemoteRunStatus.Succeeded, RemoteRunStatus.Failed, RemoteRunStatus.Cancelled, RemoteRunStatus.Interrupted,
]);
export class SessionDeletionService {
  private cleanupCursor = '';
  constructor(private readonly store: CoworkStore, private readonly runtime: CoworkRuntime,
    private readonly cleanup: (sessionId: string) => void, private readonly getOwner: () => RemoteOwner | null,
    private readonly getAccountEpoch?: () => string | number) {
    const timer = setInterval(() => {
      try {
        const rows = this.store.remote.entries<{ sessionId: string }>(CleanupPrefix, this.cleanupCursor, 10);
        for (const row of rows) { this.cleanupCursor = row.key; this.finishCleanup(row.value.sessionId); }
        if (rows.length < 10) this.cleanupCursor = '';
      }
      catch { /* Store shutdown or local maintenance must not affect running tasks. */ }
    }, 30000);
    timer.unref?.();
  }

  async deleteLocal(sessionId: string): Promise<void> { await this.deleteLocalBatch([sessionId]); }

  async deleteLocalBatch(sessionIds: string[]): Promise<void> {
    const ids = [...new Set(sessionIds)], actor = this.getOwner();
    const accountEpoch = this.getAccountEpoch?.();
    const telemetry = captureRemoteTelemetry({ lane: 'control', operation_kind: 'deletion', remote_owner_id: actor?.userId, owner_scope_id: actor?.scopeKey });
    const targets = new Map(ids.map(id => {
      this.store.remote.assertActor(id, actor);
      return [id, { guardVersion: this.store.remote.deletionGuard(id).version, runId: this.store.remote.run(id)?.runId ?? null }];
    }));
    const assertCurrentTargets = (): void => {
      const currentActor = this.getOwner();
      if (accountEpoch !== this.getAccountEpoch?.()
        || (actor ? !sameOwner(actor, currentActor) : currentActor !== null)) throw new Error(t('sessionDeletionTargetChanged'));
      for (const [id, target] of targets) {
        this.store.remote.assertActor(id, currentActor);
        if (this.store.remote.deletionGuard(id).version !== target.guardVersion
          || (this.store.remote.run(id)?.runId ?? null) !== target.runId) throw new Error(t('sessionDeletionTargetChanged'));
      }
    };
    for (const sessionId of ids) {
      assertCurrentTargets();
      const run = this.store.remote.run(sessionId);
      if (this.runtime.isSessionActive?.(sessionId) === true || run && !terminal.has(run.status)) {
        const confirmed = await this.runtime.cancelSessionConfirmed?.(sessionId);
        // A stop response must not mutate a replaced run or a later account generation.
        assertCurrentTargets();
        if (!confirmed) throw new Error(t('sessionDeletionStopUnconfirmed'));
        const currentRun = this.store.remote.run(sessionId);
        if (currentRun && !terminal.has(currentRun.status)) this.store.remote.updateRun(sessionId, RemoteRunStatus.Cancelled);
      }
    }
    assertCurrentTargets();
    this.commit(ids);
    for (const localSessionId of ids) telemetry.emit(TelemetryEvent.SyncStage, { stage: 'local_commit', outcome: 'succeeded', local_session_id: localSessionId, origin: 'desktop' });
  }

  deleteRemote(sessionId: string, owner: RemoteOwner, recordReceipt: () => void): void {
    this.store.remote.assertActor(sessionId, owner);
    this.commit([sessionId], recordReceipt);
  }

  private commit(sessionIds: string[], recordReceipt?: () => void): void {
    this.store.runSessionTransaction(() => {
      recordReceipt?.();
      for (const sessionId of sessionIds) {
        this.store.deleteSession(sessionId);
        this.store.remote.put(`${CleanupPrefix}${sessionId}`, { sessionId });
      }
    });
    // Cleanup/notifications cannot roll back a committed deletion or lose its durable receipt.
    for (const sessionId of sessionIds) {
      try { if (this.store.remote.get(`${RemoteDeletion.Closed}${sessionId}`)) this.store.remote.clearProjectionHints(sessionId); }
      catch { /* Disposable scheduling hints cannot undo the committed deletion. */ }
      this.finishCleanup(sessionId);
    }
  }

  private finishCleanup(sessionId: string): void {
    // Retried cleanup records have no trusted owner after deletion; do not correlate them with the current account's session IDs.
    const telemetry = captureRemoteTelemetry({ lane: 'control', operation_kind: 'cleanup' });
    try { this.cleanup(sessionId); this.store.remote.remove(`${CleanupPrefix}${sessionId}`); }
    catch (error) { telemetry.emit(TelemetryEvent.SyncStage, { stage: 'cleanup', outcome: 'deferred', reason: 'LOCAL_IO_FAILED' }); console.warn('[SessionDeletion] Post-commit cleanup deferred', error); }
  }
}
