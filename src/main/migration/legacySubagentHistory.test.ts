import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { expect, test } from 'vitest';

import { SubagentMessageStore } from '../subagentMessageStore';
import { migrateLegacySubagentHistory } from './legacySubagentHistory';

test('imports only the indexed child and the active branch once during upgrade', () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-child-history-'));
  const root = path.join(profile, 'openclaw', 'state');
  const shared = path.join(root, 'sessions');
  fs.mkdirSync(shared, { recursive: true });
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
      CREATE TABLE subagent_runs (id TEXT PRIMARY KEY, session_key TEXT, created_at INTEGER);
      CREATE TABLE subagent_messages (id TEXT PRIMARY KEY, run_id TEXT, type TEXT, content TEXT, metadata TEXT, created_at INTEGER, sequence INTEGER);`);
    const add = db.prepare('INSERT INTO subagent_runs VALUES(?,?,1)');
    add.run('run-1', 'agent:expert:dashboard:a');
    add.run('run-2', 'agent:expert:subagent:b');
    const header = { type: 'session', id: 'child-a' };
    const source = [
      header,
      { id: '1', parentId: null, type: 'message', message: { role: 'user', content: 'delegation' } },
      { id: '2', parentId: '1', type: 'message', message: { role: 'assistant', content: 'discarded branch' } },
      { id: '3', parentId: '1', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'write', id: 'call', arguments: { path: 'out' } }] } },
      { id: '4', parentId: '3', type: 'message', message: { role: 'toolResult', toolCallId: 'call', content: 'saved' } },
      { id: '5', parentId: '4', type: 'message', message: { role: 'assistant', content: 'report.md' } },
    ].map(e => JSON.stringify(e)).join('\n');
    fs.writeFileSync(path.join(shared, 'child-a.jsonl'), source);
    const outside = path.join(profile, 'foreign.jsonl');
    fs.writeFileSync(outside, source.replace('child-a', 'child-b'));
    fs.writeFileSync(path.join(shared, 'sessions.json'), JSON.stringify({
      'agent:expert:dashboard:a': { sessionId: 'child-a' },
      'agent:expert:subagent:b': { sessionId: 'child-b', sessionFile: outside },
    }));
    migrateLegacySubagentHistory(db, root);
    migrateLegacySubagentHistory(db, root);
    const store = new SubagentMessageStore(db);
    expect(store.getMessages('run-1').map(m => [m.type, m.content])).toEqual([
      ['user', 'delegation'], ['tool_use', 'write'], ['tool_result', 'saved'], ['assistant', 'report.md'],
    ]);
    expect(store.getMessages('run-2')).toEqual([]);
  } finally {
    db.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
