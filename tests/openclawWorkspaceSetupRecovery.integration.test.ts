// Run only against an explicitly selected bundled runtime and disposable state.
// OPENCLAW_STARTUP_MIGRATION_RUNTIME=<runtime> npm test -- openclawWorkspaceSetupRecovery
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  OPENCLAW_STARTUP_MIGRATION_ENTRY,
  OPENCLAW_STARTUP_MIGRATION_RESULT_PREFIX,
  OpenClawStartupMigrationOwner,
  type OpenClawStartupMigrationReport,
  OpenClawStartupMigrationStatus,
} from '../src/shared/openclawEngine/startupMigration';
import { readRepairedGatewayHistory } from './helpers/openclawGatewayRepairSmoke';

const runtimeRoot = process.env.OPENCLAW_STARTUP_MIGRATION_RUNTIME;
const execFileAsync = promisify(execFile);
const RECOVERY_RESOLUTION = 'archived-reappeared-setup';
const INITIAL = {
  version: 1,
  bootstrapSeededAt: '2026-08-09T11:04:21.963Z',
  setupCompletedAt: '2026-08-09T11:06:10.877Z',
};
const REAPPEARED = '{\n  "version": 1,\n  "setupCompletedAt": "2026-09-17T08:37:39.987Z"\n}\n';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
let tempDir: string;
let stateDir: string;
let workspaceDir: string;
let configPath: string;
let markerPath: string;
let env: NodeJS.ProcessEnv;

