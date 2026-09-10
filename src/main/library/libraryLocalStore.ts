import type Database from 'better-sqlite3';
import crypto from 'crypto';

import {
  type LibraryArtifactType,
  LibraryAvailability,
  LibraryCategory,
  LibraryErrorCode,
  LibraryFavoriteScope,
  LibraryItemKind,
  LibraryLimits,
  LibraryLocalProtocol,
  LibraryLocalSort,
  LibraryOrigin,
  LibraryRelationKind,
} from '../../shared/library/constants';
import {
  getLibraryLocalOrderKey,
  isLibraryIdentifier,
  isLibraryLocalOrderKey,
  isLibraryTimestamp,
  LibraryLocalDataError,
  type LibraryLocalOrderKey,
} from '../../shared/library/localOrdering';
import type {
  LibraryArtifactCandidate,
  LibraryFavoriteInput,
  LibraryGetLocalItemsData,
  LibraryLocalCounts,
  LibraryLocalDetailData,
  LibraryLocalListData,
  LibraryLocalListOptions,
  LibraryLocalTaskGroupsData,
  LibraryLocalTaskGroupsOptions,
  LibraryLocalTaskItemsData,
  LibraryLocalTaskItemsOptions,
  LibrarySessionRef,
  LibrarySessionRelation,
  LocalArtifactItem,
} from '../../shared/library/types';
import type { RemoteOwner } from '../../shared/remote/constants';
import { sessionVisibilitySql } from '../agentOwnership';
import { listLibraryLocalTaskGroups, listLibraryLocalTaskItems } from './libraryLocalTaskQuery';

interface LocalArtifactRow {
  id: string;
  path_key: string;
  file_path: string;
  file_name: string;
  extension: string;
  artifact_type: LibraryArtifactType;
  category: Exclude<LibraryCategory, 'all'>;
  client_source_key: string | null;
  size_bytes: number | null;
  file_mtime_ms: number | null;
  sort_time_ms: number;
  availability: LocalArtifactItem['availability'];
  origin: LocalArtifactItem['origin'];
  first_seen_at: number;
  created_at: number;
}

interface RelationRow {
  artifact_id: string;
  session_id: string;
  relation_kind: LibrarySessionRelation['relationKind'];
  first_related_at: number;
  last_related_at: number;
  last_message_id: string | null;
  session_artifact_id: string | null;
  title: string;
  agent_id: string | null;
  session_updated_at: number;
  session_created_at: number;
}

interface OwnedLocalArtifactRow extends LocalArtifactRow, RelationRow {}

export interface LibraryLocalCursor extends LibraryLocalOrderKey {
  version: typeof LibraryLocalProtocol.Version;
  sort: typeof LibraryLocalSort.RecentTask;
}

export interface LibraryIndexedFile {
  pathKey: string;
  filePath: string;
  fileName: string;
  extension: string;
  artifactType: LibraryArtifactType;
  category: Exclude<LibraryCategory, 'all'>;
  fileIdentity?: string;
  clientSourceKey?: string;
  sizeBytes?: number;
  fileMtimeMs?: number;
  availability: LocalArtifactItem['availability'];
  origin: LocalArtifactItem['origin'];
  verifiedAt: number;
}

export interface LibraryTrackedArtifact {
  itemId: string;
  filePath: string;
  availability: LocalArtifactItem['availability'];
  lastVerifiedAt: number;
  isFavorite: boolean;
}

export interface LibraryRelocationCandidate {
  itemId: string;
  filePath: string;
}

export type LibraryStoredLocalArtifact = Omit<LocalArtifactItem, 'latestSession'> & {
  latestSession?: LibrarySessionRef;
};

const visibleTaskRelation = (actor: RemoteOwner | null | undefined) => {
  const access = sessionVisibilitySql(actor, 'visible_session');
  return { sql: `EXISTS (
    SELECT 1 FROM library_artifact_sessions visible_relation
    JOIN cowork_sessions visible_session ON visible_session.id=visible_relation.session_id
    WHERE visible_relation.artifact_id=a.id AND (${access.sql})
  )`, parameters: access.parameters };
};

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, match => `\\${match}`);

const RELATION_OWNER_ORDER = 'r.last_related_at DESC, s.updated_at DESC, r.session_id COLLATE BINARY DESC';

const requireIdentifier = (value: unknown): void => {
  if (!isLibraryIdentifier(value)) {
    throw new LibraryLocalDataError(LibraryErrorCode.InvalidInput, 'Invalid library identifier.');
  }
};

const requireTimestamp = (value: unknown): void => {
  if (!isLibraryTimestamp(value)) {
    throw new LibraryLocalDataError(LibraryErrorCode.InvalidLocalData, 'Invalid local library timestamp.');
  }
};

