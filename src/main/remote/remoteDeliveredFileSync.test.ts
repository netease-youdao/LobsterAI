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
    withoutTools?: boolean;
    assistantText?: string;
    status?: 'succeeded' | 'failed';
  } = {}) => {
    const exitCode = options.exitCode === undefined ? 0 : options.exitCode;
    if (!options.withoutTools) {
      message('tool-use', 'tool_use', 'Using tool: exec', {
        toolName: options.toolName ?? 'exec', toolUseId: 'exec-1', toolInput: { command: 'python generate_report.py' },
      });
      message('tool-result', 'tool_result', 'Finished', {
        toolUseId: 'exec-1', isFinal: options.resultFinal ?? true, isStreaming: false, isError: options.resultError ?? false,
        remoteRunId: options.resultRunId ?? 'run1',
        toolResultDetails: exitCode === null ? {} : { exitCode },
      });
    }
    message('final', 'assistant', options.assistantText ?? `Created [report](${options.linkedPath ?? source})`, { isFinal: true, isStreaming: false });
    // Filesystem timestamps retain sub-millisecond precision; run ISO timestamps do not.
    const finishedAt = Date.now() + 2;
    const now = vi.spyOn(Date, 'now').mockReturnValue(finishedAt);
    try { store.updateRun('s', options.status ?? 'succeeded'); } finally { now.mockRestore(); }
    return finishedAt;
  };
  return { db, store, sync, source, workspace, desktop, directory, cacheRoot, access, recordArtifact, accept, events, prepare, collect, finish, message,
    write: (value = 'New delivered content', filePath = source) => fs.writeFileSync(filePath, value),
    setPermitted: (value: boolean) => { permitted = value; },
    revokeAccess: () => { accessAllowed = false; },
    switchAccount: (value: RemoteOwner) => { actor = value; epoch++; },
  };
}

