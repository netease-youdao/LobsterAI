// Pure, Electron-free memory management facade combining `LobsterMemoryService`
// (`MEMORY.md` + FTS5 per agent) with legacy SQLite `user_memories` and
// `user_memory_sources` provenance and audit inspection.

import type Database from 'better-sqlite3';

import { AgentId } from '../../shared/agent/constants';
import {
  type CoworkMemoryStats,
  CoworkMemoryStatus,
  CoworkMemoryStatusFilter,
  type CoworkUserMemoryEntry,
  type CoworkUserMemorySourceSummary,
} from '../../shared/cowork/constants';
import {
  getMemoryBaseFingerprint,
  type LobsterMemoryService,
  type MemoryEntry,
  memoryFingerprint,
  sanitizeAgentId,
  WorkspaceFileName,
} from './lobsterMemoryService';

export const LEGACY_MEMORY_ID_PREFIX = 'legacy:';

export interface ListMemoryEntriesOptions {
  agentId?: string;
  query?: string;
  status?: CoworkMemoryStatusFilter;
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
}

export interface CreateMemoryEntryOptions {
  agentId?: string;
  text: string;
  section?: string;
  confidence?: number;
  isExplicit?: boolean;
}

export interface UpdateMemoryEntryOptions {
  agentId?: string;
  id: string;
  text?: string;
  confidence?: number;
  status?: CoworkMemoryStatus;
  isExplicit?: boolean;
}

export interface DeleteMemoryEntryOptions {
  agentId?: string;
  id: string;
}

export interface DeleteMemoryEntriesOptions {
  agentId?: string;
  ids: string[];
}

interface SqliteMemoryRow {
  id: string;
  text: string;
  fingerprint: string;
  confidence: number;
  is_explicit: number;
  status: string;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}

interface SqliteMemorySourceRow {
  id: string;
  memory_id: string;
  session_id: string | null;
  message_id: string | null;
  role: string;
  is_active: number;
  created_at: number;
  session_title?: string | null;
}

interface LegacyMemoryMetadata {
  row: SqliteMemoryRow;
  status: CoworkMemoryStatus;
  confidence: number;
  isExplicit: boolean;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  sources: CoworkUserMemorySourceSummary;
  sourceLabel?: string;
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return Boolean(row);
}

function getTableColumns(db: Database.Database, tableName: string): Set<string> {
  if (!tableExists(db, tableName)) return new Set();
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
  return new Set(rows.map((r) => String(r.name ?? '')).filter(Boolean));
}

function normalizeStatus(raw: string): CoworkMemoryStatus {
  if (raw === CoworkMemoryStatus.Deleted) return CoworkMemoryStatus.Deleted;
  if (raw === CoworkMemoryStatus.Stale) return CoworkMemoryStatus.Stale;
  return CoworkMemoryStatus.Created;
}

function buildSourceSummary(rows: SqliteMemorySourceRow[]): {
  summary: CoworkUserMemorySourceSummary;
  label?: string;
} {
  const roles: string[] = [];
  const roleSet = new Set<string>();
  const sessionIds: string[] = [];
  const sessionIdSet = new Set<string>();
  const sessionTitles: string[] = [];
  const sessionTitleSet = new Set<string>();
  let activeCount = 0;

  for (const row of rows) {
    if (row.is_active) activeCount += 1;
    const role = (row.role || '').trim();
    if (role && !roleSet.has(role)) {
      roleSet.add(role);
      roles.push(role);
    }
    const sessionId = (row.session_id || '').trim();
    if (sessionId && !sessionIdSet.has(sessionId)) {
      sessionIdSet.add(sessionId);
      sessionIds.push(sessionId);
    }
    const sessionTitle = (row.session_title || '').trim();
    if (sessionTitle && !sessionTitleSet.has(sessionTitle)) {
      sessionTitleSet.add(sessionTitle);
      sessionTitles.push(sessionTitle);
    }
  }

  const latest = rows[0];
  const latestSessionId = latest?.session_id?.trim() || null;
  const latestSessionTitle = latest?.session_title?.trim() || null;
  const latestMessageId = latest?.message_id?.trim() || null;
  const latestRole = latest?.role?.trim() || null;
  const latestCreatedAt =
    latest && Number.isFinite(Number(latest.created_at)) ? Number(latest.created_at) : null;

  let label: string | undefined;
  if (latestSessionTitle) {
    label = latestSessionTitle;
  } else if (latestSessionId) {
    label = `session:${latestSessionId.slice(0, 8)}`;
  } else if (latestRole) {
    label = latestRole;
  }

  return {
    summary: {
      count: rows.length,
      activeCount,
      roles,
      sessionIds,
      ...(sessionTitles.length > 0 ? { sessionTitles } : {}),
      latestSessionId,
      latestSessionTitle,
      latestMessageId,
      latestRole,
      latestCreatedAt,
    },
    label,
  };
}

