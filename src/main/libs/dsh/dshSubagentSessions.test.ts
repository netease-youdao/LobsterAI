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

  it('persists delegated specialist agentId and reads nested depth-2 subagent history via direct parent', async () => {
    const db = new Database(':memory:');
    dbs.push(db);
    db.exec(`
      CREATE TABLE cowork_sessions (id TEXT PRIMARY KEY, claude_session_id TEXT, agent_id TEXT, title TEXT, updated_at INTEGER);
      CREATE TABLE subagent_runs (id TEXT PRIMARY KEY, parent_session_id TEXT, session_key TEXT, child_cowork_session_id TEXT,
        agent_id TEXT, task TEXT, label TEXT, status TEXT, created_at INTEGER, ended_at INTEGER);
      CREATE TABLE subagent_messages (id TEXT PRIMARY KEY, run_id TEXT, type TEXT, content TEXT, metadata TEXT,
        created_at INTEGER, sequence INTEGER);
    `);
    const rootDshId = '11111111-1111-4111-8111-111111111111';
    const depth1Id = '44444444-4444-4444-8444-444444444444';
    const depth2Id = '55555555-5555-4555-8555-555555555555';
    db.prepare('INSERT INTO cowork_sessions VALUES (?, ?, ?, ?, ?)')
      .run('cw-main', DSH_SESSION_ID_PREFIX + rootDshId, 'main', 'root', 100);

    const getSessionProjections = vi.fn(async (id: string): Promise<Record<string, unknown>> => {
      if (id === rootDshId) {
        return {
          values: {
            subagentCatalog: [{ id: depth1Id, name: 'translator', label: '翻译文章', createdAt: 10, mode: 'continuable' }],
          },
        };
      }
      if (id === depth1Id) {
        return {
          values: {
            subagent: { seq: 5, mode: 'continuable' },
            subagentTiming: { lastTurnCompleted: true },
            subagentCatalog: [{ id: depth2Id, name: 'blog-publisher', label: '发布博客', createdAt: 20, mode: 'continuable' }],
          },
        };
      }
      return {
        values: {
          subagent: { seq: 7, mode: 'continuable' },
          subagentTiming: { lastTurnCompleted: true },
        },
      };
    });
    const getSessionEvents = vi.fn(async () => ({
      records: [
        { type: 'event', event: { seq: 8, time: 200, type: 'user/message', data: { content: '发布文章', source: { kind: 'user' } } } },
        { type: 'event', event: { seq: 9, time: 210, type: 'assistant/message', data: { message: { content: '发布完成' } } } },
      ],
      hasMore: false,
    }));
    const deleteSessionFiles = vi.fn(async () => ({ removedPaths: [] }));
    const host = {
      isReady: vi.fn(() => true),
      start: vi.fn(async () => {}),
      getClient: () => ({ getSessionProjections, getSessionEvents }),
      deleteSessionFiles,
    };

    const service = new DshSubagentSessions(db, host, () => []);
    service.recordAgentBinding({
      childSessionId: depth1Id,
      parentDshSessionId: rootDshId,
      rootCoworkSessionId: 'cw-main',
      targetAgentId: 'translator',
      createdAt: 10,
    });
    service.recordAgentBinding({
      childSessionId: depth2Id,
      parentDshSessionId: depth1Id,
      rootCoworkSessionId: 'cw-main',
      targetAgentId: 'blog-publisher',
      createdAt: 20,
    });

    const runs = await service.listSubagentRuns('cw-main');
    expect(runs.map(r => [r.id, r.agentId, r.label, r.status])).toEqual([
      [DSH_SESSION_ID_PREFIX + depth1Id, 'translator', '翻译文章', 'done'],
      [DSH_SESSION_ID_PREFIX + depth2Id, 'blog-publisher', '发布博客', 'done'],
    ]);
    expect(service.getOwningSessionId(depth2Id)).toBe('cw-main');
    expect(service.listAgentBindings()).toHaveLength(2);

    const depth2History = await service.getSubTaskHistory('cw-main', DSH_SESSION_ID_PREFIX + depth2Id);
    expect(depth2History.map(m => [m.type, m.content])).toEqual([
      ['user', '发布文章'],
      ['assistant', '发布完成'],
    ]);
    expect(getSessionEvents).toHaveBeenLastCalledWith(
      { kind: 'subagent', parentSessionId: depth1Id, childSessionId: depth2Id, mode: 'continuable' },
      { maxMessages: 100, throughSeq: undefined, beforeSeq: undefined },
    );

    expect(await service.deleteSubagentSession('cw-main', DSH_SESSION_ID_PREFIX + depth2Id)).toBe(true);
    expect(deleteSessionFiles).toHaveBeenCalledWith(depth2Id);
    expect(service.listAgentBindings().map(b => b.childSessionId)).toEqual([depth1Id]);
  });
});