describe.skipIf(!runtimeRoot)('bundled workspace setup recovery', () => {
  beforeEach(async () => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-setup-recovery-')));
    stateDir = path.join(tempDir, 'state');
    workspaceDir = path.join(tempDir, 'external workspace');
    configPath = path.join(stateDir, 'openclaw.json');
    markerPath = path.join(workspaceDir, '.openclaw', 'workspace-state.json');
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'identity'), { recursive: true });
    const alias = path.join(stateDir, 'workspace-main');
    fs.symlinkSync(workspaceDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
    fs.writeFileSync(path.join(workspaceDir, 'MEMORY.md'), 'Preserve durable user memory.\n');
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { mode: 'local', bind: 'loopback', auth: { mode: 'token', token: '${OPENCLAW_GATEWAY_TOKEN}' }, controlUi: { enabled: false } },
      agents: { ownership: 'explicit', entries: { main: { workspace: alias } },
        defaults: { workspace: alias, systemAgent: { agentId: 'main' }, authInheritance: { agentId: 'main' } } },
      plugins: { allow: [] },
      logging: { file: path.join(tempDir, 'gateway.log') },
      cron: { enabled: false }, browser: { enabled: false },
    }));
    env = {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      HOME: tempDir, USERPROFILE: tempDir, XDG_CACHE_HOME: path.join(tempDir, 'cache'),
      TMPDIR: tempDir, TMP: tempDir, TEMP: tempDir,
      OPENCLAW_HOME: tempDir, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_GATEWAY_TOKEN: 'isolated-gateway-repair-fixture',
      OPENCLAW_NO_AUTO_UPDATE: '1', OPENCLAW_SERVICE_REPAIR_POLICY: 'external',
      OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED: '1',
      NODE_COMPILE_CACHE: path.join(tempDir, 'compile-cache'), NODE_ENV: 'production',
    };
    // Let the bundled migration owner initialize its schema before seeding the
    // partial canonical setup state that produced a non-authoritative receipt.
    fs.writeFileSync(path.join(stateDir, 'identity/device-auth.json'), JSON.stringify({
      version: 1, deviceId: 'isolated-setup-recovery-fixture', tokens: {},
    }));
    expect((await migrate()).code).toBe(0);
    const canonicalPath = process.platform === 'win32' ? workspaceDir.toLowerCase() : workspaceDir;
    withDatabase(db => db.prepare(
      'INSERT INTO workspace_setup_state (workspace_key, workspace_path, version, bootstrap_seeded_at, updated_at) VALUES (?, ?, 1, ?, 1)',
    ).run(digest(canonicalPath), canonicalPath, INITIAL.bootstrapSeededAt), false);
    fs.writeFileSync(markerPath, JSON.stringify(INITIAL));
    expect((await migrate()).code).toBe(0);
    const receipt = readReceipt();
    expect(receipt.removed_source).toBe(1);
    expect(JSON.parse(String(receipt.report_json))).toMatchObject({ authoritative: false, resolution: 'merged' });
    fs.writeFileSync(markerPath, REAPPEARED);
  }, 60_000);

  afterEach(() => {
    if (!tempDir || !tempDir.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)) {
      throw new Error('Refusing to clean up outside the temporary fixture directory');
    }
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  function withDatabase<T>(read: (db: DatabaseSync) => T, readOnly = true): T {
    const db = new DatabaseSync(path.join(stateDir, 'state/openclaw.sqlite'), { readOnly });
    try { return read(db); } finally { db.close(); }
  }

  function readState() {
    return withDatabase(db => db.prepare('SELECT * FROM workspace_setup_state').all());
  }

  function readReceipt() {
    return withDatabase(db => db.prepare("SELECT * FROM migration_sources WHERE target_table='workspace_setup_state'").get()!);
  }

  async function migrate(): Promise<{ code: number; report: OpenClawStartupMigrationReport }> {
    let stdout: string;
    let code = 0;
    try {
      ({ stdout } = await execFileAsync(process.execPath, [path.join(runtimeRoot!, OPENCLAW_STARTUP_MIGRATION_ENTRY)], {
        cwd: runtimeRoot, env, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024,
      }));
    } catch (error) {
      const failure = error as Error & { code: number; stdout: string };
      if (failure.code !== 1) throw error;
      ({ code, stdout } = failure);
    }
    const line = stdout.split(/\r?\n/).find(value => value.startsWith(OPENCLAW_STARTUP_MIGRATION_RESULT_PREFIX));
    expect(line, stdout.slice(-3000)).toBeDefined();
    return { code, report: JSON.parse(line!.slice(OPENCLAW_STARTUP_MIGRATION_RESULT_PREFIX.length)) };
  }

  test('archives regenerated setup state, preserves canonical data, and remains stable on retry', async () => {
    const before = readState();
    const configBefore = fs.readFileSync(configPath, 'utf8');
    const result = await migrate();
    expect(result).toMatchObject({ code: 0, report: {
      status: OpenClawStartupMigrationStatus.Migrated, warnings: [], remainingPaths: [],
      sourceCounts: { [OpenClawStartupMigrationOwner.Workspace]: 1 },
    } });
    expect(readState()).toEqual(before);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(configBefore);
    expect(fs.readFileSync(path.join(workspaceDir, 'MEMORY.md'), 'utf8')).toBe('Preserve durable user memory.\n');
    const receipt = readReceipt();
    const report = JSON.parse(String(receipt.report_json));
    expect(report).toMatchObject({ resolution: RECOVERY_RESOLUTION, authoritative: false, imported: false });
    expect(receipt).toMatchObject({ removed_source: 1, source_sha256: digest(REAPPEARED) });
    expect(report.backupPath.startsWith(path.join(stateDir, 'workspace-setup-quarantine') + path.sep)).toBe(true);
    expect(fs.readFileSync(report.backupPath, 'utf8')).toBe(REAPPEARED);
    expect(fs.lstatSync(path.join(stateDir, 'workspace-main')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(markerPath)).toBe(false);
    expect((await migrate()).report.status).toBe(OpenClawStartupMigrationStatus.Skipped);
    fs.writeFileSync(markerPath, REAPPEARED);
    expect((await migrate()).code).toBe(0);
    expect(JSON.parse(String(readReceipt().report_json)).backupPath).toBe(report.backupPath);
    expect(readState()).toEqual(before);
  }, 60_000);

  test('keeps an unverified conflict blocked without changing SQLite or the source', async () => {
    withDatabase(db => db.prepare('UPDATE workspace_setup_state SET setup_completed_at=?').run('2026-09-16T00:00:00.000Z'), false);
    const before = readState();
    const result = await migrate();
    expect(result.code).toBe(1);
    expect(result.report.status).toBe(OpenClawStartupMigrationStatus.Failed);
    expect(result.report.warnings.join(' ')).toContain('conflicts with canonical SQLite state');
    expect(result.report.remainingPaths).toContain(markerPath);
    expect(readState()).toEqual(before);
    expect(fs.readFileSync(markerPath, 'utf8')).toBe(REAPPEARED);
  }, 60_000);

  test.runIf(process.env.OPENCLAW_STARTUP_MIGRATION_GATEWAY === '1')(
    'starts an authenticated gateway after recovery and again after restart', async () => {
      expect((await migrate()).code).toBe(0);
      const before = readState();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const history = await readRepairedGatewayHistory({ runtimeRoot: runtimeRoot!, env, sessionKey: 'agent:main:main' });
        expect(JSON.parse(history).messages).toEqual([]);
        expect((await migrate()).report.status).toBe(OpenClawStartupMigrationStatus.Skipped);
      }
      const after = readState();
      expect(after.map(row => [row.workspace_path, row.bootstrap_seeded_at, row.setup_completed_at]))
        .toEqual(before.map(row => [row.workspace_path, row.bootstrap_seeded_at, row.setup_completed_at]));
      expect(fs.existsSync(markerPath)).toBe(false);
      expect(fs.readFileSync(path.join(workspaceDir, 'MEMORY.md'), 'utf8')).toBe('Preserve durable user memory.\n');
    }, 120_000,
  );
});