function loadLegacyMemoryIndex(db: Database.Database | null): {
  activeByFingerprint: Map<string, LegacyMemoryMetadata>;
  staleEntries: LegacyMemoryMetadata[];
  deletedEntries: LegacyMemoryMetadata[];
} {
  const activeByFingerprint = new Map<string, LegacyMemoryMetadata>();
  const staleEntries: LegacyMemoryMetadata[] = [];
  const deletedEntries: LegacyMemoryMetadata[] = [];

  if (!db || !tableExists(db, 'user_memories')) {
    return { activeByFingerprint, staleEntries, deletedEntries };
  }

  const memoryCols = getTableColumns(db, 'user_memories');
  if (!memoryCols.has('id') || !memoryCols.has('text')) {
    return { activeByFingerprint, staleEntries, deletedEntries };
  }

  const selectCols = [
    'id',
    'text',
    memoryCols.has('fingerprint') ? 'fingerprint' : "'' AS fingerprint",
    memoryCols.has('confidence') ? 'confidence' : '0.75 AS confidence',
    memoryCols.has('is_explicit') ? 'is_explicit' : '1 AS is_explicit',
    memoryCols.has('status') ? 'status' : "'created' AS status",
    memoryCols.has('created_at') ? 'created_at' : '0 AS created_at',
    memoryCols.has('updated_at') ? 'updated_at' : '0 AS updated_at',
    memoryCols.has('last_used_at') ? 'last_used_at' : 'NULL AS last_used_at',
  ].join(', ');
  const orderCol = memoryCols.has('updated_at') ? 'updated_at DESC, ROWID DESC' : 'ROWID DESC';

  const memoryRows = db
    .prepare(`SELECT ${selectCols} FROM user_memories ORDER BY ${orderCol}`)
    .all() as SqliteMemoryRow[];

  const sourcesByMemoryId = new Map<string, SqliteMemorySourceRow[]>();
  if (tableExists(db, 'user_memory_sources')) {
    const sourceCols = getTableColumns(db, 'user_memory_sources');
    const hasSessions =
      tableExists(db, 'cowork_sessions')
      && getTableColumns(db, 'cowork_sessions').has('id')
      && getTableColumns(db, 'cowork_sessions').has('title');
    if (sourceCols.has('memory_id')) {
      const sourceQuery = hasSessions
        ? `
          SELECT s.id, s.memory_id, s.session_id, s.message_id, s.role, s.is_active, s.created_at,
                 cs.title AS session_title
          FROM user_memory_sources s
          LEFT JOIN cowork_sessions cs ON cs.id = s.session_id
          ORDER BY s.created_at DESC, s.ROWID DESC
        `
        : `
          SELECT id, memory_id, session_id, message_id, role, is_active, created_at
          FROM user_memory_sources
          ORDER BY created_at DESC, ROWID DESC
        `;
      const sourceRows = db.prepare(sourceQuery).all() as SqliteMemorySourceRow[];
      for (const sourceRow of sourceRows) {
        const list = sourcesByMemoryId.get(sourceRow.memory_id);
        if (list) list.push(sourceRow);
        else sourcesByMemoryId.set(sourceRow.memory_id, [sourceRow]);
      }
    }
  }

  for (const row of memoryRows) {
    const status = normalizeStatus(row.status);
    const { summary, label } = buildSourceSummary(sourcesByMemoryId.get(row.id) ?? []);
    const meta: LegacyMemoryMetadata = {
      row,
      status,
      confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : 0.75,
      isExplicit: Boolean(row.is_explicit),
      createdAt: Number(row.created_at) || 0,
      updatedAt: Number(row.updated_at) || 0,
      lastUsedAt: row.last_used_at === null || row.last_used_at === undefined ? null : Number(row.last_used_at),
      sources: summary,
      sourceLabel: label,
    };

    if (status === CoworkMemoryStatus.Created) {
      const computedFp = memoryFingerprint(row.text);
      if (!activeByFingerprint.has(computedFp)) {
        activeByFingerprint.set(computedFp, meta);
      }
      const storedFp = (row.fingerprint || '').trim();
      if (storedFp && !activeByFingerprint.has(storedFp)) {
        activeByFingerprint.set(storedFp, meta);
      }
    } else if (status === CoworkMemoryStatus.Stale) {
      staleEntries.push(meta);
    } else {
      deletedEntries.push(meta);
    }
  }

  return { activeByFingerprint, staleEntries, deletedEntries };
}

