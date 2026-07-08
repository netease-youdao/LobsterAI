import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { readSessionDiagnosticsData } from './repository';

describe('readSessionDiagnosticsData', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE cowork_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        claude_session_id TEXT,
        status TEXT NOT NULL,
        pinned INTEGER,
        pin_order INTEGER,
        cwd TEXT,
        system_prompt TEXT,
        model_override TEXT,
        execution_mode TEXT,
        parent_session_id TEXT,
        forked_from_message_id TEXT,
        forked_at INTEGER,
        fork_mode TEXT,
        fork_workspace_path TEXT,
        fork_git_branch TEXT,
        fork_git_base_ref TEXT,
        goal_json TEXT,
        active_skill_ids TEXT,
        agent_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE cowork_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        sequence INTEGER
      );
      CREATE TABLE cowork_session_capsules (
        session_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        capsule_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        last_source TEXT NOT NULL,
        last_compacted_at INTEGER
      );
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        model TEXT NOT NULL,
        source TEXT NOT NULL,
        preset_id TEXT NOT NULL,
        is_default INTEGER NOT NULL,
        enabled INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    db.prepare(`
      INSERT INTO cowork_sessions (
        id, title, claude_session_id, status, pinned, cwd, system_prompt,
        model_override, execution_mode, goal_json, active_skill_ids, agent_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'session-1',
      'LOFTER review',
      'runtime-session',
      'completed',
      1,
      'D:\\workspace',
      'system prompt',
      'test-model',
      'local',
      '{"status":"active"}',
      '["skill-1"]',
      'agent-1',
      100,
      200,
    );
    db.prepare(`
      INSERT INTO cowork_messages
        (id, session_id, type, content, metadata, created_at, sequence)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('message-2', 'session-1', 'assistant', 'second', '{"raw":true}', 120, 2);
    db.prepare(`
      INSERT INTO cowork_messages
        (id, session_id, type, content, metadata, created_at, sequence)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('message-1', 'session-1', 'user', 'first', null, 110, 1);
    db.prepare(`
      INSERT INTO cowork_session_capsules
        (session_id, version, revision, capsule_json, updated_at, last_source, last_compacted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('session-1', 1, 2, '{"summary":"raw"}', 200, 'compaction', 190);
    db.prepare(`
      INSERT INTO agents
        (id, name, model, source, preset_id, is_default, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('agent-1', 'Prompt PE', 'test-model', 'custom', '', 0, 1, 10, 20);
  });

  afterEach(() => {
    db.close();
  });

  test('reads a consistent raw session snapshot', () => {
    const data = readSessionDiagnosticsData(db, 'session-1');

    expect(data?.session).toMatchObject({
      id: 'session-1',
      title: 'LOFTER review',
      goal_json: '{"status":"active"}',
      active_skill_ids: '["skill-1"]',
    });
    expect(data?.messages.map((message) => message.id)).toEqual(['message-1', 'message-2']);
    expect(data?.messages[1]?.metadata).toBe('{"raw":true}');
    expect(data?.capsule?.capsule_json).toBe('{"summary":"raw"}');
    expect(data?.agent).toMatchObject({
      id: 'agent-1',
      isDefault: false,
      enabled: true,
    });
  });

  test('returns null when the session does not exist', () => {
    expect(readSessionDiagnosticsData(db, 'missing')).toBeNull();
  });
});
