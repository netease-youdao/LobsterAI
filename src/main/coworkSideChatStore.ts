import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

import { getCoworkLlmTrace } from '../shared/cowork/llmTurnUsage';
import {
  type CoworkSideChat,
  type CoworkSideChatMessage,
  CoworkSideChatMessageType,
  CoworkSideChatStatus,
  type CoworkSideChatSummary,
  normalizeCoworkSideChatTitle,
} from '../shared/cowork/sideChat';

interface SideChatRow {
  id: string;
  parent_session_id: string;
  dsh_session_id: string | null;
  title: string;
  status: string;
  forked_from_message_id: string | null;
  forked_at_seq: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  message_count?: number;
}

interface SideChatMessageRow {
  id: string;
  side_chat_id: string;
  type: string;
  content: string;
  metadata: string | null;
  created_at: number;
}

export interface CreateCoworkSideChatInput {
  id?: string;
  parentSessionId: string;
  dshSessionId?: string | null;
  title: string;
  forkedFromMessageId?: string | null;
  forkedAtSeq?: number | null;
  createdAt?: number;
}

export interface UpdateCoworkSideChatPatch {
  dshSessionId?: string | null;
  title?: string;
  status?: CoworkSideChatStatus;
  forkedFromMessageId?: string | null;
  forkedAtSeq?: number | null;
  lastError?: string | null;
  touchUpdatedAt?: boolean;
}

export interface AddCoworkSideChatMessageInput {
  id?: string;
  type: CoworkSideChatMessageType;
  content: string;
  metadata?: Record<string, unknown>;
  timestamp?: number;
}

