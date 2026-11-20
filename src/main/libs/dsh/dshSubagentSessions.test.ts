import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DSH_SESSION_ID_PREFIX } from '../../../shared/dshEngine/hostConstants';
import { SubagentMessageStore } from '../../subagentMessageStore';
import { SubagentRunStore } from '../../subagentRunStore';
import { DshSubagentSessions } from './dshSubagentSessions';

const children = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
const parentId = 'parent';
const nativeParent = '11111111-1111-4111-8111-111111111111';
const runId = DSH_SESSION_ID_PREFIX + children[0];
const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

function setup() {
  const db = new Database(':memory:');
  dbs.push(db);
  db.exec(`
    CREATE TABLE cowork_sessions (id TEXT PRIMARY KEY, claude_session_id TEXT, agent_id TEXT, title TEXT, updated_at INTEGER);
    CREATE TABLE subagent_runs (id TEXT PRIMARY KEY, parent_session_id TEXT, session_key TEXT, child_cowork_session_id TEXT,
      agent_id TEXT, task TEXT, label TEXT, status TEXT, created_at INTEGER, ended_at INTEGER);
    CREATE TABLE subagent_messages (id TEXT PRIMARY KEY, run_id TEXT, type TEXT, content TEXT, metadata TEXT,
      created_at INTEGER, sequence INTEGER);
  `);
  const add = db.prepare('INSERT INTO cowork_sessions VALUES (?, ?, ?, ?, ?)');
  add.run(parentId, DSH_SESSION_ID_PREFIX + nativeParent, 'expert', 'parent title', 100);
  add.run('other', null, 'main', 'other title', 50);
  const catalog = children.map((id, index) => ({ id, name: 'worker-' + index, label: 'same label', createdAt: index + 1, mode: 'continuable' }));
  const getSessionProjections = vi.fn(async (id: string): Promise<Record<string, unknown>> => ({
    values: id === nativeParent ? { subagentCatalog: catalog } : { subagent: { seq: 10, mode: 'continuable' }, subagentTiming: { lastTurnCompleted: true } },
  }));
  const event = (seq: number, type: string, data: Record<string, unknown>) => ({ type: 'event', event: { seq, time: 100 + seq, type, data } });
  const getSessionEvents = vi.fn()
    .mockResolvedValueOnce({ records: [event(20, 'assistant/message', { message: { content: [{ type: 'text', text: 'artifact A' }] } })], cursor: 21, hasMore: true })
    .mockResolvedValueOnce({ records: [
      event(2, 'assistant/message', { message: { content: 'inherited secret' } }),
      event(11, 'user/message', { content: 'runtime hint', source: { kind: 'runtime-context' } }),
      event(12, 'user/message', { content: 'assigned task', source: { kind: 'user' } }),
    ], hasMore: false });
  const host = { isReady: vi.fn(() => true), start: vi.fn(async () => {}), getClient: () => ({ getSessionProjections, getSessionEvents }),
    deleteSessionFiles: vi.fn(async () => ({ removedPaths: [] })) };
  const stored = vi.fn(() => []);
  const open = () => new DshSubagentSessions(db, host, stored);
  return { db, open, host, stored, getSessionProjections, getSessionEvents };
}

describe('native and upgraded subagent sessions', () => {
  it('keeps equal labels distinct across restart and reads only the selected child', async () => {
    const { open, host, getSessionEvents } = setup();
    const service = open();
    const runs = await service.listSubagentRuns(parentId);
    expect(runs.map(r => [r.id, r.status])).toEqual(children.map(id => [DSH_SESSION_ID_PREFIX + id, 'done']));
    expect(service.listSubagentRunsByAgent('expert', 1, 0)).toMatchObject({ runs: [{ parentSessionId: parentId }], hasMore: true });
    host.isReady.mockReturnValue(false);
    const reopened = open();
    expect(await reopened.listSubagentRuns(parentId)).toEqual(runs);
    await expect(reopened.getSubTaskHistory('other', runId)).rejects.toThrow('does not belong');
    const history = await reopened.getSubTaskHistory(parentId, runId);
    expect(history.map(m => [m.type, m.content])).toEqual([['user', 'assigned task'], ['assistant', 'artifact A']]);
    expect(getSessionEvents).toHaveBeenLastCalledWith({ kind: 'subagent', parentSessionId: nativeParent, childSessionId: children[0],
      mode: 'continuable' }, { maxMessages: 100, throughSeq: 21, beforeSeq: 20 });
  });

  it('persists native settle times only on the owning parent and preserves explicit deletion', async () => {
    const { open, host } = setup();
    const service = open();
    service.observeCatalog(parentId, { childId: children[0], childCreatedAt: 10, name: 'worker' });
    host.isReady.mockReturnValue(false);
    const notice = { source: { kind: 'subagent-settled', stopReason: 'completed', senderSessionId: children[0] } };
    service.observeNotice('other', notice, 123);
    expect((await service.listSubagentRuns(parentId))[0].status).toBe('running');
    service.observeNotice(parentId, notice, 125);
    expect((await service.listSubagentRuns(parentId))[0]).toMatchObject({ status: 'done', endedAt: 125 });
    expect(await service.deleteSubagentSession('other', runId)).toBe(false);
    expect(host.deleteSessionFiles).not.toHaveBeenCalled();
    host.isReady.mockReturnValue(true);
    expect(await service.deleteSubagentSession(parentId, runId)).toBe(true);
    expect(host.deleteSessionFiles).toHaveBeenCalledWith(children[0]);
    expect((await open().listSubagentRuns(parentId)).map(r => r.id)).toEqual([DSH_SESSION_ID_PREFIX + children[1]]);
  });

  it('opens legacy SQLite transcripts without starting the host and honors original order', async () => {
    const { db, open, host, stored } = setup();
    const oldRun = { id: 'old', parentSessionId: 'other', sessionKey: 'agent:main:subagent:legacy', agentId: 'main',
      task: 'old task', label: null, status: 'done' as const, createdAt: 10, childCoworkSessionId: 'materialized' };
    new SubagentRunStore(db).insertSubagentRun(oldRun);
    const service = open();
    await service.getSubTaskHistory('other', oldRun.id);
    expect(stored).toHaveBeenCalledWith('materialized');
    new SubagentMessageStore(db).insertMessages(oldRun.id, [
      { id: '2', sequence: 2, type: 'assistant', content: 'legacy result', timestamp: 12 },
      { id: '1', sequence: 1, type: 'user', content: 'legacy task', timestamp: 11 },
    ]);
    expect((await service.getSubTaskHistory('other', oldRun.id)).map(m => m.content)).toEqual(['legacy task', 'legacy result']);
    expect(host.start).not.toHaveBeenCalled();
  });
});
