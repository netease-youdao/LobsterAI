import { describe, expect, test } from 'vitest';

import { payloadHash } from './canonical';
import { type RemoteIdentity } from './installationIdentity';
import {
  RemoteSecurityJournal, type RemoteSecurityJournalIo, RemoteSecurityRecovery,
} from './remoteSecurityJournal';

const identity: RemoteIdentity = { installationId: 'installation-1', databaseId: 'database-1', deviceKey: Buffer.alloc(32, 7).toString('base64url') };
const empty = { head: null, restored: false, hasConflict: false, legacyCheckpointVerified: true };
const operation = { operationId: 'command-1:prepare', operationDigest: payloadHash({ commandId: 'command-1', actor: 'owner-a' }) };
class MemoryIo implements RemoteSecurityJournalIo {
  current: string | null = null;
  previous: string | null = null;
  failAfterWrite = false;
  async read() { return { current: this.current, previous: this.previous }; }
  async replace(expected: string | null, content: string) {
    if (this.current !== expected) throw new Error('Unexpected writer');
    this.previous = this.current; this.current = content;
    if (this.failAfterWrite) throw new Error('Lost write acknowledgement');
  }
  close() { /* no process in the isolated transport */ }
}
const journal = (io: RemoteSecurityJournalIo, who = identity) => new RemoteSecurityJournal(who, io, true);

describe('remote security journal crash boundaries', () => {
  test('external prepare and a matching core commit are required before a transition can finalize', async () => {
    const io = new MemoryIo(); const writer = journal(io);
    await writer.initialize(empty);
    const record = await writer.prepare(operation);
    await expect(writer.finalize(record, () => empty)).rejects.toThrow('not durably committed');
    // The poisoned instance cannot dispatch/retry. Recovery requires fresh evidence.
    await expect(writer.prepare(operation)).rejects.toThrow('unavailable');
    const recovered = journal(io);
    expect(await recovered.initialize({ ...empty, head: record })).toEqual({ status: RemoteSecurityRecovery.Finalized });
    const next = await recovered.prepare({ ...operation, operationId: 'command-2:prepare' });
    expect(next.sequence).toBe(2);
    expect(next.previousDigest).toBe(record.recordDigest);
    await recovered.finalize(next, () => ({ ...empty, head: next }));
    expect(await journal(io).initialize({ ...empty, head: next })).toEqual({ status: RemoteSecurityRecovery.Ready });
  });
  test('pending plus predecessor requires a durable cancellation receipt, never a new execution permit', async () => {
    const io = new MemoryIo(); const writer = journal(io); await writer.initialize(empty);
    const record = await writer.prepare(operation);
    const recovered = journal(io);
    expect(await recovered.initialize(empty)).toEqual({ status: RemoteSecurityRecovery.CancellationRequired, pending: record });
    await expect(recovered.cancelPending(record, () => empty)).rejects.toThrow('durable evidence');
    const verified = journal(io); await verified.initialize(empty);
    await verified.cancelPending(record, () => ({ ...empty, cancelledOperationDigest: record.recordDigest }));
    expect(await journal(io).initialize(empty)).toEqual({ status: RemoteSecurityRecovery.Ready });
  });
  test('lost acknowledgement leaves an unknown write which a fresh instance reconciles', async () => {
    const io = new MemoryIo(); const writer = journal(io); await writer.initialize(empty);
    io.failAfterWrite = true;
    await expect(writer.prepare(operation)).rejects.toThrow('Lost write acknowledgement');
    io.failAfterWrite = false;
    const recovered = await journal(io).initialize(empty);
    expect(recovered.status).toBe(RemoteSecurityRecovery.CancellationRequired);
    expect(recovered.pending?.operationId).toBe(operation.operationId);
  });
  test('a restored DB cannot roll back an external committed anchor', async () => {
    const io = new MemoryIo(); const writer = journal(io); await writer.initialize(empty);
    const record = await writer.prepare(operation); await writer.finalize(record, () => ({ ...empty, head: record }));
    await expect(journal(io).initialize(empty)).rejects.toThrow('differs');
    await expect(journal(io).initialize({ ...empty, head: record, restored: true })).rejects.toThrow('requires recovery');
  });
  test('a corrupt or missing current slot is not silently replaced by a previous slot', async () => {
    const io = new MemoryIo(); const writer = journal(io); await writer.initialize(empty); await writer.prepare(operation);
    io.current = '{broken';
    await expect(journal(io).initialize(empty)).rejects.toThrow();
    io.current = null;
    await expect(journal(io).initialize(empty)).rejects.toThrow('Missing current');
  });
  test('bootstrap needs proof and the correct installation, key, writer and core record', async () => {
    const io = new MemoryIo();
    await expect(journal(io).initialize({ ...empty, legacyCheckpointVerified: false })).rejects.toThrow('Missing current');
    const writer = journal(io); await writer.initialize(empty); const record = await writer.prepare(operation);
    await expect(journal(io, { ...identity, databaseId: 'copy' }).initialize(empty)).rejects.toThrow('Invalid external');
    await expect(journal(io).initialize({ ...empty, head: { ...record, operationId: 'forged' } })).rejects.toThrow('Invalid core');
    await expect(new RemoteSecurityJournal(identity, io, false).initialize(empty)).rejects.toThrow('unavailable');
  });
  test('ownership proof is bound to identity, account, scope, session and operation', () => {
    const writer = journal(new MemoryIo());
    const fact = { sessionId: 's1', ownerUserId: 'a', scopeKey: 'personal', ownershipRevision: 1, operationId: 'create-1' };
    const proof = writer.signOwnership(fact);
    expect(writer.verifyOwnership(fact, proof)).toBe(true);
    expect(writer.verifyOwnership({ ...fact, ownerUserId: 'b' }, proof)).toBe(false);
    expect(writer.verifyOwnership({ ...fact, sessionId: 's2' }, proof)).toBe(false);
    expect(writer.verifyOwnership({ ...fact, scopeKey: 'team:1' }, proof)).toBe(false);
    expect(journal(new MemoryIo(), { ...identity, installationId: 'copy' }).verifyOwnership(fact, proof)).toBe(false);
  });
});