export const encodeLibraryLocalCursor = (key: LibraryLocalOrderKey): string => {
  if (!isLibraryLocalOrderKey(key)) {
    throw new LibraryLocalDataError(LibraryErrorCode.InvalidLocalData, 'Invalid local library ordering data.');
  }
  const cursor: LibraryLocalCursor = {
    ...key,
    version: LibraryLocalProtocol.Version,
    sort: LibraryLocalSort.RecentTask,
  };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
};

export const decodeLibraryLocalCursor = (cursor?: string): LibraryLocalCursor | null => {
  if (!cursor) return null;
  if (cursor.length > LibraryLimits.MaxLocalCursorLength || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!isLibraryLocalOrderKey(parsed)) return null;
    const value = parsed as LibraryLocalCursor;
    if (value.version !== LibraryLocalProtocol.Version || value.sort !== LibraryLocalSort.RecentTask) return null;
    return value;
  } catch {
    return null;
  }
};

export class LibraryLocalStore {
  constructor(private readonly db: Database.Database) {}

  listTaskGroups(options: LibraryLocalTaskGroupsOptions = {}, actor?: RemoteOwner | null): LibraryLocalTaskGroupsData {
    return listLibraryLocalTaskGroups(this.db, options, itemIds => this.getVisibleItems(itemIds, actor).items, actor);
  }

  listTaskItems(options: LibraryLocalTaskItemsOptions, actor?: RemoteOwner | null): LibraryLocalTaskItemsData {
    return listLibraryLocalTaskItems(this.db, options, itemIds => this.getVisibleItems(itemIds, actor).items, actor);
  }

