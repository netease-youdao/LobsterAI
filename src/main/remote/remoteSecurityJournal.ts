import { createHmac, timingSafeEqual } from 'crypto';
import { Worker } from 'worker_threads';

import { payloadHash, stableJson } from './canonical';
import type { RemoteIdentity } from './installationIdentity';
import type { QuestionEvidenceBinding } from './remoteQuestionEvidence';
import { RemoteWorkerFile, remoteWorkerPath } from './remoteWorkerPath';

const VERSION = 1;
const GENESIS = '0'.repeat(64);
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_BYTES = 64 * 1024;
export const RemoteSecurityRecovery = { Ready: 'ready', Finalized: 'finalized', CancellationRequired: 'cancellation_required' } as const;
export interface RemoteSecurityCommit {
  version: 1; identityDigest: string; sequence: number; operationId: string;
  previousDigest: string; operationDigest: string; recordDigest: string;
}
interface Head { sequence: number; recordDigest: string }
interface Anchor { version: 1; identityDigest: string; committed: Head; pending: RemoteSecurityCommit | null }
export interface RemoteSecurityEvidence {
  /** Highest authenticated core record. Its own digest is verified before it is used. */
  head: RemoteSecurityCommit | null;
  restored: boolean;
  hasConflict: boolean;
  /** Only set after exact legacy DB/external checkpoint equality, or a proven new DB. */
  legacyCheckpointVerified?: boolean;
  /** Durable receipt written by the caller before cancelling a not-finalized pending record. */
  cancelledOperationDigest?: string;
}
export interface RemoteSecurityJournalIo {
  read(): Promise<{ current: string | null; previous: string | null }>;
  replace(expected: string | null, content: string): Promise<void>;
  close(): void;
  restart?(): Promise<void>;
}
export class RemoteSecurityJournalError extends Error {
  constructor(message: string) { super(message); this.name = 'RemoteSecurityJournalError'; }
}

/** Dedicated serial file worker. A timeout is an unknown write, never a successful cancellation. */
export class RemoteSecurityJournalWorkerIo implements RemoteSecurityJournalIo {
  private worker: Worker;
  private termination: Promise<number> | null = null;
  private closed = false;
  private id = 0;
  private failed = false;
  private requests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private directory: string, private timeoutMs = 5000) {
    this.worker = this.createWorker();
  }
  private createWorker(): Worker {
    const worker = new Worker(remoteWorkerPath(RemoteWorkerFile.SecurityJournal), { workerData: { directory: this.directory } });
    this.worker = worker;
    this.worker.unref();
    this.worker.on('message', (response: { id: number; value?: unknown; error?: string }) => {
      const request = this.requests.get(response.id);
      if (!request) return;
      clearTimeout(request.timer); this.requests.delete(response.id);
      if (response.error) request.reject(new RemoteSecurityJournalError(response.error)); else request.resolve(response.value);
    });
    this.worker.on('error', () => { if (this.worker === worker) this.fail(); });
    this.worker.on('exit', () => { if (this.worker === worker) this.fail(); });
    return worker;
  }
  private fail(): void {
    this.failed = true;
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(new RemoteSecurityJournalError('Journal write outcome is unknown')); }
    this.requests.clear();
  }
  private request(operation: 'read' | 'replace', data: { expected?: string | null; content?: string } = {}): Promise<unknown> {
    if (this.failed || this.requests.size >= 2) return Promise.reject(new RemoteSecurityJournalError('Journal worker unavailable'));
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => { this.fail(); this.termination ??= this.worker.terminate(); }, this.timeoutMs);
      this.requests.set(id, { resolve, reject, timer });
      try { this.worker.postMessage({ id, operation, ...data }); } catch { this.fail(); }
    });
  }
  async read(): Promise<{ current: string | null; previous: string | null }> { return await this.request('read') as { current: string | null; previous: string | null }; }
  async replace(expected: string | null, content: string): Promise<void> { await this.request('replace', { expected, content }); }
  async restart(): Promise<void> {
    if (this.closed) throw new RemoteSecurityJournalError('Journal is closed');
    this.fail();
    this.termination ??= this.worker.terminate();
    await this.termination;
    if (this.closed) throw new RemoteSecurityJournalError('Journal is closed');
    this.worker = this.createWorker();
    this.termination = null;
    this.failed = false;
  }
  close(): void { this.closed = true; this.fail(); this.termination ??= this.worker.terminate(); }
}

