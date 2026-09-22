import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import { LibraryArtifactType, LibraryCategory, LibraryOrigin, LibraryRelationKind } from '../../shared/library/constants';
import { LibraryIndexService } from './libraryIndexService';
import { LibraryLocalStore } from './libraryLocalStore';
import { initializeLibraryTables } from './libraryMigrations';

const disposables: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposables.splice(0).reverse()) dispose();
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'library-file-types-'));
  disposables.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = new Database(':memory:');
  disposables.push(() => db.close());
  db.exec(`CREATE TABLE cowork_sessions (
    id TEXT PRIMARY KEY, title TEXT, cwd TEXT, agent_id TEXT,
    created_at INTEGER, updated_at INTEGER
  )`);
  db.prepare("INSERT INTO cowork_sessions VALUES ('s', 'Task', ?, 'main', 100, 100)").run(directory);
  initializeLibraryTables(db);
  const store = new LibraryLocalStore(db);
  const service = new LibraryIndexService({
    store, userDataPath: path.join(directory, 'user-data'), onChanged: () => undefined,
    getMetadata: () => undefined, setMetadata: () => undefined,
  });
  disposables.push(() => service.stop());
  return { directory, db, store, service };
}

describe('library indexing for remotely supported source files', () => {
  test('persists structured text and source candidates with read-only code types and their existing relations', async () => {
    const f = fixture();
    const extensions = 'json yaml yml xml js jsx ts tsx py java c cpp h hpp go rs sh sql css'.split(' ');
    const candidates = extensions.map(extension => {
      const filePath = path.join(f.directory, `result.${extension}`);
      fs.writeFileSync(filePath, extension === 'json' ? '{"result":true}' : 'Generated source content');
      return {
        sessionId: 's', messageId: 'final', filePath,
        detectedType: LibraryArtifactType.Code,
        relationKind: LibraryRelationKind.Modified, relatedAt: 100, origin: LibraryOrigin.Conversation,
      };
    });

    await expect(f.service.recordCandidates(candidates)).resolves.toEqual({ recorded: extensions.length, ignored: 0 });
    const items = f.store.list().list;
    expect(items).toHaveLength(extensions.length);
    expect(new Set(items.map(item => item.extension))).toEqual(new Set(extensions.map(extension => `.${extension}`)));
    for (const item of items) {
      expect(item.artifactType).toBe(LibraryArtifactType.Code);
      expect(item.category).toBe(LibraryCategory.Other);
      expect(item.latestSession.lastMessageId).toBe('final');
    }
  });

  test('keeps an existing file reference as referenced when recognizing its newly supported extension', async () => {
    const f = fixture();
    const filePath = path.join(f.directory, 'existing.json');
    fs.writeFileSync(filePath, '{"existing":true}');
    await expect(f.service.recordCandidates([{
      sessionId: 's', messageId: 'reference', filePath,
      detectedType: LibraryArtifactType.Code,
      relationKind: LibraryRelationKind.Referenced, relatedAt: 100, origin: LibraryOrigin.Conversation,
    }])).resolves.toEqual({ recorded: 1, ignored: 0 });
    expect(f.db.prepare('SELECT relation_kind FROM library_artifact_sessions WHERE session_id = ?').get('s'))
      .toEqual({ relation_kind: LibraryRelationKind.Referenced });
  });
});
