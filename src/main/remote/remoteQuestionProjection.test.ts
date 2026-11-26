import Database from 'better-sqlite3';
import { build } from 'esbuild';
import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { RemoteQuestionState } from '../../shared/remote/questions';
import { RemoteSecurityJournal } from './remoteSecurityJournal';
import { RemoteStore } from './remoteStore';

const owner = { userId: 'A', scopeKey: 'personal' };
const workerDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-question-projection-'));
const workerPath = path.join(workerDirectory, 'worker.cjs');
const cleanups: Array<() => void> = [];
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  await build({ entryPoints: [path.join(__dirname, 'remoteProjectionWorker.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: workerPath,
    plugins: [{ name: 'native-sqlite', setup(builder) { builder.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: require.resolve('better-sqlite3'), external: true })); } }] });
});
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
afterAll(() => fs.rmSync(workerDirectory, { recursive: true, force: true }));
function fixture(disk = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'question-projection-')); cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new Database(disk ? path.join(dir, 'core.sqlite') : ':memory:'); cleanups.push(() => db.close());
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db, { deferredProjection: disk, projectionWorkerPath: workerPath }); store.setEnabledOwner(owner);
  store.transaction(() => { db.exec("INSERT INTO cowork_sessions VALUES('task','Task',1,1,'idle')"); store.assignNew('task', owner, 'local_create'); });
  const run = store.beginRun('task');
  const question: RemoteQuestionState = { questionId: 'question_01', runId: run.runId, questionVersion: '1', operationDigest: 'a'.repeat(64), title: '请选择',
    status: 'pending', expiresAt: new Date(Date.now() + 60_000).toISOString(), remoteAllowed: true, requiresLocalAction: false, allowCancel: true,
    questions: [{ questionId: 'q0', header: 'Task', question: 'Choose?', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false, isOther: true, allowSkip: false }],
    resolution: { phase: 'idle', source: null, answeredAt: null, answers: null } };
  return { store, db, question };
}
describe('question projection and compatibility', () => {
  it('never publishes unknown events to an old server and keeps the old waiting_local run status', () => {
    const { store, question } = fixture(); store.updateQuestion('task', question);
    expect(store.snapshot('task').records.some(r => r.eventType === 'question.updated')).toBe(false);
    expect(store.run('task')?.status).toBe('waiting_local');
    store.setQuestionProjectionSupported(true);
    expect(store.snapshot('task').records.find(r => r.eventType === 'question.updated')?.payload.question).toEqual(question);
  });
  it('rejects stale versions and publishes confirmed closure before run terminal', () => {
    const { store, question } = fixture(); store.setQuestionProjectionSupported(true); store.updateQuestion('task', question);
    const terminal: RemoteQuestionState = { ...question, questionVersion: '2', status: 'answered', remoteAllowed: false,
      resolution: { phase: 'finished', source: 'desktop', answeredAt: new Date().toISOString(), answers: { q0: ['A'] } } };
    store.transaction(() => { store.updateQuestion('task', terminal); store.updateRun('task', 'succeeded'); });
    store.updateQuestion('task', question);
    expect(store.questionStates('task')[0]).toEqual(terminal);
    const events = store.pending('task');
    const questionIndex = events.findIndex(r => r.eventType === 'question.updated' && r.payload.question.status === 'answered');
    const runIndex = events.findIndex(r => r.eventType === 'run.updated' && r.payload.run.status === 'succeeded');
    expect(questionIndex).toBeGreaterThan(-1); expect(runIndex).toBeGreaterThan(questionIndex);
  });
  it('recovers from a missing derived question write using the committed fact in the real worker', async () => {
    const { store, question } = fixture(true); store.setQuestionProjectionSupported(true);
    store.transaction(() => store.put('questionDecision:question_01', { state: { ...question, requestId: 'gateway:private', sessionId: 'task' },
      binding: { runId: question.runId, owner, agentId: 'main', cwd: '/private/workspace' }, kind: 'native' }));
    expect(store.get('question:task:question_01')).toBeNull();
    await store.flushProjections();
    const projected = store.snapshot('task').records.find(r => r.eventType === 'question.updated')!.payload.question;
    expect(projected).toEqual(question); expect(JSON.stringify(projected)).not.toContain('gateway:private'); expect(JSON.stringify(projected)).not.toContain('/private/workspace');
  });
  it('forces a fresh snapshot when switching to an old server after restart', async () => {
    const { store, db, question } = fixture(true); store.setQuestionProjectionSupported(true); store.updateQuestion('task', question); await store.flushProjections();
    const row = store.sync('task')!; store.bindRemote('task', row.session_id, 'desktop');
    store.acknowledge('task', 'desktop', row.session_id, String(store.sync('task')!.source_seq), '10', true);
    expect(store.sync('task')!.needs_snapshot).toBe(0);
    const reopened = new RemoteStore(db, { deferredProjection: true, projectionWorkerPath: workerPath }); await reopened.waitRunRecovery(); reopened.setEnabledOwner(owner);
    reopened.setQuestionProjectionSupported(false); await reopened.flushProjections();
    expect(reopened.sync('task')!.needs_snapshot).toBe(1);
    expect(reopened.snapshot('task').records.some(r => r.eventType === 'question.updated')).toBe(false);
    expect(reopened.questionStates('task')[0]).toEqual(question);
  });
  it('never projects a question whose captured owner differs from the task owner', () => {
    const { store, question } = fixture(); store.setQuestionProjectionSupported(true);
    store.transaction(() => {
      store.updateQuestion('task', question);
      store.put('questionDecision:question_01', { state: { ...question, requestId: 'local', sessionId: 'task' },
        binding: { owner: { ...owner, userId: 'B' } } });
    });
    expect(store.questionStates('task')).toEqual([]);
    expect(store.snapshot('task').records.some(r => r.eventType === 'question.updated')).toBe(false);
  });
  it('keeps unrelated corrupt question evidence from breaking local state and fences remote projection', async () => {
    const { store, db, question } = fixture(true);
    db.prepare('INSERT INTO remote_state VALUES (?,?)').run('questionDecision:other-owner', '{');
    expect(() => store.updateQuestion('task', question)).not.toThrow();
    expect(store.run('task')?.status).toBe('waiting_local');
    expect(store.needsSecurityRecovery()).toBe(true);
    await store.flushProjections();
    expect(store.snapshot('task').records).toEqual([]);
    expect(db.prepare('SELECT value FROM remote_state WHERE key=?').get('questionDecision:other-owner')).toEqual({ value: '{' });
  });
  it('does not publish a reserved remote run or its question before dispatch, even with no messages', async () => {
    const { store, question } = fixture(true); store.updateRun('task', 'succeeded');
    const run = store.beginRun('task', 'remote_run', 'mobile_command');
    store.setQuestionProjectionSupported(true); store.updateQuestion('task', { ...question, runId: run.runId });
    await store.flushProjections();
    let records = store.snapshot('task').records;
    expect(records.some(r => r.eventType === 'run.updated' && r.payload.run.runId === run.runId)).toBe(false);
    expect(records.some(r => r.eventType === 'question.updated')).toBe(false);
    store.markRunDispatched('task'); await store.flushProjections(); records = store.snapshot('task').records;
    expect(records.some(r => r.eventType === 'run.updated' && r.payload.run.runId === run.runId)).toBe(true);
    expect(records.some(r => r.eventType === 'question.updated')).toBe(true);
  });
  it('keeps anonymous local waiting state but does not publish or adopt its question after ownership changes', () => {
    const { store, db, question } = fixture();
    store.transaction(() => db.exec("INSERT INTO cowork_sessions VALUES('anonymous','Anonymous',1,1,'idle')"));
    const run = store.beginRun('anonymous');
    store.transaction(() => {
      store.put('questionDecision:anonymous', { state: { ...question, requestId: 'local', sessionId: 'anonymous', runId: run.runId },
        binding: { owner: null } });
      store.refreshApprovalRunState('anonymous');
    });
    expect(store.run('anonymous')?.status).toBe('waiting_local'); expect(store.sync('anonymous')).toBeNull();
    store.transaction(() => store.assignNew('anonymous', owner, 'local_create'));
    expect(store.questionStates('anonymous')).toEqual([]);
  });
  it('invalidates a running worker when question capability changes', () => {
    const { store } = fixture(true); store.refreshProjectionHints(); const work = store.nextProjectionWork()!;
    expect(store.projectionWorkCurrent(work)).toBe(true); store.setQuestionProjectionSupported(true);
    expect(store.projectionWorkCurrent(work)).toBe(false);
  });
});