function enrichActiveEntry(
  entry: MemoryEntry,
  agentId: string,
  activeByFingerprint: Map<string, LegacyMemoryMetadata>,
): CoworkUserMemoryEntry {
  const baseFp = getMemoryBaseFingerprint(entry.id);
  const meta = activeByFingerprint.get(baseFp) ?? activeByFingerprint.get(memoryFingerprint(entry.text));
  const projectKeyPart = entry.projectKeys && entry.projectKeys.length > 0
    ? { projectKeys: entry.projectKeys }
    : {};
  if (!meta) {
    return {
      id: entry.id,
      text: entry.text,
      ...(entry.section ? { section: entry.section } : {}),
      ...projectKeyPart,
      agentId,
      status: CoworkMemoryStatus.Created,
      isExplicit: true,
    };
  }

  return {
    id: entry.id,
    text: entry.text,
    ...(entry.section ? { section: entry.section } : {}),
    ...projectKeyPart,
    agentId,
    status: CoworkMemoryStatus.Created,
    confidence: meta.confidence,
    isExplicit: meta.isExplicit,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    lastUsedAt: meta.lastUsedAt,
    sourceCount: meta.sources.count,
    ...(meta.sourceLabel ? { sourceLabel: meta.sourceLabel } : {}),
    ...(meta.sources.count > 0 ? { sources: meta.sources } : {}),
  };
}

function toLegacyReadOnlyEntry(meta: LegacyMemoryMetadata): CoworkUserMemoryEntry {
  return {
    id: `${LEGACY_MEMORY_ID_PREFIX}${meta.row.id}`,
    text: meta.row.text,
    agentId: AgentId.Main,
    status: meta.status,
    confidence: meta.confidence,
    isExplicit: meta.isExplicit,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    lastUsedAt: meta.lastUsedAt,
    sourceCount: meta.sources.count,
    ...(meta.sourceLabel ? { sourceLabel: meta.sourceLabel } : {}),
    ...(meta.sources.count > 0 ? { sources: meta.sources } : {}),
    isLegacyReadOnly: true,
  };
}

export function matchesMemoryQuery(entry: CoworkUserMemoryEntry, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  if (entry.text.toLowerCase().includes(normalizedQuery)) return true;
  if (entry.section && entry.section.toLowerCase().includes(normalizedQuery)) return true;
  if (entry.projectKeys?.some((key) => key.toLowerCase().includes(normalizedQuery))) return true;
  if (entry.sourceLabel && entry.sourceLabel.toLowerCase().includes(normalizedQuery)) return true;
  if (entry.status && entry.status.toLowerCase().includes(normalizedQuery)) return true;
  if (entry.sources) {
    if (entry.sources.roles.some((role) => role.toLowerCase().includes(normalizedQuery))) return true;
    if (entry.sources.sessionIds.some((id) => id.toLowerCase().includes(normalizedQuery))) return true;
    if (entry.sources.sessionTitles?.some((title) => title.toLowerCase().includes(normalizedQuery))) {
      return true;
    }
  }
  return false;
}

