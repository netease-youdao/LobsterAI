import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { LibraryRelationKind } from '../../shared/library/constants';
import type { LibraryArtifactCandidate } from '../../shared/library/types';
import type { RemoteOwner } from '../../shared/remote/constants';
import type { RemoteFilePolicy } from '../../shared/remote/files';
import type { LibraryIndexedFile } from '../library/libraryLocalStore';
import { initializeLibraryTables } from '../library/libraryMigrations';
import { RemoteDeliveredFileSync } from './remoteDeliveredFileSync';
import type { RemoteFileSnapshot } from './remoteFileSnapshots';
import { RemoteStore } from './remoteStore';

const owner: RemoteOwner = { userId: 'A', scopeKey: 'personal' };
const otherOwner: RemoteOwner = { userId: 'B', scopeKey: 'personal' };
const disposables: Array<() => void> = [];
const policy: RemoteFilePolicy = {
  policyVersion: '1',
  features: { inputUpload: true, desktopInputSync: true, artifactPublish: true, artifactDownload: true },
  types: [{ category: 'text', extensions: ['md', 'txt'], maxFileBytes: '5242880', inputAllowed: true, artifactAutoSync: true }],
  limits: { partBytes: '4194304', maxInputCount: 10, maxInputBytes: '104857600', maxImageBytes: '20971520',
    maxTaskArtifactCount: 20, maxTaskArtifactBytes: '209715200' },
};

afterEach(() => {
  for (const dispose of disposables.splice(0).reverse()) dispose();
  vi.restoreAllMocks();
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'delivered-files-test-'));
  disposables.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, 'workspace');
  const desktop = path.join(directory, 'Desktop');
  const cacheRoot = path.join(directory, 'cache');
  fs.mkdirSync(workspace);
  fs.mkdirSync(desktop);
  const source = path.join(workspace, 'report.md');
  const db = new Database(':memory:');
  disposables.push(() => db.close());
  db.exec(`
    CREATE TABLE cowork_sessions (
      id TEXT PRIMARY KEY, title TEXT, cwd TEXT, agent_id TEXT,
      created_at INTEGER, updated_at INTEGER, status TEXT
    );
    CREATE TABLE cowork_messages (
      id TEXT PRIMARY KEY, session_id TEXT, type TEXT, content TEXT,
      metadata TEXT, created_at INTEGER, sequence INTEGER
    );
  `);
  initializeLibraryTables(db);
  const store = new RemoteStore(db, { restoreRuns: false });
  store.transaction(() => {
    db.prepare("INSERT INTO cowork_sessions VALUES ('s','Task',?,'main',?,?, 'running')")
      .run(workspace, Date.now(), Date.now());
    store.assignNew('s', owner, 'local_create');
  });
  store.beginRun('s', 'run1');
  let actor = owner;
  let epoch = 1;
  let permitted = true;
  let accessAllowed = true;
  const events: string[] = [];
  const access = vi.fn((_filePath: string) => ({
    assertAllowed: () => {
      if (!accessAllowed) throw new Error('Access revoked');
    },
  }));
  const recordArtifact = vi.fn(async (candidate: LibraryArtifactCandidate, _owner: RemoteOwner, assertCurrent: () => void, validateIndexed: (file: LibraryIndexedFile) => void) => {
    assertCurrent();
    const stat = fs.statSync(candidate.filePath);
    validateIndexed({ filePath: candidate.filePath, fileIdentity: `${stat.dev}:${stat.ino}:${Math.trunc(stat.birthtimeMs)}`,
      sizeBytes: stat.size, fileMtimeMs: Math.trunc(stat.mtimeMs) } as LibraryIndexedFile);
    events.push('record');
    return true;
  });
  const sync = new RemoteDeliveredFileSync({ store, cacheRoot, access, recordArtifact });
  const accept = vi.fn((_sessionId: string, _messageId: string, _runId: string, _filePath: string, _snapshot: RemoteFileSnapshot) => {
    events.push('accept');
    return true;
  });
  const prepare = async () => {
    const preparedEpoch = epoch;
    await sync.prepare('s', [workspace, desktop], actor, () => epoch === preparedEpoch && permitted);
  };
  const collect = (rules = policy) => sync.collect(actor, rules, sessionId => sessionId === 's' && permitted, accept);
  let sequence = 0;
  const message = (id: string, type: string, content: string, metadata: Record<string, unknown>) => {
    store.transaction(() => {
      db.prepare('INSERT INTO cowork_messages VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, 's', type, content, JSON.stringify({ remoteRunId: 'run1', ...metadata }), Date.now(), ++sequence);
    });
  };
  const finish = (options: {
    linkedPath?: string;
    exitCode?: number | null;
    resultFinal?: boolean;
    resultError?: boolean;
    resultRunId?: string;
    toolName?: string;
    assistantText?: string;
    status?: 'succeeded' | 'failed';
  } = {}) => {
    const exitCode = options.exitCode === undefined ? 0 : options.exitCode;
    message('tool-use', 'tool_use', 'Using tool: exec', {
      toolName: options.toolName ?? 'exec', toolUseId: 'exec-1', toolInput: { command: 'python generate_report.py' },
    });
    message('tool-result', 'tool_result', 'Finished', {
      toolUseId: 'exec-1', isFinal: options.resultFinal ?? true, isStreaming: false, isError: options.resultError ?? false,
      remoteRunId: options.resultRunId ?? 'run1',
      toolResultDetails: exitCode === null ? {} : { exitCode },
    });
    message('final', 'assistant', options.assistantText ?? `Created [report](${options.linkedPath ?? source})`, { isFinal: true, isStreaming: false });
    // Filesystem timestamps retain sub-millisecond precision; run ISO timestamps do not.
    const finishedAt = Date.now() + 2;
    const now = vi.spyOn(Date, 'now').mockReturnValue(finishedAt);
    try { store.updateRun('s', options.status ?? 'succeeded'); } finally { now.mockRestore(); }
    return finishedAt;
  };
  return { db, store, sync, source, workspace, desktop, directory, cacheRoot, access, recordArtifact, accept, events, prepare, collect, finish,
    write: (value = 'New delivered content', filePath = source) => fs.writeFileSync(filePath, value),
    setPermitted: (value: boolean) => { permitted = value; },
    revokeAccess: () => { accessAllowed = false; },
    switchAccount: (value: RemoteOwner) => { actor = value; epoch++; },
  };
}