it('projects a healthy task through the real worker while a signed foreign task question is damaged', async () => {
  const { store, db, question } = fixture(true);
  const signer = new RemoteSecurityJournal({ installationId: 'install', databaseId: 'db', deviceKey: Buffer.alloc(32, 7).toString('base64url') },
    { read: async () => ({ current: null, previous: null }), replace: async () => {}, close: () => {} }, true);
  store.configureQuestionEvidence({ sign: value => signer.signQuestionBinding(value), verify: (value, signature) => signer.verifyQuestionBinding(value, signature) });
  store.setQuestionProjectionSupported(true);
  store.updateQuestion('task', question);
  store.transaction(() => {
    db.exec("INSERT INTO cowork_sessions VALUES('z-bad','Bad',1,1,'idle')"); store.assignNew('z-bad', owner, 'local_create');
    store.beginRun('z-bad', 'bad-run');
    store.put('questionDecision:bad', { state: { ...question, sessionId: 'z-bad', runId: 'bad-run', questionId: 'bad' }, binding: { owner } });
  });
  db.prepare("UPDATE remote_state SET value='{' WHERE key='questionDecision:bad'").run();
  await store.flushProjections();
  expect(store.snapshot('task').records.some(item => item.eventType === 'question.updated')).toBe(true);
  expect(store.needsSecurityRecovery()).toBe(false);
  expect(db.prepare("SELECT value FROM remote_state WHERE key='questionDecision:bad'").get()).toEqual({ value: '{' });
});
