// Opt-in packaged-runtime check:
// LOBSTERAI_TEST_GATEWAY_REPAIR=1 npm test -- openclawGatewayRepair.runtime
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { expect, test } from 'vitest';

import { runOpenClawCompatibilityRepair, runOpenClawDoctorRepair } from '../src/main/libs/openclawCompatibilityRepair';
import { OpenClawRepairPhase, OpenClawRepairPluginSource } from '../src/shared/openclawEngine/repair';

test.skipIf(process.env.LOBSTERAI_TEST_GATEWAY_REPAIR !== '1')('the packaged Doctor migrates v1 and the helper restores pinned plugins without losing history', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-repair-runtime-'));
  try {
    const runtimeRoot = fs.realpathSync(path.resolve('vendor/openclaw-runtime/current'));
    const stateDir = path.join(root, 'state');
    const backupDir = path.join(root, 'backup');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.mkdirSync(backupDir);
    fs.mkdirSync(path.join(root, 'cache'), { mode: 0o700 });
    const configPath = path.join(stateDir, 'openclaw.json');
    const config = {
      gateway: { mode: 'local', port: 19763, auth: { mode: 'token', token: 'fixture-only-token' } },
      agents: { defaults: { workspace: path.join(stateDir, 'workspace-main'), heartbeat: { every: '0m' } }, entries: { main: {} } },
      plugins: { enabled: false },
    };
    fs.writeFileSync(configPath, JSON.stringify(config));
    const databasePath = path.join(stateDir, 'state', 'openclaw.sqlite');
    const db = new DatabaseSync(databasePath);
    db.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE schema_meta (
        meta_key TEXT NOT NULL PRIMARY KEY, role TEXT NOT NULL, schema_version INTEGER NOT NULL,
        agent_id TEXT, app_version TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO schema_meta VALUES ('primary', 'global', 1, NULL, NULL, 10, 10);
      CREATE TABLE audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
        source_id TEXT NOT NULL UNIQUE, source_sequence INTEGER NOT NULL, occurred_at INTEGER NOT NULL,
        kind TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL, error_code TEXT,
        actor_type TEXT NOT NULL, actor_id TEXT NOT NULL, agent_id TEXT NOT NULL,
        session_key TEXT, session_id TEXT, run_id TEXT NOT NULL, tool_call_id TEXT, tool_name TEXT
      );
      CREATE INDEX idx_audit_events_time ON audit_events(occurred_at DESC, sequence DESC);
      CREATE INDEX idx_audit_events_agent_sequence ON audit_events(agent_id, sequence DESC);
      CREATE INDEX idx_audit_events_session_sequence ON audit_events(session_key, sequence DESC);
      CREATE INDEX idx_audit_events_run_sequence ON audit_events(run_id, sequence DESC);
      CREATE INDEX idx_audit_events_kind_sequence ON audit_events(kind, sequence DESC);
      CREATE INDEX idx_audit_events_status_sequence ON audit_events(status, sequence DESC);
      INSERT INTO audit_events VALUES (7, 'keep-event', 'source:1', 1, 100, 'agent_run', 'agent.run.started',
        'started', NULL, 'agent', 'main', 'main', NULL, NULL, 'keep-run', NULL, NULL);
    `);
    db.close();
    const params = {
      stateDir, configPath, runtimeRoot, backupDir, electronNodeRuntimePath: process.execPath,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, XDG_CACHE_HOME: path.join(root, 'cache') },
    };
    await runOpenClawCompatibilityRepair({ ...params, phase: OpenClawRepairPhase.LockRecovery });
    await runOpenClawCompatibilityRepair({ ...params, phase: OpenClawRepairPhase.Snapshot });
    // The generic upstream preflight allows old global versions for startup
    // migration. One-click repair must explicitly refuse incomplete migration.
    await expect(runOpenClawCompatibilityRepair({ ...params, phase: OpenClawRepairPhase.Recovery })).rejects.toThrow('schema version 1');
    await runOpenClawDoctorRepair(params);
    await runOpenClawCompatibilityRepair({ ...params, phase: OpenClawRepairPhase.Recovery });
    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    const saved = new DatabaseSync(path.join(backupDir, 'original', 'state', 'openclaw.sqlite'), { readOnly: true });
    try {
      expect(migrated.prepare('PRAGMA user_version').get()?.user_version).toBe(15);
      expect(saved.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
      expect(migrated.prepare('SELECT event_id FROM audit_events').all()).toEqual([{ event_id: 'keep-event' }]);
    } finally { migrated.close(); saved.close(); }
    const ids = ['deepseek', 'stepfun'];
    const legacyConfigPath = path.join(root, 'legacy-plugin-records.json');
    fs.writeFileSync(legacyConfigPath, JSON.stringify({ plugins: { installs: Object.fromEntries(ids.map(id => [id, {
      source: OpenClawRepairPluginSource.Npm, spec: `@openclaw/${id}-provider@2026.6.1`, installPath: path.join(stateDir, 'npm', 'projects', id, 'node_modules', '@openclaw', `${id}-provider`),
    }])) } }));
    fs.writeFileSync(configPath, JSON.stringify({ ...config, plugins: {
      allow: ids, load: { paths: ids.map(id => path.join(runtimeRoot, 'third-party-extensions', id)) },
    } }));
    const report = await runOpenClawCompatibilityRepair({ ...params, phase: OpenClawRepairPhase.Plugins, legacyConfigPath });
    expect(report.changes).toEqual(ids.map(id => `Restored bundled plugin ${id} from the packaged runtime.`));
    expect((await runOpenClawCompatibilityRepair({ ...params, phase: OpenClawRepairPhase.Plugins, legacyConfigPath })).success).toBe(true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 180_000);
