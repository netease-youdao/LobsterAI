import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runOpenClawCompatibilityRepair, runOpenClawDoctorRepair } from '../src/main/libs/openclawCompatibilityRepair';
import { parseOpenClawConfigValidateOutput } from '../src/main/libs/openclawConfigSelfHeal';
import { OPENCLAW_REPAIR_PREFLIGHT_REPORT, type OpenClawRepairPreflightReport } from '../src/main/libs/openclawRepairPreflight';
import { migrateLegacySessionStorageWithDoctor } from '../src/main/libs/openclawSessionLegacyMigration';
import { runStartupMigration } from '../src/main/libs/openclawStartupStateMigration';
import { OpenClawRepairPhase } from '../src/shared/openclawEngine/repair';
import { readRepairedGatewayHistory } from './helpers/openclawGatewayRepairSmoke';

// Opt in with the pinned runtime, including the current LobsterAI repair helpers.
const runtimeRoot = process.env.OPENCLAW_REPAIR_TEST_RUNTIME;
let root: string;
let stateDir: string;
let configPath: string;
let backupDir: string;

describe.skipIf(!runtimeRoot)('Quick Repair legacy preflight with the bundled runtime', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'lobster-repair-integration-'));
    stateDir = path.join(root, 'state');
    backupDir = path.join(root, 'backup');
    configPath = path.join(stateDir, 'openclaw.json');
    for (const dir of [stateDir, backupDir, path.join(root, 'cache')]) fs.mkdirSync(dir);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));

  const params = () => ({
    runtimeRoot: runtimeRoot!, stateDir, configPath, backupDir, electronNodeRuntimePath: process.execPath,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      HOME: root, USERPROFILE: root, TMPDIR: root, TEMP: root, TMP: root, XDG_CACHE_HOME: path.join(root, 'cache'),
      OPENCLAW_HOME: root, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(runtimeRoot!, 'dist', 'extensions'),
    },
  });
  const config = () => ({ gateway: { mode: 'local' },
    agents: { entries: { main: {} }, defaults: { workspace: path.join(stateDir, 'workspace-main'), heartbeat: { every: '0m' } } },
    plugins: { enabled: false },
  });
  const writeConfig = (value: unknown) => fs.writeFileSync(configPath, JSON.stringify(value, null, 2));
  const report = (): OpenClawRepairPreflightReport => JSON.parse(fs.readFileSync(path.join(backupDir, OPENCLAW_REPAIR_PREFLIGHT_REPORT), 'utf8'));
  async function repair() {
    await runOpenClawCompatibilityRepair({ ...params(), phase: OpenClawRepairPhase.LockRecovery });
    await runOpenClawCompatibilityRepair({ ...params(), phase: OpenClawRepairPhase.Snapshot });
    await runOpenClawDoctorRepair(params());
    await runOpenClawCompatibilityRepair({ ...params(), phase: OpenClawRepairPhase.Recovery });
    await runOpenClawCompatibilityRepair({
      ...params(), phase: OpenClawRepairPhase.Plugins,
      legacyConfigPath: path.join(backupDir, 'original', 'openclaw.json'),
    });
  }
  async function validate() {
    const result = await runStartupMigration(process.execPath, [path.join(runtimeRoot!, 'openclaw.mjs'), 'config', 'validate', '--json'], {
      cwd: runtimeRoot!, env: params().env, timeoutMs: 60_000,
    });
    expect(parseOpenClawConfigValidateOutput(result.stdout)).toMatchObject({ valid: true });
  }

  test('retired fields no longer block old reload/discovery migration, and plugin install data survives', async () => {
    const installs = { demo: { source: 'npm', spec: 'demo@1.0.0' } };
    const original = { ...config(), gateway: { mode: 'local', reload: { mode: 'hot' } },
      plugins: { enabled: false, bundledDiscovery: 'compat', installs },
      session: { maintenance: { rotateBytes: 1000 } }, cron: { maxConcurrentRuns: 3 },
    };
    writeConfig(original);
    await repair();
    await validate();
    const updated = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(updated.gateway.reload.mode).toBe('hybrid');
    expect(updated.plugins).not.toHaveProperty('bundledDiscovery');
    expect(updated.plugins).not.toHaveProperty('installs');
    expect(JSON.parse(fs.readFileSync(path.join(backupDir, 'original', 'openclaw.json'), 'utf8'))).toEqual(original);
    expect(report().config).toMatchObject({ removed: ['session.maintenance.rotateBytes', 'cron.maxConcurrentRuns'] });
    const db = new DatabaseSync(path.join(stateDir, 'state', 'openclaw.sqlite'), { readOnly: true });
    try {
      expect(db.prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'plugins.bundledDiscovery'").get()?.value_json)
        .toBe('"compat"');
      const index = db.prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'plugins.installedIndex'").get();
      expect(JSON.parse(String(index?.value_json)).index.installRecords).toEqual(installs);
    } finally { db.close(); }
  }, 180_000);

  test('BOM history imports while a damaged peer index stays recoverable; history survives gateway restart', async () => {
    writeConfig(config());
    const sessions = path.join(stateDir, 'agents', 'main', 'sessions');
    const brokenStore = path.join(stateDir, 'agents', 'worker', 'sessions', 'sessions.json');
    fs.mkdirSync(sessions, { recursive: true });
    fs.mkdirSync(path.dirname(brokenStore), { recursive: true });
    const storePath = path.join(sessions, 'sessions.json');
    const transcriptPath = path.join(sessions, 'legacy-session.jsonl');
    const original = '\uFEFF' + JSON.stringify({
      'agent:main:main': { sessionId: 'legacy-session', updatedAt: Date.now(), sessionFile: transcriptPath },
    });
    fs.writeFileSync(storePath, original);
    fs.writeFileSync(brokenStore, '\u0000{"agent:worker:main":');
    fs.writeFileSync(transcriptPath, [
      { type: 'session', version: 3, id: 'legacy-session', timestamp: '2026-09-01T00:00:00.000Z', cwd: root },
      { type: 'message', id: 'legacy-message', parentId: null, timestamp: '2026-09-01T00:00:01.000Z',
        message: { role: 'user', content: 'retained BOM session history' } },
    ].map(event => JSON.stringify(event)).join('\n') + '\n');
    await repair();
    const imported = await migrateLegacySessionStorageWithDoctor(params());
    expect(imported.status, JSON.stringify(imported)).not.toBe('failed');
    expect(report().repairedSessionStores).toEqual([storePath]);
    expect(report().quarantinedSessionStores).toHaveLength(1);
    expect(fs.readFileSync(report().quarantinedSessionStores[0].quarantinePath, 'utf8')).toBe('\u0000{"agent:worker:main":');
    expect(fs.readFileSync(path.join(backupDir, 'original', 'agents', 'main', 'sessions', 'sessions.json'), 'utf8')).toBe(original);
    const gateway = { runtimeRoot: runtimeRoot!, env: params().env, sessionKey: 'agent:main:main' };
    expect(await readRepairedGatewayHistory(gateway)).toContain('retained BOM session history');
    expect(await readRepairedGatewayHistory(gateway)).toContain('retained BOM session history');
  }, 180_000);

  test('a previous install path is replaced before Doctor so QQ channel validation still works', async () => {
    const old = path.join(root, 'old-install', 'resources', 'cfmind', 'third-party-extensions');
    writeConfig({ ...config(), plugins: {
      allow: ['openclaw-qqbot'], entries: { 'openclaw-qqbot': { enabled: true } }, load: { paths: [old] },
    }, channels: { qqbot: { enabled: false, allowFrom: ['openclaw:approval-disabled'] } } });
    await repair();
    await validate();
    expect(report().replacedPluginLoadPaths).toEqual([old]);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).plugins.load.paths)
      .toContain(path.join(runtimeRoot!, 'third-party-extensions'));
  }, 180_000);
});