describe('delivered files require live preparation and current successful-run evidence', () => {
  test('optional preparation never waits for a stuck directory scan or publishes unverified output', async () => {
    const f = fixture();
    vi.spyOn(fs.promises,'lstat').mockImplementation(() => new Promise<fs.Stats>(() => {}));
    f.sync.startPreparation('s',[f.workspace,f.desktop],owner,() => true);
    // The engine can immediately finish its run even though optional directory IO never returns.
    f.write(); f.finish(); await f.collect();
    expect(f.store.run('s')?.status).toBe('succeeded'); expect(f.recordArtifact).not.toHaveBeenCalled();
    await new Promise(resolve => setTimeout(resolve,100));
    await f.collect(); expect(f.accept).not.toHaveBeenCalled();
  });

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

describe('MEDIA explicitly delivers existing files without a producer tool', () => {
  test.each(['symlink', 'parent-symlink', 'outside', 'revoked', 'changed', 'new-run'])('rejects unsafe nested delivery: %s', async rejection => {
    const f = fixture(), nested = path.join(f.workspace, 'nested');
    fs.mkdirSync(nested);
    const target = path.join(nested, 'report.md');
    f.write('existing nested bytes', target);
    await f.prepare();
    let delivered = target;
    if (rejection === 'symlink') {
      delivered = path.join(nested, 'alias.md'); fs.symlinkSync(target, delivered);
    } else if (rejection === 'parent-symlink') {
      const alias = path.join(f.workspace, 'alias'); fs.symlinkSync(nested, alias, 'dir');
      delivered = path.join(alias, 'report.md');
    } else if (rejection === 'outside') {
      const outside = `${f.workspace}-other`; fs.mkdirSync(outside);
      delivered = path.join(outside, 'report.md'); f.write('outside bytes', delivered);
    }
    const finishedAt = f.finish({ withoutTools: true, assistantText: `MEDIA:${delivered}` });
    if (rejection === 'revoked') f.revokeAccess();
    if (rejection === 'changed') fs.utimesSync(target, new Date(finishedAt + 1000), new Date(finishedAt + 1000));
    if (rejection === 'new-run') f.store.beginRun('s', 'run2');
    await f.collect();
    expect(f.accept).not.toHaveBeenCalled();
  });

  test('rejects a nested directory replaced between snapshot capture and library registration', async () => {
    const f = fixture(), nested = path.join(f.workspace, 'nested'), moved = path.join(f.workspace, 'moved');
    fs.mkdirSync(nested);
    const target = path.join(nested, 'report.md'); f.write('original bytes', target);
    await f.prepare();
    f.finish({ withoutTools: true, assistantText: `MEDIA:${target}` });
    f.recordArtifact.mockImplementationOnce(async (_candidate, _owner, assertCurrent, validateIndexed) => {
      assertCurrent();
      fs.renameSync(nested, moved); fs.mkdirSync(nested);
      fs.renameSync(path.join(moved, 'report.md'), target);
      const stat = fs.statSync(target);
      validateIndexed({ filePath: target, fileIdentity: `${stat.dev}:${stat.ino}:${Math.trunc(stat.birthtimeMs)}`,
        sizeBytes: stat.size, fileMtimeMs: Math.trunc(stat.mtimeMs) } as LibraryIndexedFile);
      return true;
    });
    await f.collect();
    expect(f.recordArtifact).toHaveBeenCalledOnce();
    expect(f.accept).not.toHaveBeenCalled();
  });

  test.each([false, true])('delivers an explicitly named nested image (existing=%s)', async existing => {
    const f = fixture(), filePath = path.join(f.workspace, 'sealion06', 'official.jpg');
    const rules = structuredClone(policy);
    rules.types.push({ category: 'image', extensions: ['jpg'], maxFileBytes: '20971520', inputAllowed: true, artifactAutoSync: true });
    const write = () => { fs.mkdirSync(path.dirname(filePath), { recursive: true }); f.write('image bytes', filePath); };
    if (existing) write();
    await f.prepare();
    if (!existing) write();
    f.finish({ withoutTools: true, assistantText: `原图在这里：\nMEDIA:${filePath}` });
    await f.collect(rules);
    expect(f.accept).toHaveBeenCalledOnce();
    expect(f.recordArtifact.mock.calls[0][0]).toMatchObject({ filePath, relationKind: LibraryRelationKind.Referenced });
    expect(fs.readFileSync(f.accept.mock.calls[0][4].path, 'utf8')).toBe('image bytes');
    await f.collect(rules);
    expect(f.accept).toHaveBeenCalledOnce();
  });

  test('seals an unchanged DOCX explicitly resent by inline MEDIA without a producer tool', async () => {
    const f = fixture(), filePath = path.join(f.workspace, '工作简报.docx');
    const rules = structuredClone(policy);
    rules.types.push({ category: 'document', extensions: ['docx'], maxFileBytes: '31457280', inputAllowed: true, artifactAutoSync: true });
    f.write('existing Word document', filePath);
    await f.prepare();
    f.finish({ withoutTools: true, assistantText: `文件在下面，点开就能下载。 MEDIA:${filePath}` });
    await f.collect(rules);
    expect(f.recordArtifact).toHaveBeenCalledOnce();
    expect(f.recordArtifact.mock.calls[0][0]).toMatchObject({ filePath, detectedType: 'document', relationKind: LibraryRelationKind.Referenced });
    expect(f.accept).toHaveBeenCalledOnce();
    expect(fs.readFileSync(f.accept.mock.calls[0][4].path, 'utf8')).toBe('existing Word document');
    expect(f.events).toEqual(['record', 'accept']);
  });

  test.each(['示例 MEDIA:', '示例。 MEDIA:', '> 已发送。 MEDIA:', '- 已发送。 MEDIA:', '`example` 已发送。 MEDIA:'])
    ('does not resend an unchanged file from an inline example: %s', async prefix => {
      const f = fixture();
      f.write('existing document');
      await f.prepare();
      f.finish({ withoutTools: true, assistantText: `${prefix}${f.source}` });
      await f.collect();
      expect(f.recordArtifact).not.toHaveBeenCalled();
      expect(f.accept).not.toHaveBeenCalled();
    });

  test.each([false, true])('seals two unchanged files only as explicit references (readOnlyTool=%s)', async readOnlyTool => {
    const f = fixture(), desktopFile = path.join(f.desktop, 'existing answer.txt');
    f.write('existing question'); f.write('existing answer', desktopFile);
    await f.prepare();
    f.finish({ toolName: 'read', withoutTools: !readOnlyTool, assistantText: `Files sent.\nMEDIA: ${f.source}\nMEDIA: ${desktopFile}\nMEDIA: ${f.source}\n[ref](${f.source})` });
    await f.collect();
    expect(f.recordArtifact).toHaveBeenCalledTimes(2);
    expect(f.recordArtifact.mock.calls.map(([candidate]) => [candidate.filePath, candidate.relationKind]))
      .toEqual([[f.source, LibraryRelationKind.Referenced], [desktopFile, LibraryRelationKind.Referenced]]);
    expect(f.accept.mock.calls.map(call => fs.readFileSync(call[4].path, 'utf8'))).toEqual(['existing question', 'existing answer']);
    await f.collect(); expect(f.accept).toHaveBeenCalledTimes(2);
  });

  test('does not use MEDIA as evidence for unchanged ordinary Markdown files', async () => {
    const f = fixture(), reference = path.join(f.desktop, 'reference.md');
    f.write('existing delivery'); f.write('ordinary reference', reference);
    await f.prepare();
    f.finish({ assistantText: `MEDIA: ${f.source}\n[reference](${reference})` });
    await f.collect();
    expect(f.accept).toHaveBeenCalledOnce(); expect(f.accept.mock.calls[0][3]).toBe(f.source);
  });

  test.each(['outside', 'symlink', 'access', 'epoch', 'finished', 'failed', 'policy'])('retains %s protections for an existing MEDIA file', async rejection => {
    const f = fixture(), outside = path.join(f.directory, 'private.md'), symlink = path.join(f.workspace, 'alias.md');
    f.write('existing'); f.write('outside', outside);
    fs.symlinkSync(outside, symlink);
    await f.prepare();
    const target = rejection === 'outside' ? outside : rejection === 'symlink' ? symlink : f.source;
    const boundary = f.finish({ assistantText: `MEDIA: ${target}`, status: rejection === 'failed' ? 'failed' : 'succeeded' });
    if (rejection === 'access') f.revokeAccess();
    if (rejection === 'epoch') { f.switchAccount(otherOwner); f.switchAccount(owner); }
    if (rejection === 'finished') fs.utimesSync(f.source, new Date(boundary + 1000), new Date(boundary + 1000));
    const rules = structuredClone(policy);
    if (rejection === 'policy') rules.types[0].artifactAutoSync = false;
    await f.collect(rules);
    expect(f.recordArtifact).not.toHaveBeenCalled(); expect(f.accept).not.toHaveBeenCalled();
  });

  test.each(['<think>', '<thinking>', '<!--', '```', '> ', '    '])('does not publish an existing file from %s examples or thinking in the latest reply', async prefix => {
    const f = fixture(); f.write('existing'); await f.prepare();
    const content = prefix === '> ' || prefix === '    ' ? `${prefix}MEDIA: ${f.source}` : `${prefix}\nMEDIA: ${f.source}`;
    f.finish({ assistantText: content });
    await f.collect(); expect(f.accept).not.toHaveBeenCalled();
  });

  test('rejects an oversized latest reply without truncating its last line or replaying an older reply', async () => {
    const f = fixture(); f.write('existing'); await f.prepare();
    f.finish({ assistantText: `MEDIA: ${f.source}` });
    const marker = `MEDIA: ${f.source}`;
    const oversized = `${'x'.repeat(65536 - marker.length - 1)}\n${marker} extra text beyond the truncation boundary`;
    expect(oversized.slice(0, 65536).endsWith(marker)).toBe(true);
    f.message('latest', 'assistant', oversized, { isFinal: true, isStreaming: false });
    await f.collect(); expect(f.recordArtifact).not.toHaveBeenCalled(); expect(f.accept).not.toHaveBeenCalled();
  });

  test('rechecks MEDIA content before local registration after asynchronous filesystem work', async () => {
    const f = fixture(); f.write('existing'); await f.prepare(); f.finish({ assistantText: `MEDIA: ${f.source}` });
    const lstat = fs.promises.lstat.bind(fs.promises);
    vi.spyOn(fs.promises, 'lstat').mockImplementationOnce(async target => {
      const stat = await lstat(target);
      f.db.prepare("UPDATE cowork_messages SET content='Delivery cancelled' WHERE id='final'").run();
      return stat;
    });
    await f.collect(); expect(f.recordArtifact).not.toHaveBeenCalled(); expect(f.accept).not.toHaveBeenCalled();
  });

  test.each(['edit', 'delete', 'run', 'thinking', 'streaming', 'oversized', 'malformed'])('rechecks %s changes to the original MEDIA reply after asynchronous registration', async change => {
    const f = fixture(); f.write('existing'); await f.prepare(); f.finish({ assistantText: `MEDIA: ${f.source}` });
    f.recordArtifact.mockImplementationOnce(async () => {
      if (change === 'delete') f.db.prepare("DELETE FROM cowork_messages WHERE id='final'").run();
      else if (change === 'edit' || change === 'oversized') f.db.prepare("UPDATE cowork_messages SET content=? WHERE id='final'")
        .run(change === 'edit' ? 'Delivery cancelled' : 'x'.repeat(65537));
      else f.db.prepare("UPDATE cowork_messages SET metadata=? WHERE id='final'").run(change === 'malformed' ? '{' : JSON.stringify({
        remoteRunId: change === 'run' ? 'another-run' : 'run1', isThinking: change === 'thinking', isStreaming: change === 'streaming',
      }));
      return true;
    });
    await f.collect(); expect(f.recordArtifact).toHaveBeenCalledOnce(); expect(f.accept).not.toHaveBeenCalled();
  });
});


describe('relative final Word deliveries retain run and directory evidence', () => {
  const rules = structuredClone(policy);
  rules.types.push({ category: 'document', extensions: ['docx'], maxFileBytes: '31457280', inputAllowed: true, artifactAutoSync: true });

  test('seals a new relative DOCX after a successful producer', async () => {
    const f = fixture(), filePath = path.join(f.workspace, '工作简报.docx');
    await f.prepare();
    f.write('new Word document', filePath);
    f.finish({ assistantText: 'Word 文件已经生成：[工作简报.docx](./工作简报.docx)' });
    await f.collect(rules);
    expect(f.recordArtifact).toHaveBeenCalledOnce();
    expect(f.recordArtifact.mock.calls[0][0]).toMatchObject({ filePath, detectedType: 'document', relationKind: LibraryRelationKind.Modified });
    expect(f.accept).toHaveBeenCalledOnce();
    expect(f.accept.mock.calls[0][3]).toBe(filePath);
    expect(f.accept.mock.calls[0][4].path).not.toBe(filePath);
    expect(fs.readFileSync(f.accept.mock.calls[0][4].path, 'utf8')).toBe('new Word document');
  });

  test('does not upload an unchanged relative link merely because another producer succeeded', async () => {
    const f = fixture(), filePath = path.join(f.workspace, '工作简报.docx');
    f.write('existing Word document', filePath);
    await f.prepare();
    f.finish({ assistantText: '[工作简报](工作简报.docx)' });
    await f.collect(rules);
    expect(f.recordArtifact).not.toHaveBeenCalled();
    expect(f.accept).not.toHaveBeenCalled();
  });

  test.each(['absent', 'failed'])('requires successful producer evidence (%s)', async producer => {
    const f = fixture(), filePath = path.join(f.workspace, '工作简报.docx');
    await f.prepare();
    f.write('new Word document', filePath);
    f.finish({ withoutTools: producer === 'absent', exitCode: 1, assistantText: '[工作简报](工作简报.docx)' });
    await f.collect(rules);
    expect(f.accept).not.toHaveBeenCalled();
  });

  test('does not reinterpret a relative link against Desktop when cwd baseline is unavailable', async () => {
    const f = fixture();
    fs.rmdirSync(f.workspace);
    await f.prepare();
    const relativeName = '工作简报.docx', control = path.join(f.desktop, '对照文档.docx');
    f.write('must not fall back to Desktop', path.join(f.desktop, relativeName));
    f.write('absolute Desktop control', control);
    f.finish({ assistantText: `[工作简报](${relativeName}) [对照文档](${control})` });
    await f.collect(rules);
    expect(f.accept).toHaveBeenCalledOnce();
    expect(f.accept.mock.calls[0][3]).toBe(control);
  });

  test.each(['nested/工作简报.docx', '../工作简报.docx'])('does not expand baseline roots to %s', async relativePath => {
    const f = fixture(), filePath = path.resolve(f.workspace, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    await f.prepare();
    f.write('outside direct baseline files', filePath);
    f.finish({ assistantText: `[工作简报](${relativePath})` });
    await f.collect(rules);
    expect(f.accept).not.toHaveBeenCalled();
  });
});
