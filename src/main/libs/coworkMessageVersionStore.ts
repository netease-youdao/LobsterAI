import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import type { CoworkMessageVersionInfo } from '../../shared/cowork/messageEdit';
import {
  type CoworkMessageEditOperation,
  type ProjectionSnapshot,
  readProjectionSnapshot,
  writeProjectionSnapshot,
} from './coworkMessageEditStore';

interface VersionRow {
  id: string;
  session_id: string;
  fork_key: string;
  ordinal: number;
  active: number;
  head_message_id: string;
  leaf_entry_id: string | null;
  snapshot_json: string | null;
}

/** A switch that has been decided locally but may not have reached the gateway yet. */
export interface CoworkMessageVersionSwitch {
  sessionId: string;
  fromVersionId: string;
  toVersionId: string;
  /** Gateway branch tip of the version being left. */
  activeLeafEntryId: string;
  /** Gateway branch tip of the version being shown. */
  targetLeafEntryId: string;
}

/**
 * Every committed message edit leaves the replaced conversation behind as a
 * version. Versions that share a fork point form a group; exactly one of them
 * is live in `cowork_messages`, the others are kept as snapshots together with
 * the gateway branch tip that restores their context.
 */
export class CoworkMessageVersionStore {
  constructor(
    private readonly db: Database.Database,
    private readonly write: <T>(sessionId: string, operation: () => T) => T,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS cowork_message_versions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES cowork_sessions(id) ON DELETE CASCADE,
      fork_key TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      active INTEGER NOT NULL,
      head_message_id TEXT NOT NULL,
      leaf_entry_id TEXT,
      snapshot_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cowork_message_versions_group ON cowork_message_versions(session_id, fork_key);
    CREATE TABLE IF NOT EXISTS cowork_message_version_switches (
      session_id TEXT PRIMARY KEY REFERENCES cowork_sessions(id) ON DELETE CASCADE,
      switch_json TEXT NOT NULL
    );`);
  }

  private group(sessionId: string, forkKey: string): VersionRow[] {
    return this.db.prepare('SELECT * FROM cowork_message_versions WHERE session_id = ? AND fork_key = ? ORDER BY ordinal')
      .all(sessionId, forkKey) as VersionRow[];
  }

  private row(id: string): VersionRow | undefined {
    return this.db.prepare('SELECT * FROM cowork_message_versions WHERE id = ?').get(id) as VersionRow | undefined;
  }

  /** The switcher reads its position from the head message, so it follows every normal message load. */
  private stampHead(sessionId: string, messageId: string, info: CoworkMessageVersionInfo): void {
    const message = this.db.prepare('SELECT metadata FROM cowork_messages WHERE session_id = ? AND id = ?')
      .get(sessionId, messageId) as { metadata: string | null } | undefined;
    if (!message) return;
    this.db.prepare('UPDATE cowork_messages SET metadata = ? WHERE session_id = ? AND id = ?')
      .run(JSON.stringify({ ...JSON.parse(message.metadata ?? '{}'), messageVersion: info }), sessionId, messageId);
  }

  /** Files the conversation a committed edit replaced, and makes the resent message the live version. */
  recordEdit(operation: CoworkMessageEditOperation): void {
    this.write(operation.sessionId, () => {
      const edit = this.db.prepare('SELECT snapshot_json FROM cowork_message_edits WHERE operation_id = ?')
        .get(operation.operationId) as { snapshot_json: string } | undefined;
      const head = this.db.prepare(`SELECT id FROM cowork_messages
        WHERE session_id = ? AND type = 'user' AND json_extract(metadata, '$.openclawRequestId') = ?`)
        .get(operation.sessionId, operation.runId) as { id: string } | undefined;
      if (!edit || !head) throw new Error('The committed edit cannot be filed as a version.');
      const forkKey = operation.prefixEntryIds.at(-1) ?? '';
      const versions = this.group(operation.sessionId, forkKey);
      const replaced = versions.find(version => version.active);
      let lastOrdinal = versions.at(-1)?.ordinal ?? 0;
      if (replaced) {
        this.db.prepare(`UPDATE cowork_message_versions
          SET active = 0, head_message_id = ?, leaf_entry_id = ?, snapshot_json = ? WHERE id = ?`)
          .run(operation.messageId, operation.originalLeafId, edit.snapshot_json, replaced.id);
      } else {
        lastOrdinal += 1;
        this.db.prepare('INSERT INTO cowork_message_versions VALUES (?, ?, ?, ?, 0, ?, ?, ?)')
          .run(randomUUID(), operation.sessionId, forkKey, lastOrdinal,
            operation.messageId, operation.originalLeafId, edit.snapshot_json);
      }
      this.db.prepare('INSERT INTO cowork_message_versions VALUES (?, ?, ?, ?, 1, ?, NULL, NULL)')
        .run(randomUUID(), operation.sessionId, forkKey, lastOrdinal + 1, head.id);
      const count = versions.length + (replaced ? 1 : 2);
      // The version now owns the replaced conversation; a second copy would only grow the database.
      this.db.prepare('DELETE FROM cowork_message_edits WHERE operation_id = ?').run(operation.operationId);
      this.stampHead(operation.sessionId, head.id, { index: count, count });
    });
  }

  pendingSwitch(sessionId: string): CoworkMessageVersionSwitch | null {
    const row = this.db.prepare('SELECT switch_json FROM cowork_message_version_switches WHERE session_id = ?')
      .get(sessionId) as { switch_json: string } | undefined;
    return row ? JSON.parse(row.switch_json) as CoworkMessageVersionSwitch : null;
  }

  /** Records the intent before the gateway is touched, so an interrupted switch can be finished. */
  beginSwitch(sessionId: string, headMessageId: string, targetIndex: number, activeLeafEntryId: string): CoworkMessageVersionSwitch {
    return this.write(sessionId, () => {
      if (this.pendingSwitch(sessionId)) throw new Error('A version switch is already pending.');
      const from = this.db.prepare(`SELECT * FROM cowork_message_versions
        WHERE session_id = ? AND head_message_id = ? AND active = 1`).get(sessionId, headMessageId) as VersionRow | undefined;
      const to = from ? this.group(sessionId, from.fork_key)[targetIndex - 1] : undefined;
      if (!from || !to || to.active || !to.snapshot_json || !to.leaf_entry_id) throw new Error('Unknown message version.');
      const pending: CoworkMessageVersionSwitch = { sessionId, fromVersionId: from.id, toVersionId: to.id,
        activeLeafEntryId, targetLeafEntryId: to.leaf_entry_id };
      this.db.prepare('INSERT INTO cowork_message_version_switches VALUES (?, ?)').run(sessionId, JSON.stringify(pending));
      return pending;
    });
  }

  cancelSwitch(sessionId: string): void {
    this.db.prepare('DELETE FROM cowork_message_version_switches WHERE session_id = ?').run(sessionId);
  }

  /**
   * Swaps the live conversation for the target version's snapshot once the
   * gateway is on its branch. Returns the message that now heads the version.
   */
  applySwitch(sessionId: string): string | undefined {
    return this.write(sessionId, () => {
      const pending = this.pendingSwitch(sessionId);
      if (!pending) return undefined;
      const from = this.row(pending.fromVersionId);
      const to = this.row(pending.toVersionId);
      const head = from ? this.db.prepare('SELECT sequence FROM cowork_messages WHERE session_id = ? AND id = ?')
        .get(sessionId, from.head_message_id) as { sequence: number | null } | undefined : undefined;
      if (!from || !to?.snapshot_json || head?.sequence == null) throw new Error('The version switch can no longer be applied.');
      const target = JSON.parse(to.snapshot_json) as ProjectionSnapshot;
      const live = readProjectionSnapshot(this.db, sessionId, head.sequence);
      this.db.prepare('UPDATE cowork_message_versions SET active = 0, leaf_entry_id = ?, snapshot_json = ? WHERE id = ?')
        .run(pending.activeLeafEntryId, JSON.stringify(live), from.id);
      // Looking at another version is not new activity: the session keeps its place in the list.
      writeProjectionSnapshot(this.db, sessionId, Math.min(head.sequence, target.messages[0].sequence), target,
        { keepUpdatedAt: true });
      this.db.prepare('UPDATE cowork_message_versions SET active = 1, leaf_entry_id = NULL, snapshot_json = NULL WHERE id = ?')
        .run(to.id);
      const versions = this.group(sessionId, to.fork_key);
      this.stampHead(sessionId, to.head_message_id, { index: versions.findIndex(version => version.id === to.id) + 1, count: versions.length });
      this.cancelSwitch(sessionId);
      return to.head_message_id;
    });
  }
}
