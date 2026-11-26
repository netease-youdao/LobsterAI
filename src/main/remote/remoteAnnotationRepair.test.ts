import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';

import { annotationRepairCandidates } from './remoteAnnotationRepair';
import { RemoteAvailabilityStore } from './remoteAvailabilityStore';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach(dispose => dispose()));
function fixture() {
  const core = new Database(':memory:'); cleanup.push(() => core.close());
  const ledger = new RemoteAvailabilityStore(core); cleanup.push(() => ledger.close());
  core.exec(`CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,sequence INTEGER,metadata TEXT);
    CREATE TABLE remote_live_revisions(session_id TEXT,object_id TEXT,revision INTEGER,deleted INTEGER,PRIMARY KEY(session_id,object_id));`);
  const add = (id: string, type = 'user', scope = 'scope', localId = 'session') => {
    core.prepare('INSERT INTO cowork_messages VALUES(?,?,?,?,?)').run(id, localId, type, 1, 'private metadata never read');
    core.prepare('INSERT INTO remote_live_revisions VALUES(?,?,7,0)').run(localId, id);
    ledger.db.prepare('INSERT INTO availability_objects VALUES(?,?,?,?,?)').run(scope, localId, `message:${id}`, '7', '{}');
  };
  return { core, ledger, add, scan: (scope = 'scope', localId = 'session', writer = 'writer') => annotationRepairCandidates(core, ledger, scope, localId, writer) };
}

it('caps each identity scan and progresses past non-user rows without reading metadata', () => {
  const f = fixture();
  for (let index = 0; index < 40; index++) f.add(`a-${String(index).padStart(2, '0')}`, 'assistant');
  f.add('z-annotation');
  expect(f.scan()).toEqual([]);
  expect(f.ledger.db.prepare('SELECT object_cursor FROM availability_annotation_scan').get()).toEqual({ object_cursor: 'message:a-31' });
  expect(f.scan()).toEqual([{ object_id: 'z-annotation', revision: 7, kind: 'message', position: 1, annotationCheck: true }]);
});

it('returns at most four users and resumes after the last actually examined identity', () => {
  const f = fixture();
  for (let index = 0; index < 7; index++) f.add(`user-${index}`);
  expect(f.scan().map(row => row.object_id)).toEqual(['user-0', 'user-1', 'user-2', 'user-3']);
  expect(f.scan().map(row => row.object_id)).toEqual(['user-4', 'user-5', 'user-6']);
  expect(f.scan()).toEqual([]);
  expect(f.scan().map(row => row.object_id)).toEqual(['user-0', 'user-1', 'user-2', 'user-3']);
});

it('separates owner scopes and restarts a changed writer without reviving deleted rows', () => {
  const f = fixture();
  for (let index = 0; index < 6; index++) f.add(`user-${index}`);
  f.add('foreign', 'user', 'other');
  f.core.prepare("UPDATE remote_live_revisions SET deleted=1 WHERE object_id='user-0'").run();
  expect(f.scan().map(row => row.object_id)).toEqual(['user-1', 'user-2', 'user-3', 'user-4']);
  expect(f.scan('other').map(row => row.object_id)).toEqual(['foreign']);
  expect(f.scan().map(row => row.object_id)).toEqual(['user-5']);
  expect(f.scan('scope', 'session', 'replacement').map(row => row.object_id)).toEqual(['user-1', 'user-2', 'user-3', 'user-4']);
});
