import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { LibraryArtifactType, LibraryOrigin, LibraryRelationKind } from '../../shared/library/constants';
import type { LibraryArtifactCandidate } from '../../shared/library/types';
import { LibraryIndexService } from './libraryIndexService';
import { type LibraryIndexedFile, LibraryLocalStore } from './libraryLocalStore';
import { initializeLibraryTables } from './libraryMigrations';

const disposables: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposables.splice(0).reverse()) dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'verified-library-candidate-'));
  disposables.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'report.md');
  fs.writeFileSync(source, 'Delivered report');
  const original = fs.statSync(source);
  const fileIdentity = `${original.dev}:${original.ino}:${Math.trunc(original.birthtimeMs)}`;
  const db = new Database(':memory:');
  disposables.push(() => db.close());
  db.exec(`CREATE TABLE cowork_sessions (
    id TEXT PRIMARY KEY, title TEXT, cwd TEXT, agent_id TEXT,
    created_at INTEGER, updated_at INTEGER
  )`);
  db.prepare("INSERT INTO cowork_sessions VALUES ('s', 'Task', ?, 'main', 100, 100)").run(directory);
  initializeLibraryTables(db);
  const store = new LibraryLocalStore(db);
  const upsert = vi.spyOn(store, 'upsertFile');
  const changed = vi.fn();
  const service = new LibraryIndexService({
    store, userDataPath: path.join(directory, 'user-data'), onChanged: changed,
    getMetadata: () => undefined, setMetadata: () => undefined,
  });
  disposables.push(() => service.stop());
  const candidate: LibraryArtifactCandidate = {
    sessionId: 's', messageId: 'final', filePath: source,
    detectedType: LibraryArtifactType.Markdown,
    relationKind: LibraryRelationKind.Modified, relatedAt: 100, origin: LibraryOrigin.Conversation,
  };
  const assertOwner = vi.fn();
  const validate = vi.fn((indexed: LibraryIndexedFile) => {
    if (indexed.filePath !== source || indexed.fileIdentity !== fileIdentity) throw new Error('Delivered file changed');
  });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  return { directory, source, db, store, service, candidate, fileIdentity, upsert, changed, assertOwner, validate };
}

describe('verified library artifact candidates', () => {
  test('validates the resolved indexed file after ownership and before writing', async () => {
    const f = fixture();
    await expect(f.service.recordCandidates([f.candidate], undefined, f.assertOwner, f.validate))
      .resolves.toEqual({ recorded: 1, ignored: 0 });

    expect(f.validate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      filePath: f.source, fileIdentity: f.fileIdentity, sizeBytes: Buffer.byteLength('Delivered report'),
    }));
    expect(f.assertOwner.mock.invocationCallOrder.at(-1)).toBeLessThan(f.validate.mock.invocationCallOrder[0]);
    expect(f.validate.mock.invocationCallOrder[0]).toBeLessThan(f.upsert.mock.invocationCallOrder[0]);
    expect(f.store.list().list).toHaveLength(1);
    expect(f.changed).toHaveBeenCalledOnce();
  });

  test('rejects a source swapped to a symlink before it can index the old target', async () => {
    const f = fixture();
    const oldTarget = path.join(f.directory, 'old-private-report.md');
    fs.writeFileSync(oldTarget, 'Existing private content');
    fs.unlinkSync(f.source);
    fs.symlinkSync(oldTarget, f.source);

    await expect(f.service.recordCandidates([f.candidate], undefined, f.assertOwner, f.validate))
      .resolves.toEqual({ recorded: 0, ignored: 1 });
    expect(f.validate).toHaveBeenCalledWith(expect.objectContaining({ filePath: oldTarget }));
    expect(f.upsert).not.toHaveBeenCalled();
    expect(f.store.list().list).toEqual([]);
    expect(f.changed).not.toHaveBeenCalled();
  });

  test('rejects replacement bytes at the same path when their identity differs', async () => {
    const f = fixture();
    const replacement = path.join(f.directory, 'replacement.md');
    fs.writeFileSync(replacement, 'Replacement content');
    fs.renameSync(replacement, f.source);

    await expect(f.service.recordCandidates([f.candidate], undefined, f.assertOwner, f.validate))
      .resolves.toEqual({ recorded: 0, ignored: 1 });
    expect(f.validate).toHaveBeenCalledWith(expect.objectContaining({ filePath: f.source }));
    expect(f.validate.mock.calls[0][0].fileIdentity).not.toBe(f.fileIdentity);
    expect(f.upsert).not.toHaveBeenCalled();
    expect(f.store.list().list).toEqual([]);
  });

  test('keeps existing callers compatible when no indexed-file validation is supplied', async () => {
    const f = fixture();
    await expect(f.service.recordCandidates([f.candidate], undefined, f.assertOwner))
      .resolves.toEqual({ recorded: 1, ignored: 0 });
    expect(f.upsert).toHaveBeenCalledOnce();
    expect(f.store.list().list[0].filePath).toBe(f.source);
  });

  test.each([false, true])('retains validation across repeated deferred retries (missing=%s)', async missing => {
    vi.useFakeTimers();
    const f = fixture();
    const resolver = vi.spyOn(f.service as unknown as {
      resolveIndexedFile(filePath: string, origin: LibraryOrigin): Promise<LibraryIndexedFile | null>;
    }, 'resolveIndexedFile');
    if (missing) {
      const error = Object.assign(new Error('Not present yet'), { code: 'ENOENT' });
      resolver.mockRejectedValueOnce(error).mockRejectedValueOnce(error);
    } else {
      resolver.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    }
    let validationReached: (() => void) | undefined;
    const reached = new Promise<void>(resolve => { validationReached = resolve; });
    const validate = vi.fn(() => {
      validationReached?.();
      throw new Error('Snapshot identity is stale');
    });
    await expect(f.service.recordCandidates([f.candidate], undefined, f.assertOwner, validate))
      .resolves.toEqual({ recorded: 0, ignored: 1 });
    await vi.advanceTimersByTimeAsync(250);
    expect(resolver).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    await reached;

    expect(validate).toHaveBeenCalledOnce();
    expect(f.upsert).not.toHaveBeenCalled();
    expect(f.store.list().list).toEqual([]);
    expect(f.changed).not.toHaveBeenCalled();
  });
});
