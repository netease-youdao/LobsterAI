// Device-local DSH session binding & event sync watermark store.
//
// This table is strictly device-local and must NEVER be replicated to cloud
// sync: local DSH session IDs and event sequence watermarks belong solely to
// the DSH Host running on this physical machine.
//
// Zero Electron imports — directly unit-testable under Node Vitest.

import type Database from 'better-sqlite3';

import {
  CoworkSessionSource,
} from '../../../shared/cowork/constants';
import { DSH_SESSION_ID_PREFIX } from '../../../shared/dshEngine/hostConstants';

export interface LocalDshSessionBinding {
  coworkSessionId: string;
  dshSessionId: string;
  syncedSeq: number;
  origin: CoworkSessionSource;
  updatedAt: number;
}

export interface UpsertLocalDshSessionBindingInput {
  coworkSessionId: string;
  dshSessionId: string;
  syncedSeq?: number;
  origin?: CoworkSessionSource;
}

interface BindingRow {
  cowork_session_id: string;
  dsh_session_id: string;
  synced_seq: number;
  origin: string;
  updated_at: number;
}

function normalizeDshSessionId(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith(DSH_SESSION_ID_PREFIX)
    ? trimmed.slice(DSH_SESSION_ID_PREFIX.length)
    : trimmed;
}

function normalizeOrigin(raw: string | undefined): CoworkSessionSource {
  switch (raw) {
    case CoworkSessionSource.DshExternal:
      return CoworkSessionSource.DshExternal;
    case CoworkSessionSource.Im:
      return CoworkSessionSource.Im;
    case CoworkSessionSource.Scheduled:
      return CoworkSessionSource.Scheduled;
    case CoworkSessionSource.Cloud:
      return CoworkSessionSource.Cloud;
    default:
      return CoworkSessionSource.Desktop;
  }
}

function rowToBinding(row: BindingRow): LocalDshSessionBinding {
  return {
    coworkSessionId: row.cowork_session_id,
    dshSessionId: row.dsh_session_id,
    syncedSeq: row.synced_seq,
    origin: normalizeOrigin(row.origin),
    updatedAt: row.updated_at,
  };
}

export function ensureLocalDshSessionBindingsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_dsh_session_bindings (
      cowork_session_id TEXT PRIMARY KEY,
      dsh_session_id TEXT NOT NULL UNIQUE,
      synced_seq INTEGER NOT NULL DEFAULT -1,
      origin TEXT NOT NULL DEFAULT 'desktop',
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (cowork_session_id) REFERENCES cowork_sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_local_dsh_bindings_dsh_id
      ON local_dsh_session_bindings(dsh_session_id);
  `);
}

export class LocalDshSessionBindingStore {
  constructor(private readonly db: Database.Database) {
    ensureLocalDshSessionBindingsTable(db);
  }

  getByCoworkSessionId(coworkSessionId: string): LocalDshSessionBinding | null {
    const row = this.db
      .prepare(
        `SELECT cowork_session_id, dsh_session_id, synced_seq, origin, updated_at
         FROM local_dsh_session_bindings
         WHERE cowork_session_id = ?`,
      )
      .get(coworkSessionId) as BindingRow | undefined;
    return row ? rowToBinding(row) : null;
  }

  getByDshSessionId(dshSessionId: string): LocalDshSessionBinding | null {
    const normalized = normalizeDshSessionId(dshSessionId);
    if (!normalized) return null;
    const row = this.db
      .prepare(
        `SELECT cowork_session_id, dsh_session_id, synced_seq, origin, updated_at
         FROM local_dsh_session_bindings
         WHERE dsh_session_id = ?`,
      )
      .get(normalized) as BindingRow | undefined;
    return row ? rowToBinding(row) : null;
  }

  listAll(): LocalDshSessionBinding[] {
    const rows = this.db
      .prepare(
        `SELECT cowork_session_id, dsh_session_id, synced_seq, origin, updated_at
         FROM local_dsh_session_bindings
         ORDER BY updated_at DESC`,
      )
      .all() as BindingRow[];
    return rows.map(rowToBinding);
  }

  upsertBinding(input: UpsertLocalDshSessionBindingInput): LocalDshSessionBinding {
    const coworkSessionId = input.coworkSessionId.trim();
    const dshSessionId = normalizeDshSessionId(input.dshSessionId);
    const now = Date.now();
    const initialSeq = typeof input.syncedSeq === 'number' && Number.isInteger(input.syncedSeq)
      ? input.syncedSeq
      : -1;
    const origin = input.origin ?? CoworkSessionSource.Desktop;

    const existingByCowork = this.getByCoworkSessionId(coworkSessionId);
    if (existingByCowork && existingByCowork.dshSessionId !== dshSessionId) {
      // Session was rebound to a newer local DSH session (e.g. version switch/recreate).
      this.db
        .prepare('DELETE FROM local_dsh_session_bindings WHERE cowork_session_id = ?')
        .run(coworkSessionId);
    }

    const existingByDsh = this.getByDshSessionId(dshSessionId);
    if (existingByDsh && existingByDsh.coworkSessionId !== coworkSessionId) {
      this.db
        .prepare('DELETE FROM local_dsh_session_bindings WHERE dsh_session_id = ?')
        .run(dshSessionId);
    }

    this.db
      .prepare(
        `INSERT INTO local_dsh_session_bindings (cowork_session_id, dsh_session_id, synced_seq, origin, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(cowork_session_id) DO UPDATE SET
           dsh_session_id = excluded.dsh_session_id,
           synced_seq = MAX(local_dsh_session_bindings.synced_seq, excluded.synced_seq),
           updated_at = excluded.updated_at`,
      )
      .run(coworkSessionId, dshSessionId, initialSeq, origin, now);

    return this.getByCoworkSessionId(coworkSessionId) ?? {
      coworkSessionId,
      dshSessionId,
      syncedSeq: initialSeq,
      origin,
      updatedAt: now,
    };
  }

  advanceSyncedSeq(dshSessionId: string, seq: number): boolean {
    const normalized = normalizeDshSessionId(dshSessionId);
    if (!normalized || !Number.isInteger(seq) || seq < 0) return false;
    const result = this.db
      .prepare(
        `UPDATE local_dsh_session_bindings
         SET synced_seq = MAX(synced_seq, ?), updated_at = ?
         WHERE dsh_session_id = ?`,
      )
      .run(seq, Date.now(), normalized);
    return result.changes > 0;
  }

  deleteByCoworkSessionId(coworkSessionId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM local_dsh_session_bindings WHERE cowork_session_id = ?')
      .run(coworkSessionId);
    return result.changes > 0;
  }

  deleteByDshSessionId(dshSessionId: string): boolean {
    const normalized = normalizeDshSessionId(dshSessionId);
    if (!normalized) return false;
    const result = this.db
      .prepare('DELETE FROM local_dsh_session_bindings WHERE dsh_session_id = ?')
      .run(normalized);
    return result.changes > 0;
  }

  /**
   * Idempotently backfill existing `cowork_sessions` backed by `dsh:*` into
   * `local_dsh_session_bindings`, seeding `synced_seq` from the highest DSH
   * event `seq` already recorded in `cowork_messages.metadata`.
   */
  backfillFromCoworkSessions(): number {
    const hasSessionsTable = Boolean(
      this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cowork_sessions'")
        .get(),
    );
    if (!hasSessionsTable) return 0;

    const hasMessagesTable = Boolean(
      this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cowork_messages'")
        .get(),
    );

    const rows = this.db
      .prepare(
        `SELECT id, claude_session_id, scheduled_task_id, updated_at
         FROM cowork_sessions
         WHERE claude_session_id LIKE ?`,
      )
      .all(`${DSH_SESSION_ID_PREFIX}%`) as Array<{
      id: string;
      claude_session_id: string;
      scheduled_task_id: string | null;
      updated_at: number;
    }>;

    if (rows.length === 0) return 0;

    const maxSeqStmt = hasMessagesTable
      ? this.db.prepare(
          `SELECT MAX(CAST(json_extract(metadata, '$.seq') AS INTEGER)) AS max_seq
           FROM cowork_messages
           WHERE session_id = ? AND metadata IS NOT NULL`,
        )
      : null;

    const insertStmt = this.db.prepare(
      `INSERT OR IGNORE INTO local_dsh_session_bindings
       (cowork_session_id, dsh_session_id, synced_seq, origin, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    );

    let inserted = 0;
    const runBatch = this.db.transaction(() => {
      for (const row of rows) {
        const dshSessionId = normalizeDshSessionId(row.claude_session_id);
        if (!dshSessionId) continue;
        let syncedSeq = -1;
        if (maxSeqStmt) {
          try {
            const seqRow = maxSeqStmt.get(row.id) as { max_seq: number | null } | undefined;
            if (typeof seqRow?.max_seq === 'number' && Number.isInteger(seqRow.max_seq) && seqRow.max_seq >= 0) {
              syncedSeq = seqRow.max_seq;
            }
          } catch {
            // Fallback to -1 if legacy metadata contains invalid JSON.
          }
        }
        const origin = row.scheduled_task_id
          ? CoworkSessionSource.Scheduled
          : CoworkSessionSource.Desktop;
        const res = insertStmt.run(
          row.id,
          dshSessionId,
          syncedSeq,
          origin,
          row.updated_at || Date.now(),
        );
        inserted += res.changes;
      }
    });
    runBatch();
    return inserted;
  }
}
