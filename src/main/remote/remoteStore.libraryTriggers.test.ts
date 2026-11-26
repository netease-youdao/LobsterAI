import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

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
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('RemoteStore triggers with the real local library', () => {
  test('repairs existing card revisions once when upgrading legacy library triggers', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'library-live-upgrade-'));
    directories.push(directory);
    const filename = path.join(directory, 'library.sqlite');
    const original = fixture(filename);
    createSession(original.remote);
    original.remote.transaction(() => original.db.prepare("INSERT INTO cowork_messages VALUES ('message-100','session','assistant','file','{}',100,1)").run());
    upsert(original.library);
    original.db.exec(`DROP TRIGGER remote_library_relation_insert;
      CREATE TRIGGER remote_library_relation_insert AFTER INSERT ON library_artifact_sessions BEGIN
        INSERT INTO remote_session_revisions(session_id,revision,dirty_at) VALUES (NEW.session_id,1,100)
        ON CONFLICT(session_id) DO UPDATE SET revision=revision+1; END;`);
    const revision = (db: Database.Database) => (db.prepare("SELECT revision FROM remote_live_revisions WHERE session_id='session' AND object_id='message-100'").get() as { revision: number }).revision;
    const before = revision(original.db);
    original.db.close();
    const upgraded = fixture(filename);
    expect(revision(upgraded.db)).toBe(before + 1);
    upgraded.db.close();
    const reopened = fixture(filename);
    expect(revision(reopened.db)).toBe(before + 1);
    expect(reopened.db.prepare('SELECT count(*) AS count FROM library_artifact_sessions').get()).toEqual({ count: 1 });
  });

  test('does not republish unchanged cards during repeated indexing or verification', () => {
    const { db, library, remote } = fixture();
    createSession(remote);
    remote.transaction(() => db.prepare("INSERT INTO cowork_messages VALUES ('message-100','session','assistant','file','{}',100,1)").run());
    upsert(library);
    const revision = () => (db.prepare("SELECT revision FROM remote_live_revisions WHERE object_id='message-100'").get() as { revision: number }).revision;
    const before = revision();
    for (let i = 0; i < 50; i++) upsert(library);
    db.prepare('UPDATE library_local_artifacts SET last_verified_at=last_verified_at+1, updated_at=updated_at+1').run();
    expect(revision()).toBe(before);
    db.prepare("UPDATE library_local_artifacts SET file_name='renamed.pdf'").run();
    expect(revision()).toBe(before + 1);
  });

  test('rolls back a failed trigger upgrade and can retry without losing user data', () => {
    const { db, library, remote } = fixture();
    createSession(remote); upsert(library);
    db.exec('DROP TRIGGER remote_library_relation_insert');
    const triggers = () => db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all();
    const before = triggers();
    const exec = db.exec.bind(db);
    vi.spyOn(db, 'exec').mockImplementation(sql => {
      if (sql.startsWith('CREATE TRIGGER remote_library_relation_insert')) throw new Error('Simulated migration failure');
      return exec(sql);
    });
    expect(() => new RemoteStore(db, { restoreRuns: false })).toThrow('Simulated migration failure');
    expect(triggers()).toEqual(before);
    expect(library.list({}, owner).list).toHaveLength(1);
    vi.restoreAllMocks();
    expect(() => new RemoteStore(db, { restoreRuns: false })).not.toThrow();
    expect(upsert(library).itemId).toBe(library.list({}, owner).list[0].itemId);
  });

  test('repairs a large historical library once without copying message bodies', () => {
    const { db, library, remote } = fixture();
    createSession(remote); const item = upsert(library);
    remote.transaction(() => {
      db.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000)
        INSERT INTO cowork_messages SELECT 'bulk-'||x,'session','assistant',zeroblob(2048),'{}',100,x FROM n;`);
      db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000)
        INSERT INTO library_local_artifacts
        SELECT 'artifact-'||x,'/workspace/'||x||'.pdf','/workspace/'||x||'.pdf',file_name,extension,artifact_type,category,
          file_identity,client_source_key,size_bytes,file_mtime_ms,sort_time_ms,availability,origin,first_seen_at,last_seen_at,
          last_verified_at,missing_since,created_at,updated_at FROM n,library_local_artifacts WHERE id=?`).run(item.itemId);
      db.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000)
        INSERT INTO library_artifact_sessions SELECT 'artifact-'||x,'session','created',100,100,'bulk-'||x,NULL,100,100 FROM n;`);
    });
    db.exec('DROP TRIGGER remote_library_relation_insert');
    const total = () => (db.prepare("SELECT sum(revision) AS total FROM remote_live_revisions WHERE object_id LIKE 'bulk-%'").get() as { total: number }).total;
    const before = total(), started = performance.now();
    new RemoteStore(db, { restoreRuns: false });
    const upgraded = total();
    expect(upgraded).toBe(before + 10000);
    new RemoteStore(db, { restoreRuns: false });
    expect(total()).toBe(upgraded);
    expect(db.prepare('SELECT count(*) AS count,sum(length(content)) AS bytes FROM cowork_messages').get())
      .toEqual({ count: 10000, bytes: 20480000 });
    console.debug('[RemoteStore test] Historical library upgrade and reopen.', { cards: 10000, elapsedMs: Math.round(performance.now() - started) });
  });

  test('invalidates an already published message when its artifact arrives later', () => {
    const { db, library, remote } = fixture();
    createSession(remote);
    remote.transaction(() => db.prepare("INSERT INTO cowork_messages VALUES ('message-100','session','assistant','MEDIA:/workspace/report.pdf','{}',100,1)").run());
    const revision = () => (db.prepare("SELECT revision FROM remote_live_revisions WHERE session_id='session' AND object_id='message-100'").get() as { revision: number }).revision;
    let previous = revision();
    const item = upsert(library);
    expect(revision()).toBeGreaterThan(previous);
    previous = revision();
    db.prepare("UPDATE library_local_artifacts SET availability='missing' WHERE id=?").run(item.itemId);
    expect(revision()).toBeGreaterThan(previous);
    previous = revision();
    db.prepare('DELETE FROM library_artifact_sessions WHERE artifact_id=?').run(item.itemId);
    expect(revision()).toBeGreaterThan(previous);
    expect(remote.owner('session')).toEqual(owner);
  });

  test('invalidates both messages when a relation moves, without reviving deleted messages', () => {
    const { db, library, remote } = fixture();
    createSession(remote);
    remote.transaction(() => {
      for (const id of ['message-100', 'message-200']) db.prepare("INSERT INTO cowork_messages VALUES (?,'session','assistant','file','{}',100,1)").run(id);
    });
    upsert(library);
    const revisions = () => db.prepare("SELECT object_id,revision,deleted FROM remote_live_revisions WHERE session_id='session' ORDER BY object_id").all() as Array<{ object_id: string; revision: number; deleted: number }>;
    const before = revisions();
    upsert(library, 200);
    const after = revisions();
    expect(after.every((row, index) => row.revision > before[index].revision)).toBe(true);
    remote.transaction(() => db.prepare("DELETE FROM cowork_messages WHERE id='message-200'").run());
    db.prepare("UPDATE library_local_artifacts SET availability='missing'").run();
    expect(revisions().find(row => row.object_id === 'message-200')?.deleted).toBe(1);
  });

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
    remote.refreshProjectionHints();
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
    remote.refreshProjectionHints();
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
    remote.refreshProjectionHints();
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
      DROP TRIGGER IF EXISTS remote_content_library_artifact_update;
      CREATE TRIGGER remote_content_library_artifact_update AFTER UPDATE ON library_local_artifacts BEGIN
        INSERT OR IGNORE INTO remote_content_dirty
          SELECT session_id FROM library_artifact_sessions WHERE artifact_id=NEW.id;
      END;
      DROP TRIGGER IF EXISTS remote_content_library_relation_update;
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
    original.remote.refreshProjectionHints();
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
    reopened.remote.refreshProjectionHints();
    expect(markers(reopened.db, 'remote_dirty')).toEqual([{ session_id: 'session' }]);
    expect(markers(reopened.db, 'remote_content_dirty')).toEqual([{ session_id: 'session' }]);
    const legacyTriggers = reopened.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='trigger' AND name LIKE 'remote_%' AND sql LIKE '%INSERT OR IGNORE%'
    `).all();
    expect(legacyTriggers).toEqual([]);
  });
});
