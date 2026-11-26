import { afterEach, describe, expect, it } from 'vitest';

import { type AvailabilitySession, RemoteAvailabilityStore } from './remoteAvailabilityStore';

const ledgers: RemoteAvailabilityStore[] = [];
afterEach(() => ledgers.splice(0).forEach(ledger => ledger.close()));
function fixture() {
  const ledger = new RemoteAvailabilityStore(':memory:'); ledgers.push(ledger);
  const state: AvailabilitySession = { scope: 'owner:target', localId: 'local', sessionId: 'remote', writerGeneration: 'writer',
    controlEpoch: 'epoch', phase: 'active', operationId: 'original', pendingCommandIds: ['command'], pendingRunIds: ['run'],
    controlRevision: '55', factSeq: '99', records: {} };
  return { ledger, state };
}
const largeHashes = () => Object.fromEntries(Array.from({ length: 14000 }, (_, i) => [`run.updated:${String(i).padStart(6, '0')}`, 'a'.repeat(64)]));

describe('availability session hash-cache budget', () => {
  it('bounds redundant-publication hashes without changing control identity or progress', () => {
    const { ledger, state } = fixture(); state.records = largeHashes();
    ledger.saveSession(state);
    const restored = ledger.session(state.scope, state.localId)!;
    expect(Object.keys(restored.records)).toHaveLength(1024);
    expect({ ...restored, records: {} }).toEqual({ ...state, records: {} });
    const persisted = ledger.db.prepare('SELECT body FROM availability_sessions').get() as { body: string };
    expect(Buffer.byteLength(persisted.body)).toBeLessThan(1024 * 1024);
  });
  it('recovers a legacy oversized cache without changing original requests or receipts', () => {
    const { ledger, state } = fixture(); state.records = largeHashes();
    const raw = JSON.stringify(state); expect(Buffer.byteLength(raw)).toBeGreaterThan(1024 * 1024);
    ledger.db.prepare('INSERT INTO availability_sessions VALUES(?,?,?)').run(state.scope, state.localId, raw);
    ledger.db.prepare('INSERT INTO availability_receipts VALUES(?,?)').run('original', '{"state":"committed","lastFactSeq":"99"}');
    const restored = ledger.session(state.scope, state.localId)!;
    expect(restored).toEqual({ ...state, records: {} });
    expect(ledger.db.prepare('SELECT * FROM availability_receipts').all()).toEqual([{ operation_id: 'original', result: '{"state":"committed","lastFactSeq":"99"}' }]);
    const persisted = ledger.db.prepare('SELECT body FROM availability_sessions').get() as { body: string };
    expect(Buffer.byteLength(persisted.body)).toBeLessThan(1024 * 1024);
  });
  it('rejects oversized authoritative fields without replacing the last trusted state', () => {
    const { ledger, state } = fixture(); ledger.saveSession(state);
    expect(() => ledger.saveSession({ ...state, pendingRunIds: ['x'.repeat(1024 * 1024)] })).toThrow('REMOTE_AVAILABILITY_SESSION_BUDGET');
    expect(ledger.session(state.scope, state.localId)).toEqual(state);
  });
  it('does not recover corrupted identities or unbounded records by inventing empty state', () => {
    const { ledger, state } = fixture();
    const invalid = JSON.stringify({ ...state, writerGeneration: null, records: largeHashes() });
    ledger.db.prepare('INSERT INTO availability_sessions VALUES(?,?,?)').run(state.scope, state.localId, invalid);
    expect(() => ledger.session(state.scope, state.localId)).toThrow('REMOTE_AVAILABILITY_RECORD_INVALID');
    expect(ledger.db.prepare('SELECT body FROM availability_sessions').get()).toEqual({ body: invalid });
    const huge = JSON.stringify({ ...state, records: { huge: 'x'.repeat(8 * 1024 * 1024) } });
    ledger.db.prepare('UPDATE availability_sessions SET body=?').run(huge);
    expect(() => ledger.session(state.scope, state.localId)).toThrow('REMOTE_AVAILABILITY_RECORD_INVALID');
    ledger.saveSession({ ...state, localId: 'healthy' });
    expect(ledger.session(state.scope, 'healthy')?.phase).toBe('active');
  });
});