function resolveAgentId(agentId?: string): string {
  return sanitizeAgentId(agentId || AgentId.Main);
}

function findMatchingSqliteMemoryIds(
  db: Database.Database,
  targetFingerprint: string,
  statuses: readonly CoworkMemoryStatus[],
): string[] {
  if (!tableExists(db, 'user_memories')) return [];
  const cols = getTableColumns(db, 'user_memories');
  if (!cols.has('id') || !cols.has('text')) return [];

  const statusPlaceholders = statuses.map(() => '?').join(', ');
  const statusFilter = cols.has('status') ? `WHERE status IN (${statusPlaceholders})` : '';
  const selectCols = cols.has('fingerprint') ? 'id, text, fingerprint' : "id, text, '' AS fingerprint";
  const rows = db
    .prepare(`SELECT ${selectCols} FROM user_memories ${statusFilter}`)
    .all(...(cols.has('status') ? statuses : [])) as Array<{
      id: string;
      text: string;
      fingerprint: string;
    }>;

  const matchedIds: string[] = [];
  for (const row of rows) {
    if (row.fingerprint === targetFingerprint || memoryFingerprint(row.text) === targetFingerprint) {
      matchedIds.push(row.id);
    }
  }
  return matchedIds;
}

export function listManagedMemoryEntries(
  memoryService: LobsterMemoryService,
  db: Database.Database | null,
  input: ListMemoryEntriesOptions = {},
): CoworkUserMemoryEntry[] {
  const agentId = resolveAgentId(input.agentId);
  const statusFilter = input.status || CoworkMemoryStatusFilter.All;
  const includeDeleted = Boolean(input.includeDeleted);
  const normalizedQuery = (input.query || '').trim().toLowerCase();

  const isMainAgent = agentId === AgentId.Main;
  const legacyIndex = isMainAgent
    ? loadLegacyMemoryIndex(db)
    : {
        activeByFingerprint: new Map<string, LegacyMemoryMetadata>(),
        staleEntries: [],
        deletedEntries: [],
      };

  const results: CoworkUserMemoryEntry[] = [];

  const shouldIncludeCreated =
    statusFilter === CoworkMemoryStatusFilter.All
    || statusFilter === CoworkMemoryStatusFilter.Created;
  const shouldIncludeStale =
    isMainAgent
    && (statusFilter === CoworkMemoryStatusFilter.Stale
      || (statusFilter === CoworkMemoryStatusFilter.All && includeDeleted));
  const shouldIncludeDeleted =
    isMainAgent
    && (statusFilter === CoworkMemoryStatusFilter.Deleted
      || (statusFilter === CoworkMemoryStatusFilter.All && includeDeleted));

  if (shouldIncludeCreated) {
    const activeEntries = memoryService.listMemories(agentId);
    for (const entry of activeEntries) {
      results.push(enrichActiveEntry(entry, agentId, legacyIndex.activeByFingerprint));
    }
  }

  if (shouldIncludeStale) {
    for (const meta of legacyIndex.staleEntries) {
      results.push(toLegacyReadOnlyEntry(meta));
    }
  }

  if (shouldIncludeDeleted) {
    for (const meta of legacyIndex.deletedEntries) {
      results.push(toLegacyReadOnlyEntry(meta));
    }
  }

  const filtered = normalizedQuery
    ? results.filter((entry) => matchesMemoryQuery(entry, normalizedQuery))
    : results;

  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  if (input.limit !== undefined && Number.isFinite(input.limit)) {
    const limit = Math.max(1, Math.floor(input.limit));
    return filtered.slice(offset, offset + limit);
  }
  return offset > 0 ? filtered.slice(offset) : filtered;
}

