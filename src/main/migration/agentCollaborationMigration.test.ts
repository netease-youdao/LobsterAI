import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { SubagentCollaborationMode } from '../../shared/agent';
import { migrateAgentCollaboration } from './agentCollaborationMigration';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (id TEXT PRIMARY KEY, subagent_collaboration_mode TEXT, subagent_allow_agent_ids TEXT);
    INSERT INTO agents VALUES ('empty', '${SubagentCollaborationMode.All}', '[]'),
      ('selected', '${SubagentCollaborationMode.All}', '["peer"]');
    CREATE TABLE agent_ownership (agent_id TEXT PRIMARY KEY, owner_kind TEXT, version INTEGER);
    INSERT INTO agent_ownership SELECT id, 'owned', 1 FROM agents;
    CREATE TABLE agent_write_context (id INTEGER PRIMARY KEY CHECK(id=1), trusted INTEGER NOT NULL);
    INSERT INTO agent_write_context VALUES (1, 0);

    -- Remote-connect (15649314b) persists this guard in the user's database.
    CREATE TRIGGER agent_owned_update_guard BEFORE UPDATE ON agents
    WHEN COALESCE((SELECT trusted FROM agent_write_context WHERE id=1),0)!=1
      AND EXISTS(SELECT 1 FROM agent_ownership WHERE agent_id=OLD.id AND owner_kind='owned')
    BEGIN SELECT RAISE(ABORT,'Use LobsterAI Agent settings to update an owned Agent'); END;
    CREATE TRIGGER agent_ownership_update AFTER UPDATE ON agents BEGIN
      UPDATE agent_ownership SET version=version+1 WHERE agent_id=NEW.id;
    END;
  `);
});

afterEach(() => {
  db.close();
});

test('backfills owned agents without changing an explicit mode or touching empty lists on upgrade', () => {
  expect(migrateAgentCollaboration(db)).toBe(true);
  expect(db.prepare('SELECT subagent_collaboration_mode, subagent_allow_agent_ids_snapshot FROM agents WHERE id=?')
    .get('selected')).toEqual({
    subagent_collaboration_mode: SubagentCollaborationMode.All,
    subagent_allow_agent_ids_snapshot: '["peer"]',
  });
  expect(migrateAgentCollaboration(db)).toBe(false);
  expect(db.prepare('SELECT agent_id, owner_kind, version FROM agent_ownership ORDER BY agent_id').all()).toEqual([
    { agent_id: 'empty', owner_kind: 'owned', version: 1 },
    { agent_id: 'selected', owner_kind: 'owned', version: 2 },
  ]);
  expect(db.prepare('SELECT trusted FROM agent_write_context').pluck().get()).toBe(0);
  expect(() => db.exec("UPDATE agents SET subagent_allow_agent_ids='[]' WHERE id='selected'"))
    .toThrow('Use LobsterAI Agent settings to update an owned Agent');
});

test.each([0, 1])('reconciles a legacy selection and restores the previous write context (%i)', trusted => {
  db.exec("ALTER TABLE agents ADD COLUMN subagent_allow_agent_ids_snapshot TEXT NOT NULL DEFAULT '[]'");
  db.prepare('UPDATE agent_write_context SET trusted=?').run(trusted);
  expect(migrateAgentCollaboration(db)).toBe(true);
  expect(db.prepare('SELECT subagent_collaboration_mode, subagent_allow_agent_ids_snapshot FROM agents WHERE id=?')
    .get('selected')).toEqual({
    subagent_collaboration_mode: SubagentCollaborationMode.Allowlist,
    subagent_allow_agent_ids_snapshot: '["peer"]',
  });
  expect(db.prepare('SELECT trusted FROM agent_write_context').pluck().get()).toBe(trusted);
  expect(migrateAgentCollaboration(db)).toBe(false);
});

test('rolls back a failed migration, restores the guard and can retry', () => {
  db.exec(`CREATE TRIGGER reject_snapshot BEFORE UPDATE ON agents
    BEGIN SELECT RAISE(ABORT, 'snapshot write failed'); END`);
  expect(() => migrateAgentCollaboration(db)).toThrow('snapshot write failed');
  expect(db.prepare("SELECT name FROM pragma_table_info('agents')").pluck().all())
    .not.toContain('subagent_allow_agent_ids_snapshot');
  expect(db.prepare('SELECT trusted FROM agent_write_context').pluck().get()).toBe(0);
  expect(db.prepare('SELECT version FROM agent_ownership WHERE agent_id=?').pluck().get('selected')).toBe(1);
  db.exec('DROP TRIGGER reject_snapshot');
  expect(migrateAgentCollaboration(db)).toBe(true);
});
