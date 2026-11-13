import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { isRecoveryDependencyFailure,RemoteRecoveryDependency } from './remoteRecoveryDependency';
const context = { owner: { userId: 'owner', scopeKey: 'personal' }, target: 'target', deviceId: 'device' };
const handles: Database.Database[] = [];
afterEach(() => { for (const db of handles.splice(0)) db.close(); });
function fixture() { const db = new Database(':memory:'); handles.push(db); db.exec('CREATE TABLE remote_state(key TEXT PRIMARY KEY,value TEXT)'); return { db, proof: new RemoteRecoveryDependency(db) }; }
describe('persistent shared transport recovery evidence', () => {
  it('requires unavailable to healthy, retaining epoch and pending evidence across restart', () => {
    const { db, proof } = fixture(); expect(proof.observe(context, true)).toBe(false);
    proof.observe(context, false); proof.observe(context, false); const restarted = new RemoteRecoveryDependency(db);
    expect(restarted.epoch(context)).toBe(0); expect(restarted.observe(context, true)).toBe(true); expect(restarted.epoch(context)).toBe(1);
    for (let index = 0; index < 20; index++) expect(new RemoteRecoveryDependency(db).observe(context, true)).toBe(false);
    expect(proof.epoch(context)).toBe(1);
  });
  it('does not reuse another owner, target or device failure', () => {
    const { proof } = fixture(); proof.observe(context, false);
    for (const other of [{ ...context, target: 'other' }, { ...context, deviceId: 'other' }, { ...context, owner: { ...context.owner, userId: 'other' } }]) {
      expect(proof.observe(other, true)).toBe(false); expect(proof.epoch(other)).toBe(0);
    }
    expect(proof.epoch(context)).toBe(0);
  });
  it('does not reset corrupt records or overflowing epochs', () => {
    const { db, proof } = fixture(); proof.observe(context, false); db.prepare("UPDATE remote_state SET value='broken'").run();
    expect(proof.epoch(context)).toBeNull(); expect(proof.observe(context, true)).toBe(false);
    expect((db.prepare('SELECT value FROM remote_state').get() as any).value).toBe('broken');
    db.prepare('UPDATE remote_state SET value=?').run(JSON.stringify({ version: 1, epoch: 2147483647, unavailable: true }));
    expect(proof.observe(context, true)).toBe(false); expect(proof.epoch(context)).toBe(2147483647);
  });
  it('ignores permissions, unknown data errors and normal local admission deferrals', () => {
    expect(isRecoveryDependencyFailure({ code: 47002, httpStatus: 403 })).toBe(false);
    expect(isRecoveryDependencyFailure({ code: 47019, httpStatus: 400 })).toBe(false);
    expect(isRecoveryDependencyFailure(new TypeError('fetch failed'))).toBe(true);
    expect(isRecoveryDependencyFailure({ code: 503, httpStatus: 503 })).toBe(true);
  });
});