describe('delivered files require live preparation and current successful-run evidence', () => {
  test.each([false, true])('accepts a new or overwritten explicit deliverable (overwrite=%s)', async overwrite => {
    const f = fixture();
    if (overwrite) f.write('Old content');
    await f.prepare();
    f.write('New delivered content');
    f.finish();

    await f.collect();

    expect(f.recordArtifact).toHaveBeenCalledOnce();
    expect(f.recordArtifact.mock.calls[0][0]).toMatchObject({
      sessionId: 's', messageId: 'final', filePath: f.source, relationKind: LibraryRelationKind.Modified,
    });
    expect(f.accept).toHaveBeenCalledOnce();
    const [sessionId, messageId, runId, filePath, snapshot] = f.accept.mock.calls[0];
    expect([sessionId, messageId, runId, filePath]).toEqual(['s', 'final', 'run1', f.source]);
    expect(snapshot.path).not.toBe(f.source);
    expect(snapshot.identity).toBeTruthy();
    expect(snapshot.cacheIdentity).toBeTruthy();
    expect(fs.readFileSync(snapshot.path, 'utf8')).toBe('New delivered content');
    expect(f.events).toEqual(['record', 'accept']);
  });

  test.each(['png', 'jpg', 'jpeg', 'webp', 'gif'])('registers a changed local .%s image returned inline in the final reply', async extension => {
    const f = fixture(), target = path.join(f.workspace, `result.${extension}`);
    const rules = structuredClone(policy);
    rules.types.push({ category: 'image', extensions: [extension], maxFileBytes: '10485760', inputAllowed: true, artifactAutoSync: true });
    await f.prepare();
    // Discovery seals bytes; format validation remains the server inspection stage.
    f.write('generated image bytes', target);
    f.finish({ assistantText: `Generated ![result](${target}) [download](${target})` });
    await f.collect(rules);
    expect(f.recordArtifact).toHaveBeenCalledOnce();
    expect(f.recordArtifact.mock.calls[0][0]).toMatchObject({ filePath: target, detectedType: 'image' });
    expect(f.accept).toHaveBeenCalledOnce();
    expect(fs.readFileSync(f.accept.mock.calls[0][4].path, 'utf8')).toBe('generated image bytes');
  });

  test('keeps an existing inline image reference local and obeys server image restrictions', async () => {
    const f = fixture(), target = path.join(f.workspace, 'existing.png');
    f.write('existing image', target);
    await f.prepare();
    f.finish({ assistantText: `![reference](${target})` });
    const rules = structuredClone(policy);
    rules.types.push({ category: 'image', extensions: ['png'], maxFileBytes: '10485760', inputAllowed: true, artifactAutoSync: true });
    await f.collect(rules);
    expect(f.accept).not.toHaveBeenCalled();
    const next = fixture(), output = path.join(next.workspace, 'output.png');
    await next.prepare(); next.write('generated', output); next.finish({ assistantText: `![image](${output})` });
    await next.collect(); // This server policy has no image admission.
    expect(next.accept).not.toHaveBeenCalled();
  });

  test.each(['json', 'yaml', 'yml', 'xml', 'js', 'ts', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'go', 'rs', 'sh', 'sql'])
    ('registers delivered .%s text/source with the existing server policy', async extension => {
      const f = fixture(), target = path.join(f.workspace, `result.${extension}`);
      const rules = structuredClone(policy);
      rules.types[0].extensions.push(extension);
      await f.prepare(); f.write('text/source bytes', target); f.finish({ linkedPath: target });
      await f.collect(rules);
      expect(f.recordArtifact).toHaveBeenCalledOnce();
      expect(f.recordArtifact.mock.calls[0][0]).toMatchObject({ filePath: target, detectedType: 'code' });
      expect(f.accept).toHaveBeenCalledOnce();
    });

  test('includes the explicit deliverable directly in the Desktop root', async () => {
    const f = fixture();
    const target = path.join(f.desktop, 'report.md');
    await f.prepare();
    f.write('Desktop deliverable', target);
    f.finish({ linkedPath: target });
    await f.collect();
    expect(f.accept).toHaveBeenCalledOnce();
    expect(f.accept.mock.calls[0][3]).toBe(target);
  });

  test('does not treat an unchanged reference as a newly delivered artifact', async () => {
    const f = fixture();
    f.write('Existing referenced content');
    await f.prepare();
    f.finish();
    await f.collect();
    expect(f.recordArtifact).not.toHaveBeenCalled();
    expect(f.accept).not.toHaveBeenCalled();
  });

  test('requires a baseline collected before the terminal event', async () => {
    const f = fixture();
    f.write();
    f.finish();
    await f.prepare();
    await f.collect();
    expect(f.accept).not.toHaveBeenCalled();
  });

  test.each([
    { exitCode: 1 },
    { exitCode: null },
    { exitCode: Number.NaN },
    { exitCode: 0.5 },
    { resultFinal: false },
    { resultError: true },
    { resultRunId: 'another-run' },
    { toolName: 'read' },
    { status: 'failed' as const },
  ])('rejects non-successful execution evidence %j', async evidence => {
    const f = fixture();
    await f.prepare();
    f.write();
    f.finish(evidence);
    await f.collect();
    expect(f.recordArtifact).not.toHaveBeenCalled();
    expect(f.accept).not.toHaveBeenCalled();
  });

  test('requires the final assistant to explicitly link the delivered file', async () => {
    const f = fixture();
    await f.prepare();
    f.write();
    f.finish({ assistantText: 'The task is done. Read the previous reference.' });
    await f.collect();
    expect(f.accept).not.toHaveBeenCalled();
  });

  test('clears all prepared work when file synchronization is paused', async () => {
    const f = fixture();
    await f.prepare();
    f.write();
    f.finish();
    f.sync.clear();
    await f.collect();
    expect(f.accept).not.toHaveBeenCalled();
  });

  test('honors a permission or synchronization pause during collection', async () => {
    const f = fixture();
    await f.prepare();
    f.write();
    f.finish();
    f.setPermitted(false);
    await f.collect();
    expect(f.accept).not.toHaveBeenCalled();
  });

  test('does not revive an old baseline after switching accounts A to B to A', async () => {
    const f = fixture();
    await f.prepare();
    f.write();
    f.finish();
    f.switchAccount(otherOwner);
    f.switchAccount(owner);
    await f.collect();
    expect(f.recordArtifact).not.toHaveBeenCalled();
    expect(f.accept).not.toHaveBeenCalled();
  });

  test('does not attribute the next run bytes to the completed run', async () => {
    const f = fixture();
    await f.prepare();
    f.write();
    f.finish();
    f.store.beginRun('s', 'run2');
    f.write('Next run content');
    await f.collect();
    expect(f.accept).not.toHaveBeenCalled();
  });

  test('rejects a replaced run ordinal even when the run identifier is reused', async () => {
    const f = fixture();
    await f.prepare();
    f.write();
    f.finish();
    f.store.put('fileRunOrdinal:s', '2');
    f.store.put('fileRunOrdinal:s:run1', '2');
    await f.collect();
    expect(f.accept).not.toHaveBeenCalled();
  });

  test('rejects a file rewritten after the successful terminal event', async () => {
    const f = fixture();
    await f.prepare();
    f.write();
    const finishedAt = f.finish();
    f.write('Later unrelated rewrite');
    const later = new Date(finishedAt + 1000);
    fs.utimesSync(f.source, later, later);
    await f.collect();
    expect(f.accept).not.toHaveBeenCalled();
  });

  test.each([
    (rules: RemoteFilePolicy) => { rules.features.artifactPublish = false; },
    (rules: RemoteFilePolicy) => { rules.types[0].artifactAutoSync = false; },
    (rules: RemoteFilePolicy) => { rules.types[0].maxFileBytes = '1'; },
  ])('rechecks the current file policy after preparation', async restrict => {
    const f = fixture();
    await f.prepare();
    f.write();
    f.finish();
    const restricted = structuredClone(policy);
    restrict(restricted);
    await f.collect(restricted);
    expect(f.recordArtifact).not.toHaveBeenCalled();
    expect(f.accept).not.toHaveBeenCalled();
  });

  test('does not read or accept files outside the two prepared roots', async () => {
    const f = fixture();
    const outside = path.join(f.directory, 'private.md');
    await f.prepare();
    f.write('Unrelated file', outside);
    f.finish({ linkedPath: outside });
    await f.collect();
    expect(f.accept).not.toHaveBeenCalled();
    expect(f.recordArtifact).not.toHaveBeenCalled();
  });

  test('revalidates the file access lease before snapshot capture', async () => {
    const f = fixture();
    await f.prepare();
    f.write();
    f.finish();
    f.revokeAccess();
    await f.collect();
    expect(f.recordArtifact).not.toHaveBeenCalled();
    expect(f.accept).not.toHaveBeenCalled();
  });

  test.each([false, true])('does not accept a snapshot if local registration fails (throws=%s)', async throws => {
    const f = fixture();
    await f.prepare();
    f.write();
    f.finish();
    if (throws) f.recordArtifact.mockRejectedValueOnce(new Error('Local registration failed'));
    else f.recordArtifact.mockResolvedValueOnce(false);
    await f.collect();
    expect(f.recordArtifact).toHaveBeenCalledOnce();
    expect(f.accept).not.toHaveBeenCalled();
  });

  test('revalidates the epoch after asynchronous local registration', async () => {
    const f = fixture();
    await f.prepare();
    f.write();
    f.finish();
    f.recordArtifact.mockImplementationOnce(async () => {
      f.switchAccount(otherOwner);
      f.switchAccount(owner);
      return true;
    });
    await f.collect();
    expect(f.recordArtifact).toHaveBeenCalledOnce();
    expect(f.accept).not.toHaveBeenCalled();
  });
});
