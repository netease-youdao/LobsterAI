import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  LibraryArtifactType,
  LibraryAvailability,
  LibraryCategory,
  LibraryErrorCode,
  LibraryFavoriteScope,
  LibraryItemKind,
  LibraryLocalProtocol,
  LibraryLocalSort,
  LibraryOrigin,
  LibraryRelationKind,
} from '../../shared/library/constants';
import { compareLibraryLocalItems, getLibraryLocalOrderKey } from '../../shared/library/localOrdering';
import type { LibraryArtifactCandidate, LocalArtifactItem } from '../../shared/library/types';
import type { RemoteOwner } from '../../shared/remote/constants';
import { decodeLibraryLocalCursor, encodeLibraryLocalCursor, LibraryLocalStore } from './libraryLocalStore';
import { initializeLibraryTables } from './libraryMigrations';

describe('LibraryLocalStore', () => {
  let db: Database.Database;
  let store: LibraryLocalStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE cowork_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        cwd TEXT NOT NULL,
        agent_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    initializeLibraryTables(db);
    initializeLibraryTables(db);
    store = new LibraryLocalStore(db);
  });

  afterEach(() => db.close());

  const insertSession = (id: string, title: string, updatedAt: number, createdAt = updatedAt) => {
    db.prepare(`
      INSERT INTO cowork_sessions (id, title, cwd, agent_id, created_at, updated_at)
      VALUES (?, ?, '/workspace', 'main', ?, ?)
    `).run(id, title, createdAt, updatedAt);
  };

  const candidate = (
    sessionId: string,
    relatedAt: number,
    relationKind = LibraryRelationKind.Modified,
  ): LibraryArtifactCandidate => ({
    sessionId,
    messageId: `message-${sessionId}`,
    sessionArtifactId: `artifact-${sessionId}`,
    filePath: '/workspace/report.pdf',
    detectedType: LibraryArtifactType.Document,
    relationKind,
    relatedAt,
    origin: LibraryOrigin.Conversation,
  });

  const indexedFile = (mtime: number, origin = LibraryOrigin.Conversation) => ({
    pathKey: '/workspace/report.pdf',
    filePath: '/workspace/report.pdf',
    fileName: 'report.pdf',
    extension: '.pdf',
    artifactType: LibraryArtifactType.Document,
    category: LibraryCategory.Document,
    sizeBytes: 128,
    fileMtimeMs: mtime,
    availability: LibraryAvailability.Available,
    origin,
    verifiedAt: mtime,
  });

  const upsertLinkedFile = (
    file = indexedFile(100),
    relation = candidate('session-1', 100),
  ) => {
    const item = store.upsertFile(file, relation);
    if (!item) throw new Error('Expected a visible task-linked artifact.');
    return item;
  };

  const deleteSession = (sessionId: string) => {
    db.transaction(() => {
      db.prepare('DELETE FROM library_artifact_sessions WHERE session_id = ?').run(sessionId);
      db.prepare('DELETE FROM cowork_sessions WHERE id = ?').run(sessionId);
    })();
  };

  test('keeps one artifact with many sessions and resolves the latest valid session', () => {
    insertSession('session-1', 'First session', 100);
    insertSession('session-2', 'Latest session', 200);

    const first = upsertLinkedFile(indexedFile(100), candidate('session-1', 100));
    const second = upsertLinkedFile(indexedFile(200), candidate('session-2', 200));

    expect(second.itemId).toBe(first.itemId);
    expect(store.list().list).toHaveLength(1);
    expect(store.list().list[0]).toMatchObject({
      relatedSessionCount: 2,
      latestSession: { sessionId: 'session-2', title: 'Latest session' },
    });

    deleteSession('session-2');
    expect(store.list().list[0].latestSession.sessionId).toBe('session-1');
  });

  test('hides an artifact after its last task is deleted while preserving index and favorite', () => {
    insertSession('session-1', 'Only task', 100);
    const item = upsertLinkedFile();
    store.setFavorite({
      ownerScope: LibraryFavoriteScope.LocalDevice,
      itemKind: LibraryItemKind.LocalArtifact,
      itemId: item.itemId,
      favorite: true,
    });

    deleteSession('session-1');

    expect(store.list()).toMatchObject({
      list: [],
      counts: { total: 0, available: 0, missing: 0 },
    });
    expect(store.list({ favoritesOnly: true }).list).toEqual([]);
    expect(store.getDetail(item.itemId)).toBeNull();
    expect(store.getItem(item.itemId)).toMatchObject({
      itemId: item.itemId,
      isFavorite: true,
      relatedSessionCount: 0,
    });
    expect(store.getItem(item.itemId)?.latestSession).toBeUndefined();
    expect(store.resolvePath(item.itemId)).toBe('/workspace/report.pdf');
  });

  test('batch reads visible items and reports hidden or unknown identifiers', () => {
    insertSession('session-1', 'Visible task', 100);
    const visible = upsertLinkedFile();
    const hidden = store.upsertFile({
      ...indexedFile(200, LibraryOrigin.Manual),
      pathKey: '/workspace/hidden.pdf',
      filePath: '/workspace/hidden.pdf',
      fileName: 'hidden.pdf',
    });

    expect(store.getVisibleItems([visible.itemId, hidden.itemId, 'unknown'])).toEqual({
      items: [expect.objectContaining({ itemId: visible.itemId })],
      unavailableItemIds: [hidden.itemId, 'unknown'],
    });
  });

  test('restores the same indexed artifact and favorite when a new task links the file', () => {
    insertSession('session-1', 'Deleted task', 100);
    const item = upsertLinkedFile();
    store.setFavorite({
      ownerScope: LibraryFavoriteScope.LocalDevice,
      itemKind: LibraryItemKind.LocalArtifact,
      itemId: item.itemId,
      favorite: true,
    });
    deleteSession('session-1');
    insertSession('session-2', 'Replacement task', 200);

    const restored = upsertLinkedFile(indexedFile(200), candidate('session-2', 200));

    expect(restored).toMatchObject({
      itemId: item.itemId,
      isFavorite: true,
      relatedSessionCount: 1,
      latestSession: { sessionId: 'session-2', title: 'Replacement task' },
    });
    expect(store.list({ favoritesOnly: true }).list).toHaveLength(1);
  });

  test('shows artifacts carrying obsolete hidden metadata from an older local database', () => {
    insertSession('session-1', 'Session', 100);
    const item = upsertLinkedFile();
    db.exec('ALTER TABLE library_local_artifacts ADD COLUMN hidden_at INTEGER');
    db.prepare('UPDATE library_local_artifacts SET hidden_at = ? WHERE id = ?')
      .run(100, item.itemId);

    expect(store.list().list).toHaveLength(1);
  });

  test('keeps the strongest relation kind while updating the latest relation metadata', () => {
    insertSession('session-1', 'Session', 100);
    const item = upsertLinkedFile(
      indexedFile(100),
      candidate('session-1', 100, LibraryRelationKind.Created),
    );
    upsertLinkedFile(
      indexedFile(200),
      candidate('session-1', 200, LibraryRelationKind.Referenced),
    );

    expect(store.getDetail(item.itemId)?.sessions[0]).toMatchObject({
      relationKind: LibraryRelationKind.Created,
      lastRelatedAt: 200,
    });
  });

  test('hides missing files from normal results and removes their local favorite', () => {
    insertSession('session-1', 'Session', 100);
    const item = upsertLinkedFile();
    store.setFavorite({
      ownerScope: LibraryFavoriteScope.LocalDevice,
      itemKind: LibraryItemKind.LocalArtifact,
      itemId: item.itemId,
      favorite: true,
    });

    expect(store.markMissing(item.itemId, 200)).toBe(true);
    expect(store.list().list).toHaveLength(0);
    expect(store.getItem(item.itemId)).toMatchObject({
      availability: LibraryAvailability.Missing,
      isFavorite: false,
    });
  });

  test('isolates local favorites and paginates deterministically', () => {
    insertSession('session-1', 'Session', 100);
    const first = upsertLinkedFile();
    upsertLinkedFile({
      ...indexedFile(200),
      pathKey: '/workspace/slides.pptx',
      filePath: '/workspace/slides.pptx',
      fileName: 'slides.pptx',
      extension: '.pptx',
      category: LibraryCategory.Slides,
    }, {
      ...candidate('session-1', 200),
      filePath: '/workspace/slides.pptx',
    });
    store.setFavorite({
      ownerScope: LibraryFavoriteScope.LocalDevice,
      itemKind: LibraryItemKind.LocalArtifact,
      itemId: first.itemId,
      favorite: true,
    });

    const pageOne = store.list({ pageSize: 1 });
    const pageTwo = store.list({ pageSize: 1, cursor: pageOne.nextCursor });
    expect(pageOne.hasMore).toBe(true);
    expect(pageTwo.list).toHaveLength(1);
    expect(pageTwo.list[0].itemId).not.toBe(pageOne.list[0].itemId);
    expect(store.list({ favoritesOnly: true }).list.map(item => item.itemId)).toEqual([first.itemId]);
  });

  test('applies task visibility before pagination so hidden rows cannot create short pages', () => {
    insertSession('session-1', 'Task', 100);
    const hidden = store.upsertFile(indexedFile(400, LibraryOrigin.Manual));
    const newest = upsertLinkedFile({
      ...indexedFile(300),
      pathKey: '/workspace/newest.pdf',
      filePath: '/workspace/newest.pdf',
      fileName: 'newest.pdf',
    }, {
      ...candidate('session-1', 300),
      filePath: '/workspace/newest.pdf',
    });
    const oldest = upsertLinkedFile({
      ...indexedFile(200),
      pathKey: '/workspace/oldest.pdf',
      filePath: '/workspace/oldest.pdf',
      fileName: 'oldest.pdf',
    }, {
      ...candidate('session-1', 200),
      filePath: '/workspace/oldest.pdf',
    });

    const pageOne = store.list({ pageSize: 1 });
    const pageTwo = store.list({ pageSize: 1, cursor: pageOne.nextCursor });

    expect(pageOne.list.map(item => item.itemId)).toEqual([newest.itemId]);
    expect(pageOne.hasMore).toBe(true);
    expect(pageTwo.list.map(item => item.itemId)).toEqual([oldest.itemId]);
    expect(pageTwo.hasMore).toBe(false);
    expect(store.getItem(hidden.itemId)).not.toBeNull();
    expect(store.list().counts.total).toBe(2);
  });

  test('rejects a late relation when its task no longer exists', () => {
    const stored = store.upsertFile(indexedFile(100, LibraryOrigin.Manual));

    const rejected = store.upsertFile(indexedFile(200), candidate('deleted-session', 200));

    expect(rejected).toBeNull();
    expect(store.list().list).toEqual([]);
    expect(store.getItem(stored.itemId)).toMatchObject({
      itemId: stored.itemId,
      sortTime: 100,
      relatedSessionCount: 0,
    });
    const relationCount = db.prepare(`
      SELECT COUNT(*) AS count FROM library_artifact_sessions
    `).get() as { count: number };
    expect(relationCount.count).toBe(0);
  });

  test('selects owner before LIMIT and keeps tasks continuous despite newer files elsewhere', () => {
    insertSession('older', 'Older task', 100.25, 50.25);
    insertSession('newer', 'New task', 200.5, 150.75);
    const old = upsertLinkedFile(indexedFile(900), candidate('older', 400));
    const recent = upsertLinkedFile({
      ...indexedFile(10), pathKey: '/workspace/new.pdf', filePath: '/workspace/new.pdf',
    }, candidate('newer', 10));
    const page = store.list({ pageSize: 1 });
    expect(page).toMatchObject({ protocolVersion: LibraryLocalProtocol.Version, sort: LibraryLocalSort.RecentTask });
    expect(page.list[0].itemId).toBe(recent.itemId);
    expect(page.list[0].latestSession).toMatchObject({ createdAt: 150.75, updatedAt: 200.5 });
    expect(store.list({ pageSize: 1, cursor: page.nextCursor }).list[0].itemId).toBe(old.itemId);
    expect(store.resolveCloudSession('newer')).toMatchObject({ createdAt: 150.75, updatedAt: 200.5 });
  });

  test('preserves relation priority but allows activity to change an owner when relation times tie', () => {
    insertSession('a', 'A', 100);
    insertSession('b', 'B', 200);
    const file = upsertLinkedFile(indexedFile(100), candidate('a', 300));
    upsertLinkedFile(indexedFile(100), candidate('b', 400));
    db.prepare('UPDATE cowork_sessions SET updated_at = 500 WHERE id = ?').run('a');
    expect(store.list().list[0].latestSession.sessionId).toBe('b');
    upsertLinkedFile(indexedFile(100), candidate('a', 400));
    expect(store.list().list[0].latestSession.sessionId).toBe('a');
    expect(store.getDetail(file.itemId)?.item.latestSession.sessionId).toBe('a');
    expect(new Set(store.listSessionIdsWithArtifactRelations(['a', 'b', 'none', 'a']))).toEqual(new Set(['a', 'b']));
  });

  test.each([0, 24, 25, 48, 49, 120])('matches complete shared ordering for %i files at all page sizes', (count) => {
    const sessions = ['a', 'z', '\uE000', '𐀀'];
    sessions.forEach((id, index) => insertSession(id, id, 100 + (index % 2) * 0.5, 50 + (index % 3) * 0.25));
    const expected: LocalArtifactItem[] = [];
    for (let index = 0; index < count; index += 1) {
      const filePath = `/workspace/file-${index}.pdf`;
      expected.push(upsertLinkedFile({
        ...indexedFile(10 + (index % 4) * 0.25), pathKey: filePath, filePath,
      }, candidate(sessions[index % sessions.length], 200 + index)));
    }
    expected.sort(compareLibraryLocalItems);
    for (const pageSize of [1, 24, 25, 100]) {
      const actual: LocalArtifactItem[] = [];
      let cursor: string | undefined;
      do {
        const page = store.list({ pageSize, cursor });
        expect(page.counts.total).toBe(count);
        expect(page.list.length).toBeLessThanOrEqual(pageSize);
        actual.push(...page.list);
        cursor = page.nextCursor;
        if (cursor) {
          expect(decodeLibraryLocalCursor(cursor)).toMatchObject(getLibraryLocalOrderKey(page.list[page.list.length - 1]));
        }
        expect(actual.length).toBeLessThanOrEqual(count);
      } while (cursor);
      expect(actual.map(item => item.itemId)).toEqual(expected.map(item => item.itemId));
    }
  });

  test('uses binary item IDs at the final cursor tie-break, including exact whitespace', () => {
    insertSession('session', 'Task', 0, -0.5);
    const ids = ['a', '\uE000', '𐀀', ' padded '];
    const expected: LocalArtifactItem[] = [];
    for (const id of ids) {
      const filePath = `/workspace/${id}.pdf`;
      const file = upsertLinkedFile({ ...indexedFile(-0.25), pathKey: filePath, filePath }, candidate('session', 1));
      db.transaction(() => {
        db.pragma('defer_foreign_keys = ON');
        db.prepare('UPDATE library_local_artifacts SET id = ? WHERE id = ?').run(id, file.itemId);
        db.prepare('UPDATE library_artifact_sessions SET artifact_id = ? WHERE artifact_id = ?').run(id, file.itemId);
      })();
      expected.push({ ...file, itemId: id });
    }
    const actual: string[] = [];
    let cursor: string | undefined;
    do {
      const page = store.list({ pageSize: 1, cursor });
      actual.push(...page.list.map(item => item.itemId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(actual).toEqual(expected.sort(compareLibraryLocalItems).map(item => item.itemId));
    expect(store.getVisibleItems([' padded ']).items[0].itemId).toBe(' padded ');
  });

  test('filters before pagination and counts missing files independently', () => {
    insertSession('session-1', 'Task', 100);
    const missing = upsertLinkedFile();
    store.markMissing(missing.itemId, 200);
    const inaccessible = upsertLinkedFile({
      ...indexedFile(100), pathKey: '/workspace/inaccessible.pdf', filePath: '/workspace/inaccessible.pdf',
      fileName: 'inaccessible.pdf', availability: LibraryAvailability.PermissionDenied,
    });
    expect(store.list().counts).toEqual({ total: 1, available: 0, missing: 1 });
    expect(store.list({ keyword: 'inaccessible', category: LibraryCategory.Document }).list[0].itemId).toBe(inaccessible.itemId);
    expect(store.list({ category: LibraryCategory.Image }).list).toEqual([]);
  });

  test.each(['broken', 8_640_000_000_000_001, Infinity])('rejects invalid persisted task time %s rather than hiding a row', (time) => {
    insertSession('session-1', 'Task', 100);
    const file = upsertLinkedFile();
    db.prepare('UPDATE cowork_sessions SET updated_at = ?').run(time);
    for (const read of [() => store.list(), () => store.getDetail(file.itemId), () => store.getVisibleItems([file.itemId])]) {
      expect(read).toThrow(expect.objectContaining({ code: LibraryErrorCode.InvalidLocalData }));
    }
  });

  test('rejects invalid file or task creation times on list and detail reads', () => {
    insertSession('session-1', 'Task', 100);
    const file = upsertLinkedFile();
    db.prepare('UPDATE library_local_artifacts SET sort_time_ms = ?').run('broken');
    expect(() => store.list()).toThrow(expect.objectContaining({ code: LibraryErrorCode.InvalidLocalData }));
    expect(() => store.getVisibleItems([file.itemId])).toThrow(expect.objectContaining({ code: LibraryErrorCode.InvalidLocalData }));
    db.prepare('UPDATE library_local_artifacts SET sort_time_ms = 100').run();
    db.prepare('UPDATE cowork_sessions SET created_at = ?').run(Infinity);
    expect(() => store.list()).toThrow(expect.objectContaining({ code: LibraryErrorCode.InvalidLocalData }));
    expect(() => store.resolveCloudSession('session-1')).toThrow(expect.objectContaining({ code: LibraryErrorCode.InvalidLocalData }));
  });

  test('round trips fractional cursor keys and rejects legacy, corrupted, oversized and out-of-range cursors', () => {
    const key = { sessionUpdatedAt: 1788470400000.5, sessionCreatedAt: 1788460000000.25, sessionId: '文'.repeat(200), artifactSortTime: -0.75, itemId: '𐀀'.repeat(100) };
    expect(decodeLibraryLocalCursor(encodeLibraryLocalCursor(key))).toEqual({ ...key, version: LibraryLocalProtocol.Version, sort: LibraryLocalSort.RecentTask });
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    for (const cursor of [
      '', '!', 'a'.repeat(4097), encode({ sortTime: 100, itemId: 'old' }),
      encode({ ...key, version: 1, sort: LibraryLocalSort.RecentTask }),
      encode({ ...key, version: LibraryLocalProtocol.Version, sort: LibraryLocalSort.RecentTask, sessionUpdatedAt: '100' }),
    ]) {
      expect(decodeLibraryLocalCursor(cursor)).toBeNull();
      expect(() => store.list({ cursor })).toThrow(expect.objectContaining({ code: LibraryErrorCode.InvalidCursor }));
    }
  });

  describe('file access', () => {
    const accountA = { userId: 'account-a', scopeKey: 'personal' };
    const accountB = { userId: 'account-b', scopeKey: 'personal' };
    const otherSpace = { ...accountA, scopeKey: 'team' };
    const actors = [null, accountA, accountB, otherSpace];

    beforeEach(() => {
      db.exec(`CREATE TABLE cowork_session_ownership (
        session_id TEXT PRIMARY KEY,
        owner_user_id TEXT,
        owner_scope_key TEXT,
        ownership_status TEXT
      )`);
    });

    const associate = (sessionId: string, owner: RemoteOwner) => {
      db.prepare('INSERT INTO cowork_session_ownership VALUES (?, ?, ?, ?)')
        .run(sessionId, owner.userId, owner.scopeKey, 'confirmed');
    };

    test('allows anonymous task files for every account and signed-out users', () => {
      insertSession('session-1', 'Anonymous task', 100);
      upsertLinkedFile();

      for (const actor of actors) {
        expect(store.getFileAccess('/workspace/report.pdf', actor)).toEqual({ tracked: true, visible: true });
      }
    });

    test('requires both the user and space of an owned task', () => {
      insertSession('session-1', 'Private task', 100);
      upsertLinkedFile();
      associate('session-1', accountA);

      expect(store.getFileAccess('/workspace/report.pdf', accountA)).toEqual({ tracked: true, visible: true });
      for (const actor of [null, accountB, otherSpace]) {
        expect(store.getFileAccess('/workspace/report.pdf', actor)).toEqual({ tracked: true, visible: false });
      }
    });

    test('applies association immediately without reindexing the file', () => {
      insertSession('session-1', 'Historical task', 100);
      const item = upsertLinkedFile();
      expect(store.getFileAccess(item.filePath, accountB).visible).toBe(true);

      associate('session-1', accountA);

      expect(store.getFileAccess(item.filePath, accountA).visible).toBe(true);
      expect(store.getFileAccess(item.filePath, accountB).visible).toBe(false);
      expect(store.getFileAccess(item.filePath, null).visible).toBe(false);
      expect(store.getDetail(item.itemId, accountB)).toBeNull();
      expect(store.getVisibleItems([item.itemId], accountB)).toEqual({ items: [], unavailableItemIds: [item.itemId] });
    });

    test('keeps shared anonymous files visible without disclosing private relations', () => {
      insertSession('anonymous', 'Anonymous task', 100);
      insertSession('private', 'Private task title', 200);
      const item = upsertLinkedFile(indexedFile(100), candidate('anonymous', 100));
      upsertLinkedFile(indexedFile(200), candidate('private', 200));
      associate('private', accountA);

      for (const actor of actors) {
        expect(store.getFileAccess(item.filePath, actor)).toEqual({ tracked: true, visible: true });
      }
      const detail = store.getDetail(item.itemId, accountB);
      expect(detail?.sessions.map(session => session.sessionId)).toEqual(['anonymous']);
      expect(detail?.item).toMatchObject({ latestSession: { sessionId: 'anonymous' }, relatedSessionCount: 1 });
      expect(JSON.stringify(detail)).not.toContain('Private task title');
      expect(store.getDetail(item.itemId, accountA)?.item.relatedSessionCount).toBe(2);
    });

    test('denies tracked missing, unlinked and quarantined files', () => {
      insertSession('session-1', 'Task', 100);
      const item = upsertLinkedFile();
      associate('session-1', accountA);
      db.prepare("UPDATE cowork_session_ownership SET ownership_status = 'quarantined'").run();
      expect(store.getFileAccess(item.filePath, accountA)).toEqual({ tracked: true, visible: false });

      db.prepare("UPDATE cowork_session_ownership SET ownership_status = 'confirmed'").run();
      store.markMissing(item.itemId, 200);
      expect(store.getFileAccess(item.filePath, accountA)).toEqual({ tracked: true, visible: false });

      upsertLinkedFile();
      deleteSession('session-1');
      expect(store.getFileAccess(item.filePath, accountA)).toEqual({ tracked: true, visible: false });
    });

    test('normalizes indexed paths and distinguishes untracked files from denied files', () => {
      insertSession('session-1', 'Task', 100);
      upsertLinkedFile();
      associate('session-1', accountA);

      expect(store.getFileAccess('/workspace/child/../report.pdf', accountA)).toEqual({ tracked: true, visible: true });
      expect(store.getFileAccess('/workspace/child/../report.pdf', accountB)).toEqual({ tracked: true, visible: false });
      expect(store.getFileAccess('/workspace/untracked.pdf', accountB)).toEqual({ tracked: false, visible: false });
    });
  });
});