export class RemoteSecurityJournal {
  private readonly identityDigest: string;
  private readonly key: Buffer;
  private anchor: Anchor | null = null;
  private encoded: string | null = null;
  private active = false;
  private poisoned = false;
  constructor(private identity: RemoteIdentity, private io: RemoteSecurityJournalIo, private singleWriterVerified: boolean) {
    this.identityDigest = payloadHash({ installationId: identity.installationId, databaseId: identity.databaseId });
    this.key = createHmac('sha256', Buffer.from(identity.deviceKey, 'base64url')).update('lobsterai.remote.security.v1').digest();
  }
  private mac(domain: string, value: unknown): string { return createHmac('sha256', this.key).update(domain).update('\0').update(stableJson(value)).digest('hex'); }
  private equal(a: string, b: string): boolean { return DIGEST.test(a) && DIGEST.test(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); }
  private verifyRecord(record: RemoteSecurityCommit): boolean {
    if (!record || record.version !== VERSION || record.identityDigest !== this.identityDigest || !Number.isSafeInteger(record.sequence)
      || record.sequence < 1 || typeof record.operationId !== 'string' || !record.operationId || record.operationId.length > 128
      || !DIGEST.test(record.previousDigest) || !DIGEST.test(record.operationDigest) || !DIGEST.test(record.recordDigest)) return false;
    const { recordDigest, ...body } = record;
    return this.equal(recordDigest, this.mac('commit', body));
  }
  verifyCommit(record: RemoteSecurityCommit): boolean { return this.verifyRecord(record); }
  private coreHead(evidence: RemoteSecurityEvidence): Head {
    if (evidence.restored || evidence.hasConflict || !this.singleWriterVerified) throw new RemoteSecurityJournalError('Remote identity requires recovery');
    if (!evidence.head) return { sequence: 0, recordDigest: GENESIS };
    if (!this.verifyRecord(evidence.head)) throw new RemoteSecurityJournalError('Invalid core security evidence');
    return { sequence: evidence.head.sequence, recordDigest: evidence.head.recordDigest };
  }
  private matches(a: Head, b: Head): boolean { return a.sequence === b.sequence && a.recordDigest === b.recordDigest; }
  private encode(anchor: Anchor): string { return stableJson({ anchor, mac: this.mac('anchor', anchor) }); }
  private decode(text: string): Anchor {
    if (Buffer.byteLength(text) > MAX_BYTES) throw new RemoteSecurityJournalError('Journal exceeds size limit');
    const parsed = JSON.parse(text) as { anchor: Anchor; mac: string };
    const a = parsed.anchor;
    if (!a || a.version !== VERSION || a.identityDigest !== this.identityDigest || !this.equal(parsed.mac, this.mac('anchor', a))
      || !a.committed || !Number.isSafeInteger(a.committed.sequence) || a.committed.sequence < 0 || !DIGEST.test(a.committed.recordDigest)
      || (a.committed.sequence === 0 && a.committed.recordDigest !== GENESIS)
      || (a.pending && (!this.verifyRecord(a.pending) || a.pending.sequence !== a.committed.sequence + 1 || a.pending.previousDigest !== a.committed.recordDigest))) {
      throw new RemoteSecurityJournalError('Invalid external security evidence');
    }
    return a;
  }
  private async exclusive<T>(run: () => Promise<T>): Promise<T> {
    if (this.active || this.poisoned || !this.singleWriterVerified) throw new RemoteSecurityJournalError('Remote security journal unavailable');
    this.active = true;
    try { return await run(); } catch (error) { this.poisoned = true; throw error; } finally { this.active = false; }
  }
  private async persist(anchor: Anchor): Promise<void> {
    const encoded = this.encode(anchor);
    await this.io.replace(this.encoded, encoded);
    this.encoded = encoded; this.anchor = anchor;
  }
  async initialize(evidence: RemoteSecurityEvidence): Promise<{ status: typeof RemoteSecurityRecovery[keyof typeof RemoteSecurityRecovery]; pending?: RemoteSecurityCommit }> {
    return this.exclusive(async () => {
      const head = this.coreHead(evidence);
      const files = await this.io.read();
      if (files.current === null) {
        if (files.previous !== null || !evidence.legacyCheckpointVerified || head.sequence !== 0) throw new RemoteSecurityJournalError('Missing current security anchor');
        await this.persist({ version: VERSION, identityDigest: this.identityDigest, committed: head, pending: null });
        return { status: RemoteSecurityRecovery.Ready };
      }
      // A previous slot is retained for diagnosis, not accepted as proof of the latest tail.
      this.anchor = this.decode(files.current); this.encoded = files.current;
      if (this.anchor.pending) {
        const pending = this.anchor.pending;
        if (this.matches(head, pending)) {
          await this.persist({ ...this.anchor, committed: head, pending: null });
          return { status: RemoteSecurityRecovery.Finalized };
        }
        if (this.matches(head, this.anchor.committed)) return { status: RemoteSecurityRecovery.CancellationRequired, pending };
        throw new RemoteSecurityJournalError('Pending security record conflicts with the core');
      }
      if (!this.matches(head, this.anchor.committed)) throw new RemoteSecurityJournalError('Core security history differs from external anchor');
      return { status: RemoteSecurityRecovery.Ready };
    });
  }
  /** Reopen only after the old writer has exited; initialize rechecks the exact durable head. */
  async recover(evidence: RemoteSecurityEvidence): Promise<{ status: typeof RemoteSecurityRecovery[keyof typeof RemoteSecurityRecovery]; pending?: RemoteSecurityCommit }> {
    if (this.active || !this.singleWriterVerified || !this.io.restart) throw new RemoteSecurityJournalError('Journal cannot safely restart');
    await this.io.restart();
    this.anchor = null; this.encoded = null; this.poisoned = false;
    return this.initialize({ ...evidence, legacyCheckpointVerified: false });
  }
  async prepare(operation: { operationId: string; operationDigest: string }): Promise<RemoteSecurityCommit> {
    return this.exclusive(async () => {
      if (!this.anchor || this.anchor.pending || !operation.operationId || operation.operationId.length > 128 || !DIGEST.test(operation.operationDigest)) throw new RemoteSecurityJournalError('Invalid security transition');
      const body = { version: VERSION, identityDigest: this.identityDigest, sequence: this.anchor.committed.sequence + 1,
        operationId: operation.operationId, previousDigest: this.anchor.committed.recordDigest, operationDigest: operation.operationDigest } as const;
      if (!Number.isSafeInteger(body.sequence)) throw new RemoteSecurityJournalError('Security sequence exhausted');
      const record = { ...body, recordDigest: this.mac('commit', body) };
      await this.persist({ ...this.anchor, pending: record });
      return record;
    });
  }
  async finalize(record: RemoteSecurityCommit, readCore: () => RemoteSecurityEvidence): Promise<void> {
    await this.exclusive(async () => {
      const head = this.coreHead(readCore());
      if (!this.anchor?.pending || !this.verifyRecord(record) || !this.matches(this.anchor.pending, record) || !this.matches(head, record)) throw new RemoteSecurityJournalError('Security transition is not durably committed');
      await this.persist({ ...this.anchor, committed: head, pending: null });
    });
  }
  async cancelPending(record: RemoteSecurityCommit, readCore: () => RemoteSecurityEvidence): Promise<void> {
    await this.exclusive(async () => {
      const evidence = readCore(); const head = this.coreHead(evidence);
      if (!this.anchor?.pending || !this.verifyRecord(record) || !this.matches(this.anchor.pending, record)
        || !this.matches(head, this.anchor.committed) || evidence.cancelledOperationDigest !== record.recordDigest) throw new RemoteSecurityJournalError('Pending cancellation lacks durable evidence');
      await this.persist({ ...this.anchor, pending: null });
    });
  }
  /** Small authenticated immutable ownership facts; never signs message bodies or mutable state. */
  signOwnership(fact: { sessionId: string; ownerUserId: string; scopeKey: string; ownershipRevision: number; operationId: string }): string {
    return this.mac('ownership', { ...fact, identityDigest: this.identityDigest });
  }
  verifyOwnership(fact: Parameters<RemoteSecurityJournal['signOwnership']>[0], proof: string): boolean { return this.equal(proof, this.signOwnership(fact)); }
  signQuestionBinding(fact: QuestionEvidenceBinding): string { return this.mac('question-binding', { ...fact, identityDigest: this.identityDigest }); }
  verifyQuestionBinding(fact: QuestionEvidenceBinding, proof: string): boolean { return this.equal(proof, this.signQuestionBinding(fact)); }
  close(): void { this.poisoned = true; this.io.close(); }
}
