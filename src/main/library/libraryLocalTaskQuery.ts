import type Database from 'better-sqlite3';

import {
  isLibraryCategory,
  LibraryAvailability,
  LibraryCategory,
  LibraryErrorCode,
  LibraryFavoriteScope,
  LibraryGridCursorKind,
  LibraryGridLimits,
  LibraryGridProtocol,
  LibraryItemKind,
  LibraryLimits,
  LibraryLocalSort,
} from '../../shared/library/constants';
import {
  getLibraryGridQueryKey,
  isLibraryGridItemCursor,
  isLibraryGridTaskCursor,
  type LibraryGridItemCursor,
  type LibraryGridTaskCursor,
} from '../../shared/library/gridOrdering';
import { isLibraryIdentifier, isLibraryTimestamp, LibraryLocalDataError } from '../../shared/library/localOrdering';
import type {
  LibraryLocalCounts,
  LibraryLocalTaskFilters,
  LibraryLocalTaskGroupsData,
  LibraryLocalTaskGroupsOptions,
  LibraryLocalTaskItemsData,
  LibraryLocalTaskItemsOptions,
  LibrarySessionRef,
  LocalArtifactItem,
} from '../../shared/library/types';
import type { RemoteOwner } from '../../shared/remote/constants';
import { sessionVisibilitySql } from '../agentOwnership';

interface TaskRow {
  session_id: string;
  title: string;
  agent_id: string | null;
  session_created_at: number;
  session_updated_at: number;
  last_related_at: number;
  matched_file_count: number;
}

interface TaskPreviewRow extends TaskRow {
  id: string;
}

type HydrateItems = (itemIds: string[]) => LocalArtifactItem[];

const invalidInput = (message: string): never => {
  throw new LibraryLocalDataError(LibraryErrorCode.InvalidInput, message);
};

const invalidCursor = (): never => {
  throw new LibraryLocalDataError(LibraryErrorCode.InvalidCursor, 'Invalid local task cursor.');
};

const normalizeFilters = (value: unknown): LibraryLocalTaskFilters => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalidInput('Invalid local task query.');
  }
  const input = value as Record<string, unknown>;
  if (input.category !== undefined && !isLibraryCategory(input.category)) {
    return invalidInput('Invalid library category.');
  }
  if (input.keyword !== undefined && typeof input.keyword !== 'string') {
    return invalidInput('Invalid library keyword.');
  }
  if (input.favoritesOnly !== undefined && typeof input.favoritesOnly !== 'boolean') {
    return invalidInput('Invalid library favorite filter.');
  }
  if (input.sort !== undefined && input.sort !== LibraryLocalSort.RecentTask) {
    return invalidInput('Invalid local library sort.');
  }
  return {
    category: input.category as LibraryCategory | undefined,
    keyword: typeof input.keyword === 'string'
      ? input.keyword.trim().slice(0, LibraryLimits.MaxKeywordLength)
      : undefined,
    favoritesOnly: input.favoritesOnly as boolean | undefined,
  };
};

const normalizePageSize = (value: unknown, defaultValue: number, maxValue: number): number => {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return invalidInput('Invalid local task page size.');
  }
  return Math.min(value, maxValue);
};

const parseCursor = (value: unknown): unknown => {
  if (typeof value !== 'string' || value.length > LibraryLimits.MaxLocalCursorLength
    || !/^[A-Za-z0-9_-]+$/.test(value)) return invalidCursor();
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
  } catch {
    return invalidCursor();
  }
};

export const decodeLibraryGridTaskCursor = (
  value: unknown,
  filters: LibraryLocalTaskFilters,
): LibraryGridTaskCursor => {
  const cursor = parseCursor(value);
  if (!isLibraryGridTaskCursor(cursor) || cursor.queryKey !== getLibraryGridQueryKey(filters)) {
    return invalidCursor();
  }
  return cursor;
};

export const decodeLibraryGridItemCursor = (
  value: unknown,
  filters: LibraryLocalTaskFilters,
  sessionId: string,
): LibraryGridItemCursor => {
  const cursor = parseCursor(value);
  if (!isLibraryGridItemCursor(cursor) || cursor.queryKey !== getLibraryGridQueryKey(filters)
    || cursor.sessionId !== sessionId) return invalidCursor();
  return cursor;
};

