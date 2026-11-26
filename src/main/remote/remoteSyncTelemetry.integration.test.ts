import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteTelemetryEvent } from '../../shared/remote/telemetry';
import { type AvailabilityRequest, RemoteAvailabilityStore } from './remoteAvailabilityStore';
import { configureRemoteTelemetry, shutdownRemoteTelemetry } from './remoteTelemetry';

const ledgers: RemoteAvailabilityStore[] = [];
afterEach(async () => { await shutdownRemoteTelemetry(); for (const ledger of ledgers.splice(0)) ledger.close(); });
function fixture() {
  let now = 100000;
  const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  const telemetry = configureRemoteTelemetry({ context: { epoch: 'owner-target', enabled: true, installationId: 'installation',
    appVersion: '1.2.3', environment: 'test', remoteEnvironment: 'test', userId: 'owner', remoteOwnerId: 'owner',
    identityNamespace: 'server_user_id', ownerScopeId: 'personal', scopeKind: 'personal', deviceId: 'device' },
    fetch, now: () => now, monotonicNow: () => now, autoStart: false })!;
  const ledger = new RemoteAvailabilityStore(':memory:'); ledgers.push(ledger);
  const request: AvailabilityRequest = { key: '00000000-0000-4000-8000-000000000001', lane: 'control', scope: 'target-owner', localId: 'local',
    method: 'POST', pathname: '/control/facts/batches', version: 1, lookup: null, lookupVersion: 1, createdAt: now, attempted: false,
    body: { owner: { userId: 'owner', scopeKey: 'personal' }, deviceId: 'device', sessionId: 'session',
      batchId: '00000000-0000-4000-8000-000000000001', writerGeneration: '00000000-0000-4000-8000-000000000002',
      controlEpoch: '00000000-0000-4000-8000-000000000003', facts: [{ privateContent: 'must-never-upload' }] } };
  return { ledger, telemetry, fetch, request, advance: () => { now += 10000; } };
}
const queries = (fetch: ReturnType<typeof vi.fn>): URLSearchParams[] => fetch.mock.calls.map(call => new URL(call[0]).searchParams);

describe('synchronization hooks through the real reporter', () => {
  it('uploads the committed control operation through its real schema without body content or duplicate sealing', async () => {
    const f = fixture(); f.ledger.saveRequest(f.request); f.ledger.saveRequest(f.request);
    expect(f.telemetry.snapshot().queued).toBe(1);
    await f.telemetry.pump();
    const query = queries(f.fetch)[0];
    expect(query.get('event_name')).toBe(RemoteTelemetryEvent.Sealed);
    expect(query.get('operation_id')).toBe(f.request.body.batchId);
    expect(query.get('publication_kind')).toBe('control_facts');
    expect(query.get('writer_generation')).toBe(f.request.body.writerGeneration);
    expect(query.get('business_status')).toBe('pending');
    expect(query.get('remote_owner_id')).toBe('owner');
    expect(f.fetch.mock.calls[0][0]).not.toContain('must-never-upload');
    expect(f.telemetry.snapshot().stats.invalid_event ?? 0).toBe(0);
  });
  it('does not send a sealed event from a rolled-back outer ledger transaction', async () => {
    const f = fixture();
    expect(() => f.ledger.db.transaction(() => { f.ledger.saveRequest(f.request); throw new Error('rollback'); })()).toThrow('rollback');
    expect(f.ledger.request(f.request.key)).toBeNull();
    await f.telemetry.pump(); expect(f.fetch).not.toHaveBeenCalled();
    f.ledger.saveRequest(f.request); await f.telemetry.pump();
    expect(queries(f.fetch)[0].get('event_name')).toBe(RemoteTelemetryEvent.Sealed);
  });
  it('reports the local ACK commit failure and keeps the original live operation pending', async () => {
    const f = fixture();
    const request: AvailabilityRequest = { ...f.request, lane: 'live', pathname: '/sync/live-projections', version: 3,
      body: { ...f.request.body, publicationId: f.request.key, objectKind: 'message', objectId: 'message',
        sourceObjectRevision: '2', representation: 'complete' } };
    f.ledger.saveRequest(request);
    f.ledger.db.exec("CREATE TRIGGER fail_ack BEFORE INSERT ON availability_objects BEGIN SELECT RAISE(ABORT,'disk unavailable'); END");
    expect(() => f.ledger.completeObject(request, { publicationId: request.key, state: 'accepted' })).toThrow('disk unavailable');
    expect(f.ledger.request(request.key)).not.toBeNull();
    for (let i = 0; i < 3; i++) { await f.telemetry.pump(); f.advance(); }
    const sent = queries(f.fetch);
    expect(sent.some(query => query.get('event_name') === RemoteTelemetryEvent.SyncStage
      && query.get('stage') === 'local_ack_commit' && query.get('outcome') === 'failed')).toBe(true);
    expect(sent.some(query => query.get('event_name') === RemoteTelemetryEvent.Acknowledged)).toBe(false);
    expect(JSON.stringify(f.fetch.mock.calls)).not.toContain('disk unavailable');
  });
});