function parseMetadata(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function toSummary(row: SideChatRow, messageCountFallback = 0): CoworkSideChatSummary {
  const status = row.status === CoworkSideChatStatus.Running
    || row.status === CoworkSideChatStatus.Error
    ? row.status
    : CoworkSideChatStatus.Idle;
  return {
    id: row.id,
    parentSessionId: row.parent_session_id,
    dshSessionId: row.dsh_session_id,
    title: row.title,
    status,
    forkedFromMessageId: row.forked_from_message_id,
    forkedAtSeq: typeof row.forked_at_seq === 'number' ? row.forked_at_seq : null,
    lastError: row.last_error,
    messageCount: typeof row.message_count === 'number' ? row.message_count : messageCountFallback,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: SideChatMessageRow): CoworkSideChatMessage {
  return {
    id: row.id,
    sideChatId: row.side_chat_id,
    type: row.type as CoworkSideChatMessageType,
    content: row.content,
    metadata: parseMetadata(row.metadata),
    timestamp: row.created_at,
  };
}

export class CoworkSideChatStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initializeTables();
  }

  private initializeTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cowork_side_chats (
        id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL,
        dsh_session_id TEXT,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        forked_from_message_id TEXT,
        forked_at_seq INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cowork_side_chats_parent_updated
        ON cowork_side_chats(parent_session_id, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_cowork_side_chats_dsh_session
        ON cowork_side_chats(dsh_session_id);

      CREATE TABLE IF NOT EXISTS cowork_side_chat_messages (
        id TEXT PRIMARY KEY,
        side_chat_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        sequence INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_cowork_side_chat_messages_chat_seq
        ON cowork_side_chat_messages(side_chat_id, sequence ASC, created_at ASC);
    `);
  }

  resetRunningStatusesOnStartup(): number {
    const result = this.db
      .prepare('UPDATE cowork_side_chats SET status = ? WHERE status = ?')
      .run(CoworkSideChatStatus.Idle, CoworkSideChatStatus.Running);
    return result.changes;
  }

  createSideChat(input: CreateCoworkSideChatInput): CoworkSideChat {
    const id = input.id?.trim() || `sc-${randomUUID()}`;
    const now = typeof input.createdAt === 'number' ? input.createdAt : Date.now();
    const title = normalizeCoworkSideChatTitle(input.title) || 'Side chat';

    this.db
      .prepare(
        `INSERT INTO cowork_side_chats (
          id, parent_session_id, dsh_session_id, title, status,
          forked_from_message_id, forked_at_seq, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        id,
        input.parentSessionId,
        input.dshSessionId ?? null,
        title,
        CoworkSideChatStatus.Idle,
        input.forkedFromMessageId ?? null,
        input.forkedAtSeq ?? null,
        now,
        now,
      );

    return {
      id,
      parentSessionId: input.parentSessionId,
      dshSessionId: input.dshSessionId ?? null,
      title,
      status: CoworkSideChatStatus.Idle,
      forkedFromMessageId: input.forkedFromMessageId ?? null,
      forkedAtSeq: input.forkedAtSeq ?? null,
      lastError: null,
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
  }

  getSideChatSummary(sideChatId: string): CoworkSideChatSummary | null {
    const row = this.db
      .prepare(
        `SELECT sc.*,
          (SELECT COUNT(*) FROM cowork_side_chat_messages m WHERE m.side_chat_id = sc.id) AS message_count
         FROM cowork_side_chats sc
         WHERE sc.id = ?`,
      )
      .get(sideChatId) as SideChatRow | undefined;
    return row ? toSummary(row) : null;
  }

  getSideChat(sideChatId: string): CoworkSideChat | null {
    const summary = this.getSideChatSummary(sideChatId);
    if (!summary) return null;
    const messageRows = this.db
      .prepare(
        `SELECT id, side_chat_id, type, content, metadata, created_at
         FROM cowork_side_chat_messages
         WHERE side_chat_id = ?
         ORDER BY COALESCE(sequence, 0) ASC, created_at ASC, rowid ASC`,
      )
      .all(sideChatId) as SideChatMessageRow[];
    const messages = messageRows.map(toMessage);
    return {
      ...summary,
      messageCount: messages.length,
      messages,
    };
  }

  listSideChats(parentSessionId: string): CoworkSideChatSummary[] {
    const rows = this.db
      .prepare(
        `SELECT sc.*,
          (SELECT COUNT(*) FROM cowork_side_chat_messages m WHERE m.side_chat_id = sc.id) AS message_count
         FROM cowork_side_chats sc
         WHERE sc.parent_session_id = ?
         ORDER BY sc.updated_at DESC, sc.created_at DESC`,
      )
      .all(parentSessionId) as SideChatRow[];
    return rows.map((row) => toSummary(row));
  }

  findByDshSessionId(dshSessionId: string): CoworkSideChatSummary | null {
    const trimmed = dshSessionId.trim();
    if (!trimmed) return null;
    const row = this.db
      .prepare(
        `SELECT sc.*,
          (SELECT COUNT(*) FROM cowork_side_chat_messages m WHERE m.side_chat_id = sc.id) AS message_count
         FROM cowork_side_chats sc
         WHERE sc.dsh_session_id = ?
         LIMIT 1`,
      )
      .get(trimmed) as SideChatRow | undefined;
    return row ? toSummary(row) : null;
  }

  updateSideChat(sideChatId: string, patch: UpdateCoworkSideChatPatch): CoworkSideChatSummary | null {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (patch.dshSessionId !== undefined) {
      sets.push('dsh_session_id = ?');
      values.push(patch.dshSessionId);
    }
    if (patch.title !== undefined) {
      const normalized = normalizeCoworkSideChatTitle(patch.title);
      if (normalized) {
        sets.push('title = ?');
        values.push(normalized);
      }
    }
    if (patch.status !== undefined) {
      sets.push('status = ?');
      values.push(patch.status);
    }
    if (patch.forkedFromMessageId !== undefined) {
      sets.push('forked_from_message_id = ?');
      values.push(patch.forkedFromMessageId);
    }
    if (patch.forkedAtSeq !== undefined) {
      sets.push('forked_at_seq = ?');
      values.push(patch.forkedAtSeq);
    }
    if (patch.lastError !== undefined) {
      sets.push('last_error = ?');
      values.push(patch.lastError);
    }
    if (patch.touchUpdatedAt !== false) {
      sets.push('updated_at = ?');
      values.push(Date.now());
    }

    if (sets.length === 0) {
      return this.getSideChatSummary(sideChatId);
    }

    values.push(sideChatId);
    this.db.prepare(`UPDATE cowork_side_chats SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getSideChatSummary(sideChatId);
  }

  addMessage(sideChatId: string, input: AddCoworkSideChatMessageInput): CoworkSideChatMessage {
    const id = input.id?.trim() || `scm-${randomUUID()}`;
    const timestamp = typeof input.timestamp === 'number' ? input.timestamp : Date.now();
    const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;

    const seqRow = this.db
      .prepare('SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM cowork_side_chat_messages WHERE side_chat_id = ?')
      .get(sideChatId) as { max_seq: number } | undefined;
    const nextSequence = (seqRow?.max_seq ?? 0) + 1;

    this.db
      .prepare(
        `INSERT INTO cowork_side_chat_messages (
          id, side_chat_id, type, content, metadata, created_at, sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, sideChatId, input.type, input.content, metadataJson, timestamp, nextSequence);

    this.db
      .prepare('UPDATE cowork_side_chats SET updated_at = ? WHERE id = ?')
      .run(timestamp, sideChatId);

    return {
      id,
      sideChatId,
      type: input.type,
      content: input.content,
      metadata: input.metadata,
      timestamp,
    };
  }

  updateMessageContent(
    sideChatId: string,
    messageId: string,
    content: string,
    metadataPatch?: Record<string, unknown>,
  ): void {
    const existing = this.db
      .prepare('SELECT metadata FROM cowork_side_chat_messages WHERE id = ? AND side_chat_id = ?')
      .get(messageId, sideChatId) as { metadata: string | null } | undefined;
    if (!existing) return;

    const mergedMeta = metadataPatch
      ? { ...(parseMetadata(existing.metadata) ?? {}), ...metadataPatch }
      : parseMetadata(existing.metadata);
    const metadataJson = mergedMeta ? JSON.stringify(mergedMeta) : null;

    this.db
      .prepare(
        'UPDATE cowork_side_chat_messages SET content = ?, metadata = ? WHERE id = ? AND side_chat_id = ?',
      )
      .run(content, metadataJson, messageId, sideChatId);
    this.db
      .prepare('UPDATE cowork_side_chats SET updated_at = ? WHERE id = ?')
      .run(Date.now(), sideChatId);
  }

  deleteMessage(sideChatId: string, messageId: string): void {
    this.db
      .prepare('DELETE FROM cowork_side_chat_messages WHERE id = ? AND side_chat_id = ?')
      .run(messageId, sideChatId);
  }

  getMessage(sideChatId: string, messageId: string): CoworkSideChatMessage | null {
    const row = this.db
      .prepare(
        `SELECT id, side_chat_id, type, content, metadata, created_at
         FROM cowork_side_chat_messages
         WHERE id = ? AND side_chat_id = ?`,
      )
      .get(messageId, sideChatId) as SideChatMessageRow | undefined;
    return row ? toMessage(row) : null;
  }

  findMessageById(messageId: string): CoworkSideChatMessage | null {
    const row = this.db
      .prepare(
        `SELECT id, side_chat_id, type, content, metadata, created_at
         FROM cowork_side_chat_messages
         WHERE id = ?
         LIMIT 1`,
      )
      .get(messageId) as SideChatMessageRow | undefined;
    return row ? toMessage(row) : null;
  }

  getLatestUserMessage(sideChatId: string): CoworkSideChatMessage | null {
    const row = this.db
      .prepare(
        `SELECT id, side_chat_id, type, content, metadata, created_at
         FROM cowork_side_chat_messages
         WHERE side_chat_id = ? AND type = ?
         ORDER BY COALESCE(sequence, 0) DESC, created_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(sideChatId, CoworkSideChatMessageType.User) as SideChatMessageRow | undefined;
    return row ? toMessage(row) : null;
  }

  findUserMessageByTrace(
    traceId: string,
    sideChatId?: string,
  ): { sideChatId: string; message: CoworkSideChatMessage } | null {
    const trimmed = traceId.trim();
    if (!trimmed) return null;
    const rows = sideChatId
      ? (this.db
          .prepare(
            `SELECT id, side_chat_id, type, content, metadata, created_at
             FROM cowork_side_chat_messages
             WHERE side_chat_id = ? AND type = ? AND metadata IS NOT NULL
             ORDER BY COALESCE(sequence, 0) DESC, created_at DESC, rowid DESC`,
          )
          .all(sideChatId, CoworkSideChatMessageType.User) as SideChatMessageRow[])
      : (this.db
          .prepare(
            `SELECT id, side_chat_id, type, content, metadata, created_at
             FROM cowork_side_chat_messages
             WHERE type = ? AND metadata LIKE ?
             ORDER BY created_at DESC, rowid DESC
             LIMIT 20`,
          )
          .all(CoworkSideChatMessageType.User, `%${trimmed}%`) as SideChatMessageRow[]);

    for (const row of rows) {
      const message = toMessage(row);
      const trace = getCoworkLlmTrace(message.metadata);
      if (trace?.traceId === trimmed || trace?.relatedTraceIds?.includes(trimmed)) {
        return { sideChatId: message.sideChatId, message };
      }
    }
    return null;
  }

  getRecentConversationMessages(sideChatId: string, limit: number): CoworkSideChatMessage[] {
    const safeLimit = Math.max(1, Math.floor(limit));
    const rows = this.db
      .prepare(
        `SELECT id, side_chat_id, type, content, metadata, created_at
         FROM cowork_side_chat_messages
         WHERE side_chat_id = ?
         ORDER BY COALESCE(sequence, 0) DESC, created_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(sideChatId, safeLimit) as SideChatMessageRow[];
    return rows.reverse().map(toMessage);
  }

  updateMessageMetadata(
    sideChatId: string,
    messageId: string,
    metadataPatch: Record<string, unknown>,
  ): CoworkSideChatMessage | null {
    const existing = this.getMessage(sideChatId, messageId);
    if (!existing) return null;
    const mergedMeta = { ...(existing.metadata ?? {}), ...metadataPatch };
    this.db
      .prepare('UPDATE cowork_side_chat_messages SET metadata = ? WHERE id = ? AND side_chat_id = ?')
      .run(JSON.stringify(mergedMeta), messageId, sideChatId);
    return { ...existing, metadata: mergedMeta };
  }

  deleteSideChat(sideChatId: string): CoworkSideChatSummary | null {
    const existing = this.getSideChatSummary(sideChatId);
    if (!existing) return null;

    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM cowork_side_chat_messages WHERE side_chat_id = ?').run(sideChatId);
      this.db.prepare('DELETE FROM cowork_side_chats WHERE id = ?').run(sideChatId);
    });
    tx();
    return existing;
  }

  deleteSideChatsByParentSession(parentSessionId: string): CoworkSideChatSummary[] {
    const existing = this.listSideChats(parentSessionId);
    if (existing.length === 0) return [];

    const tx = this.db.transaction(() => {
      const deleteMessages = this.db.prepare('DELETE FROM cowork_side_chat_messages WHERE side_chat_id = ?');
      for (const item of existing) {
        deleteMessages.run(item.id);
      }
      this.db.prepare('DELETE FROM cowork_side_chats WHERE parent_session_id = ?').run(parentSessionId);
    });
    tx();
    return existing;
  }
}