export const normalizeLibraryTaskGroupsOptions = (value: unknown = {}): LibraryLocalTaskGroupsOptions => {
  const filters = normalizeFilters(value);
  const input = value as Record<string, unknown>;
  if (input.taskCursor !== undefined) decodeLibraryGridTaskCursor(input.taskCursor, filters);
  return {
    ...filters,
    taskPageSize: normalizePageSize(input.taskPageSize, LibraryGridLimits.DefaultTaskPageSize, LibraryGridLimits.MaxTaskPageSize),
    ...(typeof input.taskCursor === 'string' ? { taskCursor: input.taskCursor } : {}),
  };
};

export const normalizeLibraryTaskItemsOptions = (value: unknown): LibraryLocalTaskItemsOptions => {
  const filters = normalizeFilters(value);
  const input = value as Record<string, unknown>;
  if (!isLibraryIdentifier(input.sessionId)) return invalidInput('Invalid library session identifier.');
  if (input.itemCursor !== undefined) decodeLibraryGridItemCursor(input.itemCursor, filters, input.sessionId);
  return {
    ...filters,
    sessionId: input.sessionId,
    pageSize: normalizePageSize(input.pageSize, LibraryGridLimits.ItemPageSize, LibraryGridLimits.MaxItemPageSize),
    ...(typeof input.itemCursor === 'string' ? { itemCursor: input.itemCursor } : {}),
  };
};

const createFilter = (filters: LibraryLocalTaskFilters, actor: RemoteOwner | null | undefined) => {
  const access = sessionVisibilitySql(actor);
  const where = [`EXISTS (
    SELECT 1 FROM library_artifact_sessions r
    JOIN cowork_sessions s ON s.id = r.session_id WHERE r.artifact_id = a.id AND (${access.sql})
  )`];
  const params: Array<string | number> = [...access.parameters];
  if (filters.category && filters.category !== LibraryCategory.All) {
    where.push('a.category = ?');
    params.push(filters.category);
  }
  if (filters.keyword) {
    const pattern = `%${filters.keyword.replace(/[\\%_]/g, match => `\\${match}`)}%`;
    where.push(`(a.file_name LIKE ? ESCAPE '\\' COLLATE NOCASE OR a.extension LIKE ? ESCAPE '\\' COLLATE NOCASE)`);
    params.push(pattern, pattern);
  }
  if (filters.favoritesOnly) {
    where.push(`EXISTS (SELECT 1 FROM library_favorites f
      WHERE f.owner_scope = ? AND f.item_kind = ? AND f.item_id = a.id)`);
    params.push(LibraryFavoriteScope.LocalDevice, LibraryItemKind.LocalArtifact);
  }
  return { sql: where.join(' AND '), params };
};

// The owner is chosen across every effective relation before any requested task
// is selected. Filtering relations by session first would duplicate shared files.
const ownedItemsCte = (where: string, access: string): string => `
  filtered_artifacts AS (
    SELECT a.id, a.sort_time_ms FROM library_local_artifacts a
    WHERE ${where} AND a.availability <> ?
  ), ranked_relations AS (
    SELECT fa.id, fa.sort_time_ms, r.session_id, r.last_related_at,
      s.title, s.agent_id, s.created_at AS session_created_at, s.updated_at AS session_updated_at,
      ROW_NUMBER() OVER (PARTITION BY fa.id ORDER BY
        r.last_related_at DESC, s.updated_at DESC, r.session_id COLLATE BINARY DESC) AS owner_rank
    FROM filtered_artifacts fa
    JOIN library_artifact_sessions r ON r.artifact_id = fa.id
    JOIN cowork_sessions s ON s.id = r.session_id
    WHERE ${access}
  ), owned_items AS (SELECT * FROM ranked_relations WHERE owner_rank = 1)
`;

