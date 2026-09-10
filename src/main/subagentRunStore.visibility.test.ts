import Database from 'better-sqlite3';
import { expect, test } from 'vitest';

import { SubagentRunStore } from './subagentRunStore';

test('Agent run counts and pagination exclude other owners, quarantine and orphan parents', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE cowork_sessions (id TEXT PRIMARY KEY,agent_id TEXT,title TEXT,updated_at INTEGER);
      CREATE TABLE cowork_session_ownership (session_id TEXT PRIMARY KEY,ownership_status TEXT,owner_user_id TEXT,owner_scope_key TEXT);
      CREATE TABLE subagent_runs (id TEXT PRIMARY KEY,parent_session_id TEXT,session_key TEXT,child_cowork_session_id TEXT,
        agent_id TEXT,task TEXT,label TEXT,status TEXT,created_at INTEGER,ended_at INTEGER);
      INSERT INTO cowork_sessions VALUES ('a','main','A private',1),('b','main','B private',2),('anon','main','Anonymous',3),('q','main','Quarantined',4);
      INSERT INTO cowork_session_ownership VALUES ('a','confirmed','A','personal'),('b','confirmed','B','personal'),('q','quarantined',NULL,NULL);`);
    const runs = new SubagentRunStore(db);
    ['a', 'b', 'anon', 'q', 'orphan'].forEach((parentSessionId, index) => runs.insertSubagentRun({
      id: parentSessionId, parentSessionId, sessionKey: null, agentId: 'main', task: null,
      label: null, status: 'done', createdAt: index,
    }));
    const actor = { userId: 'A', scopeKey: 'personal' };
    expect(runs.countSubagentRunsByAgent('main', actor)).toBe(2);
    expect(runs.listSubagentRunsByAgent('main', 1, 0, actor).map(run => run.id)).toEqual(['anon']);
    expect(runs.listSubagentRunsByAgent('main', 1, 1, actor).map(run => run.id)).toEqual(['a']);
    expect(runs.countSubagentRunsByAgent('main', null)).toBe(1);
    expect(runs.countSubagentRunsByAgent('main')).toBe(5);
  } finally { db.close(); }
});
