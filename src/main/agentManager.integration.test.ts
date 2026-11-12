import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { AgentModelSelectionMode, AgentSource } from '../shared/agent/constants';
import { createExpertCatalogFixture, ExpertFixtureId } from '../shared/agent/expertCatalogFixture';
import { ModelThinkingLevel } from '../shared/providers/modelThinking';
import { AgentManager } from './agentManager';
import { CoworkStore } from './coworkStore';
import { presetToCreateRequest } from './presetAgents';
import { SqliteStore } from './sqliteStore';

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd() },
}));

let userDataPath: string;
let sqliteStore: SqliteStore;
let store: CoworkStore;
const catalog = createExpertCatalogFixture();

beforeEach(async () => {
  userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-preset-identity-'));
  sqliteStore = await SqliteStore.create(userDataPath);
  store = new CoworkStore(sqliteStore.getDatabase());
});

afterEach(() => {
  sqliteStore?.close();
  fs.rmSync(userDataPath, { recursive: true, force: true });
});

// Compatibility fixture for databases opened by the remote-connect branch.
// Keep its identity guard and ownership tombstones (agentOwnership.ts, ae1748103).
function installLegacyOwnershipSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE agent_ownership (
      agent_id TEXT PRIMARY KEY, owner_kind TEXT NOT NULL,
      owner_user_id TEXT, owner_scope_key TEXT, version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
    );
    INSERT INTO agent_ownership
      SELECT id, CASE WHEN id='main' THEN 'default' ELSE 'anonymous' END,
        NULL, NULL, 1, created_at, updated_at, NULL FROM agents;
    CREATE TABLE agent_write_context (id INTEGER PRIMARY KEY CHECK(id=1), trusted INTEGER NOT NULL);
    INSERT INTO agent_write_context VALUES (1,0);
    CREATE TABLE agent_ownership_dirty (agent_id TEXT PRIMARY KEY);
    CREATE TABLE remote_dirty (session_id TEXT PRIMARY KEY);
    CREATE TRIGGER agent_identity_no_reuse BEFORE INSERT ON agents
    WHEN NEW.id!='main' AND EXISTS(SELECT 1 FROM agent_ownership WHERE agent_id=NEW.id)
    BEGIN SELECT RAISE(ABORT,'Agent identity cannot be reused'); END;
    CREATE TRIGGER agent_ownership_insert AFTER INSERT ON agents BEGIN
      INSERT OR IGNORE INTO agent_ownership VALUES(NEW.id,CASE WHEN NEW.id='main' THEN 'default' ELSE 'quarantined' END,NULL,NULL,1,NEW.created_at,NEW.updated_at,NULL);
      INSERT OR IGNORE INTO agent_ownership_dirty VALUES(NEW.id);
    END;
    CREATE TRIGGER agent_ownership_update AFTER UPDATE ON agents BEGIN
      UPDATE agent_ownership SET version=version+1,updated_at=NEW.updated_at,
        owner_kind=CASE WHEN owner_kind='owned' AND (SELECT trusted FROM agent_write_context WHERE id=1)=0 THEN 'quarantined' ELSE owner_kind END
        WHERE agent_id=NEW.id;
      INSERT OR IGNORE INTO agent_ownership_dirty VALUES(NEW.id);
      INSERT OR IGNORE INTO remote_dirty SELECT id FROM cowork_sessions WHERE agent_id=NEW.id;
    END;
    CREATE TRIGGER agent_ownership_delete AFTER DELETE ON agents BEGIN
      UPDATE agent_ownership SET version=version+1,updated_at=CAST(strftime('%s','now') AS INTEGER)*1000,
        deleted_at=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE agent_id=OLD.id;
      INSERT OR IGNORE INTO agent_ownership_dirty VALUES(OLD.id);
      INSERT OR IGNORE INTO remote_dirty SELECT id FROM cowork_sessions WHERE agent_id=OLD.id;
    END;
  `);
}

test.each([false, true])('resummons a deleted legacy preset with a fresh identity (ownership schema: %s)', async legacyOwnership => {
  const db = sqliteStore.getDatabase();
  const legacy = store.createAgent(presetToCreateRequest(catalog.experts[0]));
  if (legacyOwnership) installLegacyOwnershipSchema(db);
  const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all();
  const manager = new AgentManager(store, async () => catalog);

  expect(manager.deleteAgent(legacy.id)).toBe(true);
  const retiredIdentity = legacyOwnership
    ? db.prepare('SELECT * FROM agent_ownership WHERE agent_id=?').get(legacy.id)
    : null;
  if (legacyOwnership) expect(retiredIdentity).toMatchObject({ deleted_at: expect.any(Number) });

  const [first, concurrent] = await Promise.all([
    manager.addPresetAgent(ExpertFixtureId.Data, 'provider/model', ModelThinkingLevel.High),
    manager.addPresetAgent(ExpertFixtureId.Data, 'provider/model', ModelThinkingLevel.High),
  ]);
  expect(first).toMatchObject({
    source: AgentSource.Preset, presetId: ExpertFixtureId.Data, model: 'provider/model',
    modelSelectionMode: AgentModelSelectionMode.Inherit, thinkingLevel: ModelThinkingLevel.High,
  });
  expect(first!.id).not.toBe(legacy.id);
  expect(concurrent!.id).toBe(first!.id);
  expect(manager.listAgents().filter(agent => agent.presetId === ExpertFixtureId.Data)).toHaveLength(1);

  expect(manager.deleteAgent(first!.id)).toBe(true);
  const second = await manager.addPresetAgent(ExpertFixtureId.Data);
  expect(second).toMatchObject({ presetId: ExpertFixtureId.Data });
  expect(new Set([legacy.id, first!.id, second!.id]).size).toBe(3);
  expect(db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all()).toEqual(triggers);
  if (legacyOwnership) {
    expect(db.prepare('SELECT * FROM agent_ownership WHERE agent_id=?').get(legacy.id)).toEqual(retiredIdentity);
    expect(() => db.prepare('INSERT INTO agents (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(legacy.id, legacy.name, 0, 0)).toThrow('Agent identity cannot be reused');
  }
});

test('reuses and re-enables an installed legacy preset offline without replacing its identity or user settings', async () => {
  const legacy = store.createAgent({
    ...presetToCreateRequest(catalog.experts[0]),
    name: 'My expert', systemPrompt: 'My prompt', model: 'custom/model', workingDirectory: '/my-work',
  });
  store.updateAgent(legacy.id, { enabled: false });
  installLegacyOwnershipSchema(sqliteStore.getDatabase());
  const loadCatalog = vi.fn().mockRejectedValue(new Error('Offline'));
  const manager = new AgentManager(store, loadCatalog);

  expect(await manager.addPresetAgent(ExpertFixtureId.Data, 'another/model')).toEqual({
    ...legacy, updatedAt: expect.any(Number),
  });
  expect(loadCatalog).not.toHaveBeenCalled();
  expect(manager.listAgents().filter(agent => agent.presetId === ExpertFixtureId.Data)).toHaveLength(1);
});