const toSession = (row: TaskRow): LibrarySessionRef => {
  if (!isLibraryIdentifier(row.session_id) || !isLibraryTimestamp(row.session_created_at)
    || !isLibraryTimestamp(row.session_updated_at) || !isLibraryTimestamp(row.last_related_at)
    || !Number.isSafeInteger(row.matched_file_count) || row.matched_file_count < 0) {
    throw new LibraryLocalDataError(LibraryErrorCode.InvalidLocalData, 'Invalid local task projection.');
  }
  return {
    sessionId: row.session_id,
    title: row.title,
    agentId: row.agent_id ?? 'main',
    createdAt: row.session_created_at,
    updatedAt: row.session_updated_at,
    lastRelatedAt: row.last_related_at,
  };
};

const encodeCursor = (cursor: LibraryGridTaskCursor | LibraryGridItemCursor): string => (
  Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
);

const hydrateOrderedItems = (ids: string[], hydrate: HydrateItems): LocalArtifactItem[] => {
  const byId = new Map(hydrate(ids).map(item => [item.itemId, item]));
  return ids.map(id => {
    const item = byId.get(id);
    if (!item) throw new LibraryLocalDataError(LibraryErrorCode.InvalidLocalData, 'Local task item is unavailable.');
    return item;
  });
};