export function getManagedMemoryStats(
  memoryService: LobsterMemoryService,
  db: Database.Database | null,
  options: { agentId?: string } = {},
): CoworkMemoryStats {
  const agentId = resolveAgentId(options.agentId);
  const activeEntries = memoryService.listMemories(agentId);

  if (agentId !== AgentId.Main) {
    return {
      total: activeEntries.length,
      created: activeEntries.length,
      stale: 0,
      deleted: 0,
      explicit: activeEntries.length,
      implicit: 0,
    };
  }

  const legacyIndex = loadLegacyMemoryIndex(db);
  let explicit = 0;
  let implicit = 0;

  for (const entry of activeEntries) {
    const enriched = enrichActiveEntry(entry, agentId, legacyIndex.activeByFingerprint);
    if (enriched.isExplicit === false) implicit += 1;
    else explicit += 1;
  }

  for (const meta of legacyIndex.staleEntries) {
    if (meta.isExplicit) explicit += 1;
    else implicit += 1;
  }

  for (const meta of legacyIndex.deletedEntries) {
    if (meta.isExplicit) explicit += 1;
    else implicit += 1;
  }

  const created = activeEntries.length;
  const stale = legacyIndex.staleEntries.length;
  const deleted = legacyIndex.deletedEntries.length;

  return {
    total: created + stale + deleted,
    created,
    stale,
    deleted,
    explicit,
    implicit,
  };
}

export function createManagedMemoryEntry(
  memoryService: LobsterMemoryService,
  db: Database.Database | null,
  input: CreateMemoryEntryOptions,
): CoworkUserMemoryEntry {
  const agentId = resolveAgentId(input.agentId);
  const entry = memoryService.addMemory(agentId, input.text, input.section);
  if (agentId === AgentId.Main) {
    const { activeByFingerprint } = loadLegacyMemoryIndex(db);
    return enrichActiveEntry(entry, agentId, activeByFingerprint);
  }
  return {
    id: entry.id,
    text: entry.text,
    ...(entry.section ? { section: entry.section } : {}),
    ...(entry.projectKeys && entry.projectKeys.length > 0 ? { projectKeys: entry.projectKeys } : {}),
    agentId,
    status: CoworkMemoryStatus.Created,
    isExplicit: input.isExplicit ?? true,
  };
}

export function updateManagedMemoryEntry(
  memoryService: LobsterMemoryService,
  db: Database.Database | null,
  input: UpdateMemoryEntryOptions,
): CoworkUserMemoryEntry | null {
  if (input.id.startsWith(LEGACY_MEMORY_ID_PREFIX)) {
    throw new Error('Legacy read-only memory entries cannot be edited');
  }
  if (!input.text || !input.text.trim()) {
    throw new Error('Memory text is required');
  }

  const agentId = resolveAgentId(input.agentId);
  const beforeEntries = memoryService.listMemories(agentId);
  const previous = beforeEntries.find((e) => e.id === input.id);
  if (!previous) return null;

  const oldBaseFp = getMemoryBaseFingerprint(previous.id);
  const updated = memoryService.updateMemory(agentId, input.id, input.text);
  if (!updated) return null;

  // Keep SQLite provenance aligned when editing a main-agent memory that originated in SQLite.
  if (agentId === AgentId.Main && db && tableExists(db, 'user_memories')) {
    const afterEntries = memoryService.listMemories(agentId);
    const stillHasOldFp = afterEntries.some((e) => getMemoryBaseFingerprint(e.id) === oldBaseFp);
    const newBaseFp = getMemoryBaseFingerprint(updated.id);
    if (!stillHasOldFp && oldBaseFp !== newBaseFp) {
      const matchedIds = findMatchingSqliteMemoryIds(db, oldBaseFp, [CoworkMemoryStatus.Created]);
      if (matchedIds.length > 0) {
        const now = Date.now();
        const cols = getTableColumns(db, 'user_memories');
        const updateStmt = db.prepare(
          cols.has('fingerprint')
            ? 'UPDATE user_memories SET text = ?, fingerprint = ?, updated_at = ? WHERE id = ?'
            : 'UPDATE user_memories SET text = ?, updated_at = ? WHERE id = ?',
        );
        const runTx = db.transaction(() => {
          for (const rowId of matchedIds) {
            if (cols.has('fingerprint')) {
              updateStmt.run(updated.text, newBaseFp, now, rowId);
            } else {
              updateStmt.run(updated.text, now, rowId);
            }
          }
        });
        runTx();
      }
    }
  }

  if (agentId === AgentId.Main) {
    const { activeByFingerprint } = loadLegacyMemoryIndex(db);
    return enrichActiveEntry(updated, agentId, activeByFingerprint);
  }
  return {
    id: updated.id,
    text: updated.text,
    ...(updated.section ? { section: updated.section } : {}),
    ...(updated.projectKeys && updated.projectKeys.length > 0 ? { projectKeys: updated.projectKeys } : {}),
    agentId,
    status: CoworkMemoryStatus.Created,
    isExplicit: true,
  };
}

