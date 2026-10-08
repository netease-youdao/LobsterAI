import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  LibraryArtifactType,
  LibraryAvailability,
  LibraryCategory,
  LibraryErrorCode,
  LibraryFavoriteScope,
  LibraryGridLimits,
  LibraryGridProtocol,
  LibraryItemKind,
  LibraryLocalProtocol,
  LibraryLocalSort,
  LibraryOrigin,
  LibraryRelationKind,
} from '../../shared/library/constants';
import { getLibraryGridQueryKey } from '../../shared/library/gridOrdering';
import { compareLibraryBinaryStrings, compareLibraryLocalItems } from '../../shared/library/localOrdering';
import { LibraryLocalStore } from './libraryLocalStore';
import {
  decodeLibraryGridItemCursor,
  decodeLibraryGridTaskCursor,
  listLibraryLocalTaskGroups,
  normalizeLibraryTaskGroupsOptions,
  normalizeLibraryTaskItemsOptions,
} from './libraryLocalTaskQuery';
import { initializeLibraryTables } from './libraryMigrations';

describe('local library task grid queries', () => {
  let db: Database.Database;
  let store: LibraryLocalStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE cowork_sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, agent_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    initializeLibraryTables(db);
    store = new LibraryLocalStore(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  const session = (id: string, updatedAt = 100, createdAt = updatedAt) => {
    db.prepare('INSERT INTO cowork_sessions (id, title, agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, `Task ${id}`, 'main', createdAt, updatedAt);
  };

  const relation = (id: string, sessionId: string, relatedAt = 100) => {
    db.prepare(`INSERT INTO library_artifact_sessions (
      artifact_id, session_id, relation_kind, first_related_at, last_related_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, sessionId, LibraryRelationKind.Modified, relatedAt, relatedAt, relatedAt, relatedAt);
  };

  const files = (sessionId: string, count: number, prefix = sessionId) => {
    const insertFile = db.prepare(`INSERT INTO library_local_artifacts (
      id, path_key, file_path, file_name, extension, artifact_type, category,
      sort_time_ms, availability, origin, first_seen_at, last_seen_at, last_verified_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertRelation = db.prepare(`INSERT INTO library_artifact_sessions (
      artifact_id, session_id, relation_kind, first_related_at, last_related_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    return db.transaction(() => Array.from({ length: count }, (_, index) => {
      const id = `${prefix}-${index}`;
      insertFile.run(id, `/files/${id}.pdf`, `/files/${id}.pdf`, `${id}.pdf`, '.pdf',
        LibraryArtifactType.Document, LibraryCategory.Document, index + 0.25,
        LibraryAvailability.Available, LibraryOrigin.Conversation, 0, 0, 0, 0, 0);
      insertRelation.run(id, sessionId, LibraryRelationKind.Modified, 100, 100, 100, 100);
      return id;
    }))();
  };

  test.each([0, 1, 3, 4, 7, 24, 25, 120])('returns exact totals and only the newest three preview items for %i files', count => {
    session('task');
    files('task', count);
    const groups = store.listTaskGroups();
    expect(groups).toMatchObject({
      protocolVersion: LibraryGridProtocol.Version,
      sort: LibraryLocalSort.RecentTask,
      hasMoreTasks: false,
      counts: { total: count, available: count, missing: 0 },
    });
    expect(groups.groups).toHaveLength(count === 0 ? 0 : 1);
    if (count > 0) {
      expect(groups.groups[0].matchedFileCount).toBe(count);
      expect(groups.groups[0].previewItems.map(item => item.itemId)).toEqual(
        Array.from({ length: Math.min(count, LibraryGridLimits.PreviewCount) }, (_, index) => `task-${count - 1 - index}`),
      );
    }
    const expanded = store.listTaskItems({ sessionId: 'task' });
    expect(expanded.matchedFileCount).toBe(count);
    expect(expanded.items).toHaveLength(Math.min(count, LibraryGridLimits.ItemPageSize));
    expect(expanded.hasMoreItems).toBe(count > LibraryGridLimits.ItemPageSize);
    expect(expanded.session).toMatchObject({ sessionId: 'task', updatedAt: 100, createdAt: 100 });
  });

  test('a task with 10,000 files does not crowd out the next tasks or hydrate hidden files', () => {
    session('huge', 1_000);
    files('huge', 10_000);
    for (let index = 0; index < 9; index += 1) {
      session(`small-${index}`, 900 - index);
      files(`small-${index}`, 2);
    }
    const hydrate = vi.fn((ids: string[]) => store.getVisibleItems(ids).items);
    const prepare = db.prepare.bind(db);
    const transactionFlags: boolean[] = [];
    vi.spyOn(db, 'prepare').mockImplementation(sql => {
      transactionFlags.push(db.inTransaction);
      return prepare(sql);
    });
    const first = listLibraryLocalTaskGroups(db, {}, hydrate);
    expect(first.groups).toHaveLength(LibraryGridLimits.DefaultTaskPageSize);
    expect(first.groups[0].matchedFileCount).toBe(10_000);
    expect(first.groups[1].session.sessionId).toBe('small-0');
    expect(first.groups.flatMap(group => group.previewItems)).toHaveLength(17);
    expect(hydrate).toHaveBeenCalledOnce();
    expect(hydrate.mock.calls[0][0]).toHaveLength(17);
    expect(transactionFlags.length).toBe(5);
    expect(transactionFlags.every(Boolean)).toBe(true);
    const second = store.listTaskGroups({ taskCursor: first.nextTaskCursor });
    expect(second.groups.map(group => group.session.sessionId)).toEqual(['small-7', 'small-8']);
    expect(second.hasMoreTasks).toBe(false);
    expect(second.counts.total).toBe(10_018);
    expect(store.list().protocolVersion).toBe(LibraryLocalProtocol.Version);
    expect(store.list().list).toHaveLength(24);
    expect(store.list().list.every(item => item.latestSession.sessionId === 'huge')).toBe(true);
  });

  test('first expansion replaces three with a fresh 24-item prefix and pages the remaining task independently', () => {
    session('task');
    files('task', 120);
    const previews = store.listTaskGroups().groups[0].previewItems;
    const first = store.listTaskItems({ sessionId: 'task' });
    expect(first.items.slice(0, 3)).toEqual(previews);
    expect(first.items).toHaveLength(24);
    const gathered = [...first.items];
    let page = first;
    while (page.hasMoreItems) {
      page = store.listTaskItems({ sessionId: 'task', itemCursor: page.nextItemCursor });
      expect(page.items).toHaveLength(24);
      gathered.push(...page.items);
    }
    expect(gathered).toHaveLength(120);
    expect(new Set(gathered.map(item => item.itemId)).size).toBe(120);
    expect(gathered).toEqual([...gathered].sort(compareLibraryLocalItems));
    expect(page.nextItemCursor).toBeUndefined();
  });

  test('counts current filters, favorites and permission-denied files, excluding missing and ownerless artifacts', () => {
    session('task');
    const ids = files('task', 7);
    db.prepare('UPDATE library_local_artifacts SET availability = ? WHERE id = ?').run(LibraryAvailability.Missing, ids[0]);
    db.prepare('UPDATE library_local_artifacts SET availability = ? WHERE id = ?').run(LibraryAvailability.PermissionDenied, ids[1]);
    db.prepare('DELETE FROM library_artifact_sessions WHERE artifact_id = ?').run(ids[2]);
    db.prepare('UPDATE library_local_artifacts SET category = ?, extension = ?, file_name = ? WHERE id = ?')
      .run(LibraryCategory.Image, '.png', 'match%_image.png', ids[3]);
    for (const itemId of [ids[0], ids[1], ids[3]]) {
      store.setFavorite({ ownerScope: LibraryFavoriteScope.LocalDevice, itemKind: LibraryItemKind.LocalArtifact, itemId, favorite: true });
    }
    expect(store.listTaskGroups()).toMatchObject({
      counts: { total: 5, available: 4, missing: 1 },
      groups: [{ matchedFileCount: 5 }],
    });
    expect(store.listTaskGroups({ favoritesOnly: true })).toMatchObject({
      counts: { total: 2, available: 1, missing: 1 },
      groups: [{ matchedFileCount: 2 }],
    });
    const query = { favoritesOnly: true, category: LibraryCategory.Image, keyword: 'MATCH%_' };
    expect(store.listTaskGroups(query)).toMatchObject({ groups: [{ matchedFileCount: 1, previewItems: [{ itemId: ids[3] }] }] });
    expect(store.listTaskItems({ ...query, sessionId: 'task' })).toMatchObject({ matchedFileCount: 1, items: [{ itemId: ids[3] }] });
    expect(store.listTaskGroups({ keyword: 'absent' }).groups).toEqual([]);
  });

  test('selects the owner across all effective relations before selecting one task, and transfers ownership on deletion', () => {
    session('older', 100);
    session('newer', 200);
    const [id] = files('older', 1);
    relation(id, 'newer', 100);
    expect(store.listTaskGroups().groups).toMatchObject([{ session: { sessionId: 'newer' }, matchedFileCount: 1 }]);
    expect(store.listTaskItems({ sessionId: 'older' })).toMatchObject({ matchedFileCount: 0, items: [] });
    const owned = store.listTaskItems({ sessionId: 'newer' });
    expect(owned.items[0]).toMatchObject({ itemId: id, relatedSessionCount: 2, latestSession: { sessionId: 'newer' } });
    db.prepare('DELETE FROM cowork_sessions WHERE id = ?').run('newer');
    expect(store.listTaskGroups().groups).toMatchObject([{ session: { sessionId: 'older' }, matchedFileCount: 1 }]);
    expect(() => store.listTaskItems({ sessionId: 'newer' })).toThrow(expect.objectContaining({ code: LibraryErrorCode.NotFound }));
  });

  test('uses relation time before session activity, then UTF-8 BINARY session IDs to break owner ties', () => {
    const names = ['z', '\uE000', '😀'];
    for (const name of names) session(name, 100);
    const [id] = files(names[0], 1);
    for (const name of names.slice(1)) relation(id, name, 100);
    const orderedNames = [...names].sort(compareLibraryBinaryStrings);
    const winningId = orderedNames[orderedNames.length - 1];
    expect(store.listTaskGroups().groups[0].session.sessionId).toBe(winningId);
    db.prepare('UPDATE library_artifact_sessions SET last_related_at = ? WHERE session_id = ?').run(101, 'z');
    expect(store.listTaskGroups().groups[0].session.sessionId).toBe('z');
  });

  test('paginates task and item ties without rounding fractional timestamps or changing binary identifier order', () => {
    const names = ['z', '\uE000', '😀'];
    for (const name of names) {
      session(name, 100.75, 99.25);
      files(name, 2);
      db.prepare('UPDATE library_local_artifacts SET sort_time_ms = ? WHERE id LIKE ?').run(-0.125, `${name}-%`);
    }
    const orderedNames = [...names].sort((left, right) => -compareLibraryBinaryStrings(left, right));
    let cursor: string | undefined;
    for (const name of orderedNames) {
      const page = store.listTaskGroups({ taskPageSize: 1, taskCursor: cursor });
      expect(page.groups[0].session.sessionId).toBe(name);
      if (page.nextTaskCursor) {
        const decoded = decodeLibraryGridTaskCursor(page.nextTaskCursor, {});
        expect(decoded).toMatchObject({ sessionUpdatedAt: 100.75, sessionCreatedAt: 99.25 });
      }
      cursor = page.nextTaskCursor;
      const first = store.listTaskItems({ sessionId: name, pageSize: 1 });
      const decoded = decodeLibraryGridItemCursor(first.nextItemCursor, {}, name);
      expect(decoded.artifactSortTime).toBe(-0.125);
      const second = store.listTaskItems({ sessionId: name, pageSize: 1, itemCursor: first.nextItemCursor });
      expect([first.items[0].itemId, second.items[0].itemId]).toEqual([`${name}-1`, `${name}-0`]);
    }
    expect(cursor).toBeUndefined();
  });

  test('binds cursors to query, task and kind, rejecting legacy cursors or malformed keys', () => {
    session('a', 200);
    session('b', 100);
    files('a', 4);
    files('b', 4);
    const taskCursor = store.listTaskGroups({ taskPageSize: 1 }).nextTaskCursor!;
    const itemCursor = store.listTaskItems({ sessionId: 'a', pageSize: 1 }).nextItemCursor!;
    const fileCursor = store.list({ pageSize: 1 }).nextCursor!;
    const invalidCases = [
      () => store.listTaskGroups({ taskCursor, keyword: 'changed' }),
      () => store.listTaskGroups({ taskCursor, favoritesOnly: true }),
      () => store.listTaskGroups({ taskCursor, category: LibraryCategory.Document }),
      () => store.listTaskGroups({ taskCursor: itemCursor }),
      () => store.listTaskGroups({ taskCursor: fileCursor }),
      () => store.listTaskItems({ sessionId: 'b', itemCursor }),
      () => store.listTaskItems({ sessionId: 'a', itemCursor, keyword: 'changed' }),
      () => store.listTaskItems({ sessionId: 'a', itemCursor: taskCursor }),
      () => store.listTaskItems({ sessionId: 'a', itemCursor: fileCursor }),
      () => store.list({ cursor: itemCursor }),
    ];
    for (const query of invalidCases) expect(query).toThrow(expect.objectContaining({ code: LibraryErrorCode.InvalidCursor }));
    for (const invalid of ['', '!', 'a'.repeat(4097), 5, Buffer.from('{}').toString('base64url')]) {
      expect(() => normalizeLibraryTaskGroupsOptions({ taskCursor: invalid })).toThrow(expect.objectContaining({ code: LibraryErrorCode.InvalidCursor }));
    }
    expect(getLibraryGridQueryKey({ keyword: '  AbC  ', category: LibraryCategory.All, favoritesOnly: false }))
      .toBe(getLibraryGridQueryKey({ keyword: 'AbC' }));
  });

  test('bounds page sizes, validates direct and IPC inputs and rejects corrupted projection timestamps', () => {
    expect(normalizeLibraryTaskGroupsOptions({ taskPageSize: 999 }).taskPageSize).toBe(LibraryGridLimits.MaxTaskPageSize);
    expect(normalizeLibraryTaskItemsOptions({ sessionId: ' task ', pageSize: 999 })).toMatchObject({ sessionId: ' task ', pageSize: 100 });
    for (const input of [null, [], 'task', { category: 'bad' }, { keyword: 1 }, { favoritesOnly: 1 }, { taskPageSize: 0 }, { taskPageSize: 1.5 }, { taskPageSize: Infinity }]) {
      expect(() => normalizeLibraryTaskGroupsOptions(input)).toThrow(expect.objectContaining({ code: LibraryErrorCode.InvalidInput }));
    }
    for (const sessionId of ['', 'a'.repeat(201), null, 1]) {
      expect(() => normalizeLibraryTaskItemsOptions({ sessionId })).toThrow(expect.objectContaining({ code: LibraryErrorCode.InvalidInput }));
    }
    session('task');
    files('task', 1);
    db.prepare('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?').run(Number.MAX_VALUE, 'task');
    expect(() => store.listTaskGroups()).toThrow(expect.objectContaining({ code: LibraryErrorCode.InvalidLocalData }));
    expect(() => store.listTaskItems({ sessionId: 'task' })).toThrow(expect.objectContaining({ code: LibraryErrorCode.InvalidLocalData }));
  });
});