export const listLibraryLocalTaskGroups = (
  db: Database.Database,
  options: LibraryLocalTaskGroupsOptions,
  hydrate: HydrateItems,
  actor?: RemoteOwner | null,
): LibraryLocalTaskGroupsData => {
  const query = normalizeLibraryTaskGroupsOptions(options);
  const filter = createFilter(query, actor);
  const access = sessionVisibilitySql(actor);
  const cursor = query.taskCursor ? decodeLibraryGridTaskCursor(query.taskCursor, query) : undefined;
  const pageSize = query.taskPageSize!;
  return db.transaction(() => {
    const counts = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN a.availability <> ? THEN 1 ELSE 0 END), 0) AS total,
      COALESCE(SUM(CASE WHEN a.availability = ? THEN 1 ELSE 0 END), 0) AS available,
      COALESCE(SUM(CASE WHEN a.availability = ? THEN 1 ELSE 0 END), 0) AS missing
      FROM library_local_artifacts a WHERE ${filter.sql}
    `).get(LibraryAvailability.Missing, LibraryAvailability.Available, LibraryAvailability.Missing, ...filter.params) as LibraryLocalCounts;
    const after = cursor ? `WHERE session_updated_at < ?
      OR (session_updated_at = ? AND session_created_at < ?)
      OR (session_updated_at = ? AND session_created_at = ? AND session_id COLLATE BINARY < ?)` : '';
    const afterParams = cursor ? [cursor.sessionUpdatedAt, cursor.sessionUpdatedAt,
      cursor.sessionCreatedAt, cursor.sessionUpdatedAt, cursor.sessionCreatedAt, cursor.sessionId] : [];
    const rows = db.prepare(`WITH ${ownedItemsCte(filter.sql, access.sql)}, task_groups AS (
      SELECT session_id, title, agent_id, session_created_at, session_updated_at,
        MAX(last_related_at) AS last_related_at, COUNT(*) AS matched_file_count
      FROM owned_items GROUP BY session_id
    ), selected_tasks AS (
      SELECT * FROM task_groups ${after}
      ORDER BY session_updated_at DESC, session_created_at DESC, session_id COLLATE BINARY DESC LIMIT ?
    ), ranked_items AS (
      SELECT oi.id, oi.session_id, ROW_NUMBER() OVER (PARTITION BY oi.session_id
        ORDER BY oi.sort_time_ms DESC, oi.id COLLATE BINARY DESC) AS file_rank
      FROM owned_items oi JOIN selected_tasks st ON st.session_id = oi.session_id
    )
    SELECT st.*, ri.id FROM selected_tasks st
    JOIN ranked_items ri ON ri.session_id = st.session_id AND ri.file_rank <= ?
    ORDER BY st.session_updated_at DESC, st.session_created_at DESC,
      st.session_id COLLATE BINARY DESC, ri.file_rank ASC
    `).all(...filter.params, LibraryAvailability.Missing, ...access.parameters, ...afterParams, pageSize + 1, LibraryGridLimits.PreviewCount) as TaskPreviewRow[];
    const bySession = new Map<string, { row: TaskRow; ids: string[] }>();
    for (const row of rows) {
      toSession(row);
      const group = bySession.get(row.session_id);
      if (group) group.ids.push(row.id);
      else bySession.set(row.session_id, { row, ids: [row.id] });
    }
    const hasMoreTasks = bySession.size > pageSize;
    const page = [...bySession.values()].slice(0, pageSize);
    const items = new Map(hydrateOrderedItems(page.flatMap(group => group.ids), hydrate).map(item => [item.itemId, item]));
    const groups = page.map(group => ({
      session: toSession(group.row),
      matchedFileCount: group.row.matched_file_count,
      previewItems: group.ids.map(id => items.get(id)!),
    }));
    const tail = groups[groups.length - 1]?.session;
    return {
      protocolVersion: LibraryGridProtocol.Version,
      sort: LibraryLocalSort.RecentTask,
      groups,
      counts,
      hasMoreTasks,
      ...(hasMoreTasks && tail ? { nextTaskCursor: encodeCursor({
        version: LibraryGridProtocol.Version,
        kind: LibraryGridCursorKind.TaskGroups,
        sort: LibraryLocalSort.RecentTask,
        queryKey: getLibraryGridQueryKey(query),
        sessionId: tail.sessionId,
        sessionCreatedAt: tail.createdAt,
        sessionUpdatedAt: tail.updatedAt,
      }) } : {}),
    };
  })();
};

export const listLibraryLocalTaskItems = (
  db: Database.Database,
  options: LibraryLocalTaskItemsOptions,
  hydrate: HydrateItems,
  actor?: RemoteOwner | null,
): LibraryLocalTaskItemsData => {
  const query = normalizeLibraryTaskItemsOptions(options);
  const filter = createFilter(query, actor);
  const access = sessionVisibilitySql(actor);
  const cursor = query.itemCursor ? decodeLibraryGridItemCursor(query.itemCursor, query, query.sessionId) : undefined;
  const pageSize = query.pageSize!;
  return db.transaction(() => {
    const row = db.prepare(`WITH ${ownedItemsCte(filter.sql, access.sql)}
      SELECT s.id AS session_id, s.title, s.agent_id, s.created_at AS session_created_at,
        s.updated_at AS session_updated_at, COALESCE(MAX(oi.last_related_at), 0) AS last_related_at,
        COUNT(oi.id) AS matched_file_count
      FROM cowork_sessions s LEFT JOIN owned_items oi ON oi.session_id = s.id
      WHERE s.id = ? AND (${access.sql}) GROUP BY s.id
    `).get(...filter.params, LibraryAvailability.Missing, ...access.parameters, query.sessionId, ...access.parameters) as TaskRow | undefined;
    if (!row) throw new LibraryLocalDataError(LibraryErrorCode.NotFound, 'Library task was not found.');
    const session = toSession(row);
    const after = cursor ? 'AND (sort_time_ms < ? OR (sort_time_ms = ? AND id COLLATE BINARY < ?))' : '';
    const afterParams = cursor ? [cursor.artifactSortTime, cursor.artifactSortTime, cursor.itemId] : [];
    const ids = db.prepare(`WITH ${ownedItemsCte(filter.sql, access.sql)}
      SELECT id FROM owned_items WHERE session_id = ? ${after}
      ORDER BY sort_time_ms DESC, id COLLATE BINARY DESC LIMIT ?
    `).all(...filter.params, LibraryAvailability.Missing, ...access.parameters, query.sessionId, ...afterParams, pageSize + 1) as Array<{ id: string }>;
    const hasMoreItems = ids.length > pageSize;
    const items = hydrateOrderedItems(ids.slice(0, pageSize).map(item => item.id), hydrate);
    const tail = items[items.length - 1];
    return {
      protocolVersion: LibraryGridProtocol.Version,
      sort: LibraryLocalSort.RecentTask,
      session,
      matchedFileCount: row.matched_file_count,
      items,
      hasMoreItems,
      ...(hasMoreItems && tail ? { nextItemCursor: encodeCursor({
        version: LibraryGridProtocol.Version,
        kind: LibraryGridCursorKind.TaskItems,
        sort: LibraryLocalSort.RecentTask,
        queryKey: getLibraryGridQueryKey(query),
        sessionId: query.sessionId,
        artifactSortTime: tail.sortTime,
        itemId: tail.itemId,
      }) } : {}),
    };
  })();
};