export function deleteManagedMemoryEntry(
  memoryService: LobsterMemoryService,
  db: Database.Database | null,
  input: DeleteMemoryEntryOptions,
): boolean {
  return deleteManagedMemoryEntries(memoryService, db, {
    agentId: input.agentId,
    ids: [input.id],
  }) > 0;
}

export function deleteManagedMemoryEntries(
  memoryService: LobsterMemoryService,
  db: Database.Database | null,
  input: DeleteMemoryEntriesOptions,
): number {
  const normalizedIds = Array.from(
    new Set((input.ids ?? []).map((id) => id.trim()).filter(Boolean)),
  );
  if (normalizedIds.length === 0) return 0;
  if (normalizedIds.some((id) => id.startsWith(LEGACY_MEMORY_ID_PREFIX))) {
    throw new Error('Legacy read-only memory entries cannot be deleted');
  }

  const agentId = resolveAgentId(input.agentId);
  const beforeEntries = memoryService.listMemories(agentId);
  const idSet = new Set(normalizedIds);
  const targetEntries = beforeEntries.filter((entry) => idSet.has(entry.id));
  if (targetEntries.length === 0) return 0;

  const targetBaseFps = new Set(targetEntries.map((entry) => getMemoryBaseFingerprint(entry.id)));
  const deletedCount = memoryService.deleteMemories(agentId, normalizedIds);
  if (deletedCount === 0) return 0;

  // Sync delete status into SQLite `user_memories` / `user_memory_sources` if no duplicate remains.
  if (agentId === AgentId.Main && db && tableExists(db, 'user_memories')) {
    const remainingBaseFps = new Set(
      memoryService.listMemories(agentId).map((entry) => getMemoryBaseFingerprint(entry.id)),
    );
    const removedFps = [...targetBaseFps].filter((fp) => !remainingBaseFps.has(fp));
    if (removedFps.length > 0) {
      const matchedIds = new Set<string>();
      for (const fp of removedFps) {
        for (const rowId of findMatchingSqliteMemoryIds(db, fp, [
          CoworkMemoryStatus.Created,
          CoworkMemoryStatus.Stale,
        ])) {
          matchedIds.add(rowId);
        }
      }
      if (matchedIds.size > 0) {
        const now = Date.now();
        const hasSources = tableExists(db, 'user_memory_sources');
        const updateMemoryStmt = db.prepare(
          'UPDATE user_memories SET status = ?, updated_at = ? WHERE id = ?',
        );
        const deactivateSourceStmt = hasSources
          ? db.prepare('UPDATE user_memory_sources SET is_active = 0 WHERE memory_id = ?')
          : null;
        const runTx = db.transaction(() => {
          for (const rowId of matchedIds) {
            updateMemoryStmt.run(CoworkMemoryStatus.Deleted, now, rowId);
            deactivateSourceStmt?.run(rowId);
          }
        });
        runTx();
      }
    }
  }

  return deletedCount;
}

export function readManagedMemoryRaw(
  memoryService: LobsterMemoryService,
  options: { agentId?: string } = {},
): string {
  const agentId = resolveAgentId(options.agentId);
  return memoryService.readWorkspaceFile(agentId, WorkspaceFileName.Memory);
}

export function writeManagedMemoryRaw(
  memoryService: LobsterMemoryService,
  input: { agentId?: string; content: string },
): void {
  const agentId = resolveAgentId(input.agentId);
  memoryService.writeWorkspaceFile(agentId, WorkspaceFileName.Memory, input.content);
}
