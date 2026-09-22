import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  LibraryArtifactType,
  LibraryAvailability,
  LibraryCategory,
  LibraryOrigin,
  LibraryRelationKind,
} from '../../shared/library/constants';
import { type LibraryIndexedFile, LibraryLocalStore } from '../library/libraryLocalStore';
import { initializeLibraryTables } from '../library/libraryMigrations';
import { RemoteStore } from './remoteStore';

const owner = { userId: 'library-owner', scopeKey: 'personal' };
const databases: Database.Database[] = [];
const directories: string[] = [];

function fixture(filename = ':memory:') {
  const db = new Database(filename);
  databases.push(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS cowork_sessions (
      id TEXT PRIMARY KEY, title TEXT, cwd TEXT, agent_id TEXT,
      created_at INTEGER, updated_at INTEGER, status TEXT
    );
    CREATE TABLE IF NOT EXISTS cowork_messages (
      id TEXT PRIMARY KEY, session_id TEXT, type TEXT, content TEXT,
      metadata TEXT, created_at INTEGER, sequence INTEGER
    );
  `);
  initializeLibraryTables(db);
  const library = new LibraryLocalStore(db);
  const remote = new RemoteStore(db, { restoreRuns: false });
  return { db, library, remote };
}

function createSession(remote: RemoteStore, id = 'session', owned = true) {
  remote.transaction(() => {
    remote.db.prepare("INSERT INTO cowork_sessions VALUES (?, ?, '/workspace', 'main', 100, 100, 'idle')")
      .run(id, id);
    remote.assignNew(id, owned ? owner : null, 'local_create');
  });
}

function upsert(library: LibraryLocalStore, time = 100, sessionId = 'session') {
  const file: LibraryIndexedFile = {
    pathKey: '/workspace/report.pdf',
    filePath: '/workspace/report.pdf',
    fileName: 'report.pdf',
    extension: '.pdf',
    artifactType: LibraryArtifactType.Document,
    category: LibraryCategory.Document,
    sizeBytes: time,
    fileMtimeMs: time,
    availability: LibraryAvailability.Available,
    origin: LibraryOrigin.Conversation,
    verifiedAt: time,
  };
  const item = library.upsertFile(file, {
    sessionId,
    messageId: `message-${time}`,
    sessionArtifactId: `artifact-${time}`,
    filePath: file.filePath,
    detectedType: file.artifactType,
    relationKind: LibraryRelationKind.Created,
    relatedAt: time,
    origin: LibraryOrigin.Conversation,
  });
  expect(item).not.toBeNull();
  return item!;
}

function markers(db: Database.Database, table: string) {
  return db.prepare(`SELECT session_id FROM ${table} ORDER BY session_id`).all();
}

function seedMarkers(db: Database.Database) {
  db.exec("INSERT INTO remote_dirty VALUES ('session'); INSERT INTO remote_content_dirty VALUES ('session');");
}

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('RemoteStore triggers with the real local library', () => {
  test.each([
    { enabled: true, alreadyDirty: false },
    { enabled: true, alreadyDirty: true },
    { enabled: false, alreadyDirty: false },
    { enabled: false, alreadyDirty: true },
  ])('persists first and repeated upserts with enabled=$enabled, alreadyDirty=$alreadyDirty', ({ enabled, alreadyDirty }) => {
    const { db, library, remote } = fixture();
    createSession(remote);
    remote.setEnabledOwner(enabled ? owner : null);
    if (alreadyDirty) seedMarkers(db);

    const first = upsert(library);
    const second = upsert(library, 200);
    const third = upsert(library, 300);

    expect(second.itemId).toBe(first.itemId);
    expect(third.itemId).toBe(first.itemId);
    expect(library.list({}, owner).list).toEqual([
      expect.objectContaining({ itemId: first.itemId, sizeBytes: 300, relatedSessionCount: 1 }),
    ]);
    expect(library.getDetail(first.itemId, owner)?.sessions).toEqual([
      expect.objectContaining({ sessionId: 'session', firstRelatedAt: 100, lastRelatedAt: 300 }),
    ]);
    expect(markers(db, 'remote_dirty')).toEqual([{ session_id: 'session' }]);
    expect(markers(db, 'remote_content_dirty')).toEqual([{ session_id: 'session' }]);
    expect(remote.owner('session')).toEqual(owner);
  });

  test('keeps anonymous artifacts local while dirty content markers already exist', () => {
    const { db, library, remote } = fixture();
    createSession(remote, 'session', false);
    db.prepare('INSERT INTO remote_content_dirty VALUES (?)').run('session');

    const item = upsert(library);
    expect(upsert(library, 200).itemId).toBe(item.itemId);
    expect(library.list().list).toHaveLength(1);
    expect(markers(db, 'remote_content_dirty')).toEqual([{ session_id: 'session' }]);
    expect(markers(db, 'remote_dirty')).toEqual([]);
    expect(remote.sync('session')).toBeNull();
  });

  test('marks every related session once when an existing artifact is updated', () => {
    const { db, library, remote } = fixture();
    createSession(remote);
    createSession(remote, 'other');
    const item = upsert(library);
    upsert(library, 200, 'other');
    db.exec('DELETE FROM remote_dirty; DELETE FROM remote_content_dirty;');

    expect(upsert(library, 300).itemId).toBe(item.itemId);
    expect(library.getDetail(item.itemId, owner)?.sessions).toHaveLength(2);
    const expected = [{ session_id: 'other' }, { session_id: 'session' }];
    expect(markers(db, 'remote_dirty')).toEqual(expected);
    expect(markers(db, 'remote_content_dirty')).toEqual(expected);
  });

  test('allows cowork session and message upserts with pending dirty markers', () => {
    const { db, remote } = fixture();
    createSession(remote);
    seedMarkers(db);
    const revision = remote.projectionRevision('session');
    const session = db.prepare(`
      INSERT INTO cowork_sessions (id, title, cwd, agent_id, created_at, updated_at, status)
      VALUES ('session', ?, '/workspace', 'main', 100, 100, 'idle')
      ON CONFLICT(id) DO UPDATE SET title=excluded.title
    `);
    const message = db.prepare(`
      INSERT INTO cowork_messages VALUES ('message', 'session', 'assistant', ?, NULL, 100, 1)
      ON CONFLICT(id) DO UPDATE SET content=excluded.content
    `);
    session.run('Updated title');
    message.run('First reply');
    message.run('Updated reply');

    expect(db.prepare('SELECT title FROM cowork_sessions').get()).toEqual({ title: 'Updated title' });
    expect(db.prepare('SELECT content FROM cowork_messages').get()).toEqual({ content: 'Updated reply' });
    expect(remote.projectionRevision('session')).toBe(revision + 3);
    expect(markers(db, 'remote_dirty')).toEqual([{ session_id: 'session' }]);
    expect(markers(db, 'remote_content_dirty')).toEqual([{ session_id: 'session' }]);
    // Unsupported writes still quarantine ownership; conflict handling must not weaken the fence.
    expect(remote.owner('session')).toBeNull();
  });

  test('replaces persisted legacy triggers after reopening the database', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'library-remote-triggers-'));
    directories.push(directory);
    const filename = path.join(directory, 'library.sqlite');
    const original = fixture(filename);
    createSession(original.remote);
    const item = upsert(original.library);
    original.db.exec(`
      DROP TRIGGER remote_content_library_artifact_update;
      CREATE TRIGGER remote_content_library_artifact_update AFTER UPDATE ON library_local_artifacts BEGIN
        INSERT OR IGNORE INTO remote_content_dirty
          SELECT session_id FROM library_artifact_sessions WHERE artifact_id=NEW.id;
      END;
      DROP TRIGGER remote_content_library_relation_update;
      CREATE TRIGGER remote_content_library_relation_update AFTER UPDATE ON library_artifact_sessions BEGIN
        INSERT OR IGNORE INTO remote_content_dirty VALUES (NEW.session_id);
      END;
      DROP TRIGGER remote_cowork_sessions_update;
      CREATE TRIGGER remote_cowork_sessions_update AFTER UPDATE ON cowork_sessions BEGIN
        INSERT OR IGNORE INTO remote_dirty VALUES (NEW.id);
        UPDATE cowork_session_ownership SET ownership_status='quarantined'
          WHERE session_id=NEW.id AND (SELECT trusted FROM remote_write_context WHERE id=1)=0;
      END;
    `);
    expect(() => upsert(original.library, 200)).toThrow(expect.objectContaining({ code: 'SQLITE_CONSTRAINT_PRIMARYKEY' }));
    expect(original.library.getItem(item.itemId)?.sizeBytes).toBe(100);
    original.db.close();

    const reopened = fixture(filename);
    expect(upsert(reopened.library, 200).itemId).toBe(item.itemId);
    expect(upsert(reopened.library, 300).itemId).toBe(item.itemId);
    reopened.db.prepare(`
      INSERT INTO cowork_sessions (id, title) VALUES ('session', 'Upgraded')
      ON CONFLICT(id) DO UPDATE SET title=excluded.title
    `).run();
    expect(reopened.library.getItem(item.itemId)?.sizeBytes).toBe(300);
    expect(markers(reopened.db, 'remote_dirty')).toEqual([{ session_id: 'session' }]);
    expect(markers(reopened.db, 'remote_content_dirty')).toEqual([{ session_id: 'session' }]);
    const legacyTriggers = reopened.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='trigger' AND name LIKE 'remote_%' AND sql LIKE '%INSERT OR IGNORE%'
    `).all();
    expect(legacyTriggers).toEqual([]);
  });
});