  list(options: LibraryLocalListOptions = {}, actor?: RemoteOwner | null): LibraryLocalListData {
    if (options.sort !== undefined && options.sort !== LibraryLocalSort.RecentTask) {
      throw new LibraryLocalDataError(LibraryErrorCode.InvalidInput, 'Invalid local library sort.');
    }
    const pageSize = Math.max(
      1,
      Math.min(options.pageSize ?? LibraryLimits.DefaultPageSize, LibraryLimits.MaxPageSize),
    );
    const keyword = options.keyword?.trim().slice(0, LibraryLimits.MaxKeywordLength) ?? '';
    const cursor = decodeLibraryLocalCursor(options.cursor);
    if (options.cursor !== undefined && !cursor) {
      throw new LibraryLocalDataError(LibraryErrorCode.InvalidCursor, 'Invalid local library cursor.');
    }
    const visible = visibleTaskRelation(actor);
    const access = sessionVisibilitySql(actor);
    const where: string[] = [visible.sql];
    const params: Array<string | number> = [...visible.parameters];

    if (options.category && options.category !== LibraryCategory.All) {
      where.push('a.category = ?');
      params.push(options.category);
    }
    if (keyword) {
      const pattern = `%${escapeLike(keyword)}%`;
      where.push(`(
        a.file_name LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR a.extension LIKE ? ESCAPE '\\' COLLATE NOCASE
      )`);
      params.push(pattern, pattern);
    }
    if (options.favoritesOnly) {
      where.push(`EXISTS (
        SELECT 1 FROM library_favorites f
        WHERE f.owner_scope = ? AND f.item_kind = ? AND f.item_id = a.id
      )`);
      params.push(LibraryFavoriteScope.LocalDevice, LibraryItemKind.LocalArtifact);
    }

    const baseWhere = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const countRow = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN a.availability <> ? THEN 1 ELSE 0 END), 0) AS total,
        COALESCE(SUM(CASE WHEN a.availability = ? THEN 1 ELSE 0 END), 0) AS available,
        COALESCE(SUM(CASE WHEN a.availability = ? THEN 1 ELSE 0 END), 0) AS missing
      FROM library_local_artifacts a
      ${baseWhere}
    `).get(
      LibraryAvailability.Missing,
      LibraryAvailability.Available,
      LibraryAvailability.Missing,
      ...params,
    ) as {
      total: number;
      available: number;
      missing: number;
    };

    const pageWhere = [...where];
    const pageParams = [...params];
    pageWhere.push('a.availability <> ?');
    pageParams.push(LibraryAvailability.Missing);
    const pageWhereSql = pageWhere.length > 0 ? `WHERE ${pageWhere.join(' AND ')}` : '';
    const cursorWhere = cursor ? `WHERE
      session_updated_at < ?
      OR (session_updated_at = ? AND session_created_at < ?)
      OR (session_updated_at = ? AND session_created_at = ? AND session_id COLLATE BINARY < ?)
      OR (session_updated_at = ? AND session_created_at = ? AND session_id COLLATE BINARY = ? AND sort_time_ms < ?)
      OR (session_updated_at = ? AND session_created_at = ? AND session_id COLLATE BINARY = ? AND sort_time_ms = ? AND id COLLATE BINARY < ?)
    ` : '';
    pageParams.push(...access.parameters);
    if (cursor) {
      const { sessionUpdatedAt: updatedAt, sessionCreatedAt: createdAt, sessionId, artifactSortTime, itemId } = cursor;
      pageParams.push(
        updatedAt,
        updatedAt, createdAt,
        updatedAt, createdAt, sessionId,
        updatedAt, createdAt, sessionId, artifactSortTime,
        updatedAt, createdAt, sessionId, artifactSortTime, itemId,
      );
    }
    const rows = this.db.prepare(`
      WITH filtered_artifacts AS (
        SELECT a.* FROM library_local_artifacts a ${pageWhereSql}
      ), ranked_relations AS (
        SELECT r.artifact_id, r.session_id, r.relation_kind, r.first_related_at,
          r.last_related_at, r.last_message_id, r.session_artifact_id,
          s.title, s.agent_id, s.created_at AS session_created_at,
          s.updated_at AS session_updated_at,
          ROW_NUMBER() OVER (
            PARTITION BY r.artifact_id ORDER BY ${RELATION_OWNER_ORDER}
          ) AS relation_rank
        FROM filtered_artifacts fa
        JOIN library_artifact_sessions r ON r.artifact_id = fa.id
        JOIN cowork_sessions s ON s.id = r.session_id
        WHERE ${access.sql}
      ), owned_items AS (
        SELECT fa.*, rr.* FROM filtered_artifacts fa
        JOIN ranked_relations rr ON rr.artifact_id = fa.id AND rr.relation_rank = 1
      )
      SELECT * FROM owned_items
      ${cursorWhere}
      ORDER BY session_updated_at DESC, session_created_at DESC,
        session_id COLLATE BINARY DESC, sort_time_ms DESC, id COLLATE BINARY DESC
      LIMIT ?
    `).all(...pageParams, pageSize + 1) as OwnedLocalArtifactRow[];
    for (const row of rows) {
      requireTimestamp(row.sort_time_ms);
      this.toSessionRef(row);
      if (!isLibraryIdentifier(row.id)) {
        throw new LibraryLocalDataError(LibraryErrorCode.InvalidLocalData, 'Invalid local library ordering identifier.');
      }
    }
    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
    const list = this.hydrateVisibleRows(pageRows, pageRows, actor);
    const last = list[list.length - 1];

    const counts: LibraryLocalCounts = {
      total: Number(countRow.total),
      available: Number(countRow.available),
      missing: Number(countRow.missing),
    };
    return {
      protocolVersion: LibraryLocalProtocol.Version,
      sort: LibraryLocalSort.RecentTask,
      list,
      hasMore,
      counts,
      ...(hasMore && last
        ? { nextCursor: encodeLibraryLocalCursor(getLibraryLocalOrderKey(last)) }
        : {}),
    };
  }

  getDetail(itemId: string, actor?: RemoteOwner | null): LibraryLocalDetailData | null {
    const visible = visibleTaskRelation(actor);
    requireIdentifier(itemId);
    const row = this.db.prepare(`
      SELECT a.*
      FROM library_local_artifacts a
      WHERE a.id = ?
        AND a.availability <> ?
        AND ${visible.sql}
    `).get(itemId, LibraryAvailability.Missing, ...visible.parameters) as LocalArtifactRow | undefined;
    if (!row) return null;
    const item = this.hydrateVisibleRows([row], undefined, actor)[0];
    if (!item) return null;
    const sessions = this.readRelations([itemId], actor).map(this.toSessionRelation);
    return { item, sessions };
  }

  getVisibleItem(itemId: string, actor?: RemoteOwner | null): LocalArtifactItem | null {
    const visible = visibleTaskRelation(actor);
    requireIdentifier(itemId);
    const row = this.db.prepare(`
      SELECT a.*
      FROM library_local_artifacts a
      WHERE a.id = ?
        AND a.availability <> ?
        AND ${visible.sql}
    `).get(itemId, LibraryAvailability.Missing, ...visible.parameters) as LocalArtifactRow | undefined;
    if (!row) return null;
    return this.hydrateVisibleRows([row], undefined, actor)[0] ?? null;
  }

  getVisibleItems(itemIds: string[], actor?: RemoteOwner | null): LibraryGetLocalItemsData {
    const visible = visibleTaskRelation(actor);
    if (itemIds.length === 0) return { items: [], unavailableItemIds: [] };
    itemIds.forEach(requireIdentifier);
    const placeholders = itemIds.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT a.*
      FROM library_local_artifacts a
      WHERE a.id IN (${placeholders})
        AND a.availability <> ?
        AND ${visible.sql}
    `).all(...itemIds, LibraryAvailability.Missing, ...visible.parameters) as LocalArtifactRow[];
    const items = this.hydrateVisibleRows(rows, undefined, actor);
    const visibleItemIds = new Set(items.map(item => item.itemId));
    return {
      items,
      unavailableItemIds: itemIds.filter(itemId => !visibleItemIds.has(itemId)),
    };
  }

  getItem(itemId: string): LibraryStoredLocalArtifact | null {
    const row = this.db.prepare('SELECT * FROM library_local_artifacts WHERE id = ?')
      .get(itemId) as LocalArtifactRow | undefined;
    return row ? this.hydrateRows([row])[0] : null;
  }

  resolvePath(itemId: string, actor?: RemoteOwner | null): string | null {
    if (actor !== undefined) return this.getVisibleItem(itemId, actor)?.filePath ?? null;
    const row = this.db.prepare('SELECT file_path FROM library_local_artifacts WHERE id = ?')
      .get(itemId) as { file_path: string } | undefined;
    return row?.file_path ?? null;
  }

  sessionExists(sessionId: string, actor?: RemoteOwner | null): boolean {
    const access = sessionVisibilitySql(actor);
    return Boolean(this.db.prepare(`SELECT 1 FROM cowork_sessions s WHERE s.id = ? AND (${access.sql})`).get(sessionId, ...access.parameters));
  }

  listSessionIdsWithArtifactRelations(sessionIds: string[]): string[] {
    const result: string[] = [];
    const uniqueIds = [...new Set(sessionIds)];
    for (let offset = 0; offset < uniqueIds.length; offset += LibraryLimits.MaxTargetItemIds) {
      const batch = uniqueIds.slice(offset, offset + LibraryLimits.MaxTargetItemIds);
      const placeholders = batch.map(() => '?').join(',');
      const rows = this.db.prepare(`
        SELECT DISTINCT session_id FROM library_artifact_sessions
        WHERE session_id IN (${placeholders})
      `).all(...batch) as Array<{ session_id: string }>;
      result.push(...rows.map(row => row.session_id));
    }
    return result;
  }

  getSessionCwd(sessionId: string): string | null {
    const row = this.db.prepare('SELECT cwd FROM cowork_sessions WHERE id = ?').get(sessionId) as {
      cwd: string;
    } | undefined;
    return row?.cwd ?? null;
  }

  resolveCloudSession(
    sessionId?: string,
    clientSourceKey?: string,
    actor?: RemoteOwner | null,
  ): LibrarySessionRef | undefined {
    const access = sessionVisibilitySql(actor);
    if (sessionId) {
      const session = this.db.prepare(`
        SELECT id, title, agent_id, created_at, updated_at FROM cowork_sessions s WHERE id = ? AND (${access.sql})
      `).get(sessionId, ...access.parameters) as {
        id: string;
        title: string;
        agent_id: string | null;
        created_at: number;
        updated_at: number;
      } | undefined;
      if (session) {
        requireTimestamp(session.created_at);
        requireTimestamp(session.updated_at);
        if (!isLibraryIdentifier(session.id)) {
          throw new LibraryLocalDataError(LibraryErrorCode.InvalidLocalData, 'Invalid local library session identifier.');
        }
        return {
          sessionId: session.id,
          title: session.title,
          agentId: session.agent_id ?? 'main',
          createdAt: session.created_at,
          updatedAt: session.updated_at,
          lastRelatedAt: session.updated_at,
        };
      }
    }
    if (!clientSourceKey) return undefined;
    const artifact = this.db.prepare(`
      SELECT id FROM library_local_artifacts
      WHERE client_source_key = ?
      ORDER BY sort_time_ms DESC, id DESC
      LIMIT 1
    `).get(clientSourceKey) as { id: string } | undefined;
    if (!artifact) return undefined;
    const relation = this.readRelations([artifact.id], actor)[0];
    return relation ? this.toSessionRef(relation) : undefined;
  }

  upsertFile(
    file: LibraryIndexedFile,
    candidate: LibraryArtifactCandidate,
  ): LocalArtifactItem | null;
  upsertFile(file: LibraryIndexedFile, candidate?: undefined): LibraryStoredLocalArtifact;
  upsertFile(
    file: LibraryIndexedFile,
    candidate?: LibraryArtifactCandidate,
  ): LibraryStoredLocalArtifact | LocalArtifactItem | null {
    if (candidate) requireIdentifier(candidate.sessionId);
    const now = Date.now();
    const existing = this.db.prepare(
      'SELECT id, first_seen_at FROM library_local_artifacts WHERE path_key = ?',
    ).get(file.pathKey) as { id: string; first_seen_at: number } | undefined;
    const itemId = existing?.id ?? crypto.randomUUID();
    const firstSeenAt = existing?.first_seen_at ?? now;

    const committed = this.db.transaction(() => {
      if (candidate && !this.sessionExists(candidate.sessionId)) return false;

      this.db.prepare(`
        INSERT INTO library_local_artifacts (
          id, path_key, file_path, file_name, extension, artifact_type, category,
          file_identity, client_source_key, size_bytes, file_mtime_ms, sort_time_ms,
          availability, origin, first_seen_at, last_seen_at, last_verified_at,
          missing_since, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
        ON CONFLICT(path_key) DO UPDATE SET
          file_path = excluded.file_path,
          file_name = excluded.file_name,
          extension = excluded.extension,
          artifact_type = excluded.artifact_type,
          category = excluded.category,
          file_identity = excluded.file_identity,
          client_source_key = COALESCE(excluded.client_source_key, library_local_artifacts.client_source_key),
          size_bytes = excluded.size_bytes,
          file_mtime_ms = excluded.file_mtime_ms,
          sort_time_ms = excluded.sort_time_ms,
          availability = excluded.availability,
          origin = CASE
            WHEN excluded.origin = ? THEN excluded.origin
            ELSE library_local_artifacts.origin
          END,
          last_seen_at = excluded.last_seen_at,
          last_verified_at = excluded.last_verified_at,
          missing_since = NULL,
          updated_at = excluded.updated_at
      `).run(
        itemId,
        file.pathKey,
        file.filePath,
        file.fileName,
        file.extension,
        file.artifactType,
        file.category,
        file.fileIdentity ?? null,
        file.clientSourceKey ?? null,
        file.sizeBytes ?? null,
        file.fileMtimeMs ?? null,
        file.fileMtimeMs ?? firstSeenAt,
        file.availability,
        file.origin,
        firstSeenAt,
        now,
        file.verifiedAt,
        firstSeenAt,
        now,
        LibraryOrigin.Manual,
      );

      if (candidate) {
        this.db.prepare(`
          INSERT INTO library_artifact_sessions (
            artifact_id, session_id, relation_kind, first_related_at, last_related_at,
            last_message_id, session_artifact_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(artifact_id, session_id) DO UPDATE SET
            relation_kind = CASE
              WHEN library_artifact_sessions.relation_kind = ?
                OR excluded.relation_kind = ? THEN ?
              WHEN library_artifact_sessions.relation_kind = ?
                OR excluded.relation_kind = ? THEN ?
              ELSE ?
            END,
            last_related_at = MAX(library_artifact_sessions.last_related_at, excluded.last_related_at),
            last_message_id = CASE
              WHEN excluded.last_related_at >= library_artifact_sessions.last_related_at
              THEN excluded.last_message_id ELSE library_artifact_sessions.last_message_id
            END,
            session_artifact_id = CASE
              WHEN excluded.last_related_at >= library_artifact_sessions.last_related_at
              THEN excluded.session_artifact_id ELSE library_artifact_sessions.session_artifact_id
            END,
            updated_at = excluded.updated_at
        `).run(
          itemId,
          candidate.sessionId,
          candidate.relationKind,
          candidate.relatedAt,
          candidate.relatedAt,
          candidate.messageId ?? null,
          candidate.sessionArtifactId ?? null,
          now,
          now,
          LibraryRelationKind.Created,
          LibraryRelationKind.Created,
          LibraryRelationKind.Created,
          LibraryRelationKind.Modified,
          LibraryRelationKind.Modified,
          LibraryRelationKind.Modified,
          LibraryRelationKind.Referenced,
        );
      }

      if (file.origin === LibraryOrigin.Manual) {
        this.db.prepare(`
          INSERT INTO library_manual_sources (path_key, file_path, added_at)
          VALUES (?, ?, ?)
          ON CONFLICT(path_key) DO UPDATE SET
            file_path = excluded.file_path,
            added_at = excluded.added_at
        `).run(file.pathKey, file.filePath, now);
      }
      return true;
    })();

    if (!committed) return null;

    const item = candidate ? this.getVisibleItem(itemId) : this.getItem(itemId);
    if (!item) throw new Error('Failed to read indexed library item.');
    return item;
  }

  setFavorite(input: LibraryFavoriteInput): void {
    const now = Date.now();
    if (input.favorite) {
      this.db.prepare(`
        INSERT INTO library_favorites (owner_scope, item_kind, item_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(owner_scope, item_kind, item_id) DO UPDATE SET updated_at = excluded.updated_at
      `).run(input.ownerScope, input.itemKind, input.itemId, now, now);
      return;
    }
    this.db.prepare(`
      DELETE FROM library_favorites
      WHERE owner_scope = ? AND item_kind = ? AND item_id = ?
    `).run(input.ownerScope, input.itemKind, input.itemId);
  }

  getFavoriteIds(ownerScope: string, itemKinds: string[]): Set<string> {
    if (itemKinds.length === 0) return new Set();
    const placeholders = itemKinds.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT item_kind, item_id FROM library_favorites
      WHERE owner_scope = ? AND item_kind IN (${placeholders})
    `).all(ownerScope, ...itemKinds) as Array<{ item_kind: string; item_id: string }>;
    return new Set(rows.map(row => `${row.item_kind}:${row.item_id}`));
  }

  deletePermanently(itemId: string): boolean {
    return this.db.transaction(() => {
      const row = this.db.prepare(
        'SELECT path_key FROM library_local_artifacts WHERE id = ?',
      ).get(itemId) as { path_key: string } | undefined;
      this.db.prepare('DELETE FROM library_artifact_sessions WHERE artifact_id = ?').run(itemId);
      this.db.prepare(`
        DELETE FROM library_favorites WHERE item_kind = ? AND item_id = ?
      `).run(LibraryItemKind.LocalArtifact, itemId);
      if (row) {
        this.db.prepare('DELETE FROM library_manual_sources WHERE path_key = ?').run(row.path_key);
      }
      const result = this.db.prepare('DELETE FROM library_local_artifacts WHERE id = ?').run(itemId);
      return result.changes > 0;
    })();
  }

  markMissing(itemId: string, verifiedAt = Date.now()): boolean {
    return this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE library_local_artifacts
        SET availability = ?, missing_since = COALESCE(missing_since, ?),
            last_verified_at = ?, updated_at = ?
        WHERE id = ? AND availability <> ?
      `).run(
        LibraryAvailability.Missing,
        verifiedAt,
        verifiedAt,
        verifiedAt,
        itemId,
        LibraryAvailability.Missing,
      );
      if (result.changes > 0) {
        this.db.prepare(`
          DELETE FROM library_favorites WHERE item_kind = ? AND item_id = ?
        `).run(LibraryItemKind.LocalArtifact, itemId);
      } else {
        this.db.prepare(`
          UPDATE library_local_artifacts SET last_verified_at = ? WHERE id = ?
        `).run(verifiedAt, itemId);
      }
      return result.changes > 0;
    })();
  }

  markPermissionDenied(itemId: string, verifiedAt = Date.now()): boolean {
    const result = this.db.prepare(`
      UPDATE library_local_artifacts
      SET availability = ?, last_verified_at = ?, missing_since = NULL, updated_at = ?
      WHERE id = ? AND availability <> ?
    `).run(
      LibraryAvailability.PermissionDenied,
      verifiedAt,
      verifiedAt,
      itemId,
      LibraryAvailability.PermissionDenied,
    );
    if (result.changes === 0) {
      this.db.prepare(`
        UPDATE library_local_artifacts SET last_verified_at = ? WHERE id = ?
      `).run(verifiedAt, itemId);
    }
    return result.changes > 0;
  }

  refreshFile(
    itemId: string,
    values: { sizeBytes: number; fileMtimeMs: number; verifiedAt?: number },
  ): boolean {
    const verifiedAt = values.verifiedAt ?? Date.now();
    const result = this.db.prepare(`
      UPDATE library_local_artifacts
      SET availability = ?, size_bytes = ?, file_mtime_ms = ?, sort_time_ms = ?,
          last_seen_at = ?, last_verified_at = ?, missing_since = NULL, updated_at = ?
      WHERE id = ?
        AND (
          availability <> ?
          OR size_bytes IS NOT ?
          OR file_mtime_ms IS NOT ?
          OR missing_since IS NOT NULL
        )
    `).run(
      LibraryAvailability.Available,
      values.sizeBytes,
      values.fileMtimeMs,
      values.fileMtimeMs,
      verifiedAt,
      verifiedAt,
      verifiedAt,
      itemId,
      LibraryAvailability.Available,
      values.sizeBytes,
      values.fileMtimeMs,
    );
    if (result.changes === 0) {
      this.db.prepare(`
        UPDATE library_local_artifacts SET last_verified_at = ? WHERE id = ?
      `).run(verifiedAt, itemId);
    }
    return result.changes > 0;
  }

  listTracked(limit?: number, verifiedBefore?: number): LibraryTrackedArtifact[] {
    const sqlLimit = limit ? 'LIMIT ?' : '';
    const rows = this.db.prepare(`
      SELECT
        a.id AS item_id,
        a.file_path,
        a.availability,
        a.last_verified_at,
        CASE WHEN EXISTS (
          SELECT 1 FROM library_favorites f
          WHERE f.owner_scope = ? AND f.item_kind = ? AND f.item_id = a.id
        ) THEN 1 ELSE 0 END AS is_favorite
      FROM library_local_artifacts a
      ${verifiedBefore === undefined ? '' : 'WHERE a.last_verified_at < ?'}
      ORDER BY a.last_verified_at ASC
      ${sqlLimit}
    `).all(
      LibraryFavoriteScope.LocalDevice,
      LibraryItemKind.LocalArtifact,
      ...(verifiedBefore === undefined ? [] : [verifiedBefore]),
      ...(limit ? [limit] : []),
    ) as Array<{
      item_id: string;
      file_path: string;
      availability: LocalArtifactItem['availability'];
      last_verified_at: number;
      is_favorite: number;
    }>;
    return rows.map(row => ({
      itemId: row.item_id,
      filePath: row.file_path,
      availability: row.availability,
      lastVerifiedAt: row.last_verified_at,
      isFavorite: row.is_favorite === 1,
    }));
  }

  findRelocationCandidates(fileIdentity: string): LibraryRelocationCandidate[] {
    const rows = this.db.prepare(`
      SELECT id AS item_id, file_path
      FROM library_local_artifacts
      WHERE file_identity = ?
      ORDER BY last_verified_at DESC, id DESC
      LIMIT 10
    `).all(fileIdentity) as Array<{ item_id: string; file_path: string }>;
    return rows.map(row => ({ itemId: row.item_id, filePath: row.file_path }));
  }

  relocateFile(itemId: string, file: LibraryIndexedFile): boolean {
    const now = Date.now();
    return this.db.transaction(() => {
      const previous = this.db.prepare(`
        SELECT path_key FROM library_local_artifacts WHERE id = ?
      `).get(itemId) as { path_key: string } | undefined;
      if (!previous) return false;
      const result = this.db.prepare(`
        UPDATE library_local_artifacts
        SET path_key = ?, file_path = ?, file_name = ?, extension = ?,
            artifact_type = ?, category = ?, file_identity = ?, client_source_key = ?,
            size_bytes = ?, file_mtime_ms = ?, sort_time_ms = ?, availability = ?,
            last_seen_at = ?, last_verified_at = ?, missing_since = NULL, updated_at = ?
        WHERE id = ?
          AND NOT EXISTS (
            SELECT 1 FROM library_local_artifacts other
            WHERE other.path_key = ? AND other.id <> ?
          )
      `).run(
        file.pathKey,
        file.filePath,
        file.fileName,
        file.extension,
        file.artifactType,
        file.category,
        file.fileIdentity ?? null,
        file.clientSourceKey ?? null,
        file.sizeBytes ?? null,
        file.fileMtimeMs ?? null,
        file.fileMtimeMs ?? now,
        file.availability,
        file.verifiedAt,
        file.verifiedAt,
        now,
        itemId,
        file.pathKey,
        itemId,
      );
      if (result.changes === 0) return false;
      const manual = this.db.prepare(`
        SELECT added_at FROM library_manual_sources WHERE path_key = ?
      `).get(previous.path_key) as { added_at: number } | undefined;
      if (manual) {
        this.db.prepare('DELETE FROM library_manual_sources WHERE path_key = ?')
          .run(previous.path_key);
        this.db.prepare(`
          INSERT INTO library_manual_sources (path_key, file_path, added_at)
          VALUES (?, ?, ?)
          ON CONFLICT(path_key) DO UPDATE SET
            file_path = excluded.file_path
        `).run(file.pathKey, file.filePath, manual.added_at);
      }
      return true;
    })();
  }

  cleanupExpiredMissing(retentionMs: number, now = Date.now()): number {
    const rows = this.db.prepare(`
      SELECT id FROM library_local_artifacts
      WHERE availability = ? AND missing_since IS NOT NULL AND missing_since < ?
    `).all(LibraryAvailability.Missing, now - retentionMs) as Array<{ id: string }>;
    for (const row of rows) this.deletePermanently(row.id);
    return rows.length;
  }

  cleanupOrphanRelations(): number {
    const result = this.db.prepare(`
      DELETE FROM library_artifact_sessions
      WHERE artifact_id NOT IN (SELECT id FROM library_local_artifacts)
         OR session_id NOT IN (SELECT id FROM cowork_sessions)
    `).run();
    return result.changes;
  }

  countByAvailability(): { tracked: number; available: number; missing: number } {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) AS tracked,
        COALESCE(SUM(CASE WHEN availability = ? THEN 1 ELSE 0 END), 0) AS available,
        COALESCE(SUM(CASE WHEN availability = ? THEN 1 ELSE 0 END), 0) AS missing
      FROM library_local_artifacts
    `).get(LibraryAvailability.Available, LibraryAvailability.Missing) as {
      tracked: number;
      available: number;
      missing: number;
    };
    return {
      tracked: Number(row.tracked),
      available: Number(row.available),
      missing: Number(row.missing),
    };
  }

  private hydrateVisibleRows(rows: LocalArtifactRow[], owners?: RelationRow[], actor?: RemoteOwner | null): LocalArtifactItem[] {
    const items = this.hydrateRows(rows, owners, actor);
    const visibleItems = items.filter((item): item is LocalArtifactItem => (
      Boolean(item.latestSession) && item.relatedSessionCount > 0
    ));
    if (visibleItems.length !== items.length) {
      throw new LibraryLocalDataError(LibraryErrorCode.InvalidLocalData, 'Local library owner projection is unavailable.');
    }
    return visibleItems;
  }

  private hydrateRows(rows: LocalArtifactRow[], owners?: RelationRow[], actor?: RemoteOwner | null): LibraryStoredLocalArtifact[] {
    if (rows.length === 0) return [];
    const itemIds = rows.map(row => row.id);
    const relationRows = this.readRelations(itemIds, actor);
    const latestByArtifact = new Map<string, LibrarySessionRef>();
    for (const owner of owners ?? []) latestByArtifact.set(owner.artifact_id, this.toSessionRef(owner));
    const relationCountByArtifact = new Map<string, number>();
    for (const relation of relationRows) {
      relationCountByArtifact.set(
        relation.artifact_id,
        (relationCountByArtifact.get(relation.artifact_id) ?? 0) + 1,
      );
      if (!latestByArtifact.has(relation.artifact_id)) {
        latestByArtifact.set(relation.artifact_id, this.toSessionRef(relation));
      }
    }
    const placeholders = itemIds.map(() => '?').join(',');
    const favoriteIds = new Set((this.db.prepare(`
      SELECT item_id FROM library_favorites
      WHERE owner_scope = ? AND item_kind = ? AND item_id IN (${placeholders})
    `).all(LibraryFavoriteScope.LocalDevice, LibraryItemKind.LocalArtifact, ...itemIds) as Array<{
      item_id: string;
    }>).map(row => row.item_id));

    return rows.map(row => {
      requireTimestamp(row.sort_time_ms);
      requireTimestamp(row.created_at);
      if (!isLibraryIdentifier(row.id)) {
        throw new LibraryLocalDataError(LibraryErrorCode.InvalidLocalData, 'Invalid local library item identifier.');
      }
      return {
        itemKind: LibraryItemKind.LocalArtifact,
        itemId: row.id,
        title: row.file_name,
        category: row.category,
        sortTime: row.sort_time_ms,
        createdAt: row.created_at,
        isFavorite: favoriteIds.has(row.id),
        ...(latestByArtifact.get(row.id) ? { latestSession: latestByArtifact.get(row.id) } : {}),
        filePath: row.file_path,
        artifactType: row.artifact_type,
        extension: row.extension,
        ...(row.size_bytes === null ? {} : { sizeBytes: row.size_bytes }),
        ...(row.file_mtime_ms === null ? {} : { fileMtimeMs: row.file_mtime_ms }),
        availability: row.availability,
        origin: row.origin,
        relatedSessionCount: relationCountByArtifact.get(row.id) ?? 0,
        ...(row.client_source_key ? { clientSourceKey: row.client_source_key } : {}),
      };
    });
  }

  private readRelations(itemIds: string[], actor?: RemoteOwner | null): RelationRow[] {
    const access = sessionVisibilitySql(actor);
    if (itemIds.length === 0) return [];
    const placeholders = itemIds.map(() => '?').join(',');
    return this.db.prepare(`
      SELECT
        r.artifact_id,
        r.session_id,
        r.relation_kind,
        r.first_related_at,
        r.last_related_at,
        r.last_message_id,
        r.session_artifact_id,
        s.title,
        s.agent_id,
        s.created_at AS session_created_at,
        s.updated_at AS session_updated_at
      FROM library_artifact_sessions r
      JOIN cowork_sessions s ON s.id = r.session_id
      WHERE r.artifact_id IN (${placeholders}) AND (${access.sql})
      ORDER BY r.artifact_id, ${RELATION_OWNER_ORDER}
    `).all(...itemIds, ...access.parameters) as RelationRow[];
  }

  private toSessionRef(row: RelationRow): LibrarySessionRef {
    requireTimestamp(row.session_created_at);
    requireTimestamp(row.session_updated_at);
    requireTimestamp(row.last_related_at);
    if (!isLibraryIdentifier(row.session_id)) {
      throw new LibraryLocalDataError(LibraryErrorCode.InvalidLocalData, 'Invalid local library session identifier.');
    }
    return {
      sessionId: row.session_id,
      title: row.title,
      agentId: row.agent_id ?? 'main',
      createdAt: row.session_created_at,
      updatedAt: row.session_updated_at,
      lastRelatedAt: row.last_related_at,
      ...(row.last_message_id ? { lastMessageId: row.last_message_id } : {}),
      ...(row.session_artifact_id ? { sessionArtifactId: row.session_artifact_id } : {}),
    };
  }

  private readonly toSessionRelation = (row: RelationRow): LibrarySessionRelation => ({
    ...this.toSessionRef(row),
    relationKind: row.relation_kind ?? LibraryRelationKind.Referenced,
    firstRelatedAt: row.first_related_at,
  });
}
