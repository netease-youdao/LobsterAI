// Run against a built runtime, using only temporary state:
// OPENCLAW_STARTUP_MIGRATION_RUNTIME=<runtime> npm test -- openclawStartupStateMigration
import { execFile, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
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

const runtimeRoot = process.env.OPENCLAW_STARTUP_MIGRATION_RUNTIME;
const GatewayProbeMethod = {
  Config: 'config.get', Agents: 'agents.list', ExecApprovals: 'exec.approvals.get',
} as const;
const execFileAsync = promisify(execFile);
const seededAt = '2026-09-01T01:02:03.000Z';
const completedAt = '2026-09-02T04:05:06.000Z';
const content = JSON.stringify({ version: 1, bootstrapSeededAt: seededAt, onboardingCompletedAt: completedAt });
const digest = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let tempDir: string;
let stateDir: string;
let configPath: string;
let workspaces: string[];

describe.skipIf(!runtimeRoot)('bundled OpenClaw startup state migration', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-workspace-migration-integration-'));
    stateDir = path.join(tempDir, 'state');
    configPath = path.join(stateDir, 'openclaw.json');
    workspaces = [path.join(stateDir, 'workspace-main'), path.join(tempDir, 'custom workspace')];
    for (const workspace of workspaces) {
      fs.mkdirSync(path.join(workspace, '.openclaw'), { recursive: true });
      for (const filename of ['AGENTS.md', 'SOUL.md', 'USER.md', 'IDENTITY.md', 'MEMORY.md']) {
        fs.writeFileSync(path.join(workspace, filename), `# Preserve ${filename}\nUser content.\n`);
      }
    }
    fs.writeFileSync(configPath, JSON.stringify({
      agents: { entries: { main: { default: true, workspace: workspaces[0] }, custom: { workspace: workspaces[1] } } },
      // A full Doctor/validator would reject this: this migration must leave IM alone.
      channels: { discord: { accounts: { fixture: { dm: { policy: 'open', allowFrom: ['*'] } } } } },
      plugins: { load: { paths: [path.join(tempDir, 'must-not-load-plugin')] } },
    }));
  });
  afterEach(() => {
    if (!path.resolve(tempDir).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
      throw new Error('Refusing to clean up outside the temporary fixture directory');
    }
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  async function migrate(): Promise<{ code: number; report: OpenClawStartupMigrationReport }> {
    const args = [path.join(runtimeRoot!, OPENCLAW_STARTUP_MIGRATION_ENTRY)];
    const options = {
      cwd: runtimeRoot, windowsHide: true, timeout: 30_000,
      env: { ...process.env, OPENCLAW_HOME: tempDir, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
    };
    let stdout: string;
    let stderr = '';
    let code = 0;
    try {
      ({ stdout, stderr } = await execFileAsync(process.execPath, args, options));
    } catch (error) {
      const failure = error as Error & { code: number; stdout: string; stderr: string };
      if (failure.code !== 1) throw error;
      code = failure.code;
      stdout = failure.stdout;
      stderr = failure.stderr;
    }
    const line = stdout.split(/\r?\n/).find(value => value.startsWith(OPENCLAW_STARTUP_MIGRATION_RESULT_PREFIX));
    expect(line, (stdout + stderr).slice(-3000)).toBeDefined();
    return { code, report: JSON.parse(line!.slice(OPENCLAW_STARTUP_MIGRATION_RESULT_PREFIX.length)) };
  }

  function seedIdentity(suffix = '') {
    const keys = generateKeyPairSync('ed25519');
    const identity = {
      version: 1,
      deviceId: createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)).digest('hex'),
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }),
      privateKeyPem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      createdAtMs: Date.parse(seededAt),
    };
    const source = path.join(stateDir, 'identity/device.json' + suffix);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, JSON.stringify(identity), { mode: 0o600 });
    return { identity, source };
  }

  function withDatabase<T>(read: (db: DatabaseSync) => T, readOnly = true): T {
    const db = new DatabaseSync(path.join(stateDir, 'state/openclaw.sqlite'), { readOnly });
    try { return read(db); } finally { db.close(); }
  }

  test.each([false, true])('imports device identity with auth=%s when no cron/session/workspace migration is needed', async (includeAuth) => {
    const { identity, source } = seedIdentity();
    const configBefore = digest(configPath);
    const authPath = path.join(stateDir, 'identity/device-auth.json');
    const token = randomBytes(24).toString('hex');
    if (includeAuth) {
      fs.writeFileSync(authPath, JSON.stringify({ version: 1, deviceId: identity.deviceId,
        tokens: { operator: { token, scopes: ['operator.admin'], updatedAtMs: identity.createdAtMs } },
      }));
    }
    const result = await migrate();
    expect(result).toMatchObject({ code: 0, report: {
      status: OpenClawStartupMigrationStatus.Migrated, warnings: [], remainingPaths: [],
      sourceCounts: {
        [OpenClawStartupMigrationOwner.DeviceIdentity]: 1,
        [OpenClawStartupMigrationOwner.DeviceAuth]: includeAuth ? 1 : 0,
        [OpenClawStartupMigrationOwner.ExecApprovals]: 0,
        [OpenClawStartupMigrationOwner.Workspace]: 0,
      },
    } });
    const rows = withDatabase(db => db.prepare('SELECT * FROM device_identities').all());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ identity_key: 'primary', device_id: identity.deviceId,
      public_key_pem: identity.publicKeyPem, private_key_pem: identity.privateKeyPem, created_at_ms: identity.createdAtMs });
    if (includeAuth) {
      expect(withDatabase(db => db.prepare('SELECT * FROM device_auth_tokens').get())).toMatchObject({
        device_id: identity.deviceId, token, role: 'operator', scopes_json: '["operator.admin","operator.read","operator.write"]', updated_at_ms: identity.createdAtMs,
      });
      expect(fs.existsSync(authPath)).toBe(false);
    }
    expect(fs.existsSync(source)).toBe(false);
    expect(digest(configPath)).toBe(configBefore);
    expect((await migrate()).report.status).toBe(OpenClawStartupMigrationStatus.Skipped);
    expect(withDatabase(db => db.prepare('SELECT * FROM device_identities').all())).toEqual(rows);
  });

  test('imports auth without a legacy identity and does not generate an identity', async () => {
    const authPath = path.join(stateDir, 'identity/device-auth.json');
    fs.mkdirSync(path.dirname(authPath), { recursive: true });
    fs.writeFileSync(authPath, JSON.stringify({ version: 1, deviceId: 'fixture-device', tokens: {} }));
    expect((await migrate()).report.sourceCounts[OpenClawStartupMigrationOwner.DeviceAuth]).toBe(1);
    expect(withDatabase(db => db.prepare('SELECT COUNT(*) AS count FROM device_identities').get()?.count)).toBe(0);
    expect(fs.existsSync(authPath)).toBe(false);
  });

  test('recovers an interrupted Doctor identity import', async () => {
    const { identity, source } = seedIdentity('.doctor-importing');
    expect((await migrate()).code).toBe(0);
    expect(fs.existsSync(source)).toBe(false);
    expect(withDatabase(db => db.prepare('SELECT device_id FROM device_identities').get()?.device_id)).toBe(identity.deviceId);
  });

  test('keeps a native import claim for its owner and blocks startup', async () => {
    const { source } = seedIdentity('.native-importing');
    const before = digest(source);
    const result = await migrate();
    expect(result.code).toBe(1);
    expect(result.report.warnings.join(' ')).toContain('Native device identity import is pending');
    expect(result.report.remainingPaths).toContain(source);
    expect(digest(source)).toBe(before);
  });

  test('keeps an inert retired identity as a notice when a receipt and canonical keys are valid', async () => {
    const original = seedIdentity();
    expect((await migrate()).code).toBe(0);
    const conflicting = seedIdentity();
    const sourceBefore = digest(conflicting.source);
    const result = await migrate();
    expect(result.code).toBe(0);
    expect(result.report.remainingPaths).toEqual([]);
    expect(result.report.notices.join(' ')).toContain('canonical SQLite identity remains authoritative');
    expect(digest(conflicting.source)).toBe(sourceBefore);
    expect(withDatabase(db => db.prepare('SELECT device_id FROM device_identities').get()?.device_id)).toBe(original.identity.deviceId);
  });

  test('blocks a different canonical identity without a matching migration receipt', async () => {
    const original = seedIdentity();
    expect((await migrate()).code).toBe(0);
    withDatabase(db => db.exec('DELETE FROM migration_sources'), false);
    const conflicting = seedIdentity();
    const before = digest(conflicting.source);
    const result = await migrate();
    expect(result.code).toBe(1);
    expect(result.report.remainingPaths).toContain(conflicting.source);
    expect(digest(conflicting.source)).toBe(before);
    expect(withDatabase(db => db.prepare('SELECT device_id FROM device_identities').get()?.device_id)).toBe(original.identity.deviceId);
  });

  test('does not generate replacement keys for damaged SQLite-only identity', async () => {
    const original = seedIdentity();
    expect((await migrate()).code).toBe(0);
    withDatabase(db => db.exec("UPDATE device_identities SET private_key_pem = 'invalid'"), false);
    const before = withDatabase(db => db.prepare('SELECT * FROM device_identities').get());
    const result = await migrate();
    expect(result.code).toBe(1);
    expect(result.report.warnings.join(' ')).toContain('invalid persisted device identity');
    expect(fs.existsSync(original.source)).toBe(false);
    expect(withDatabase(db => db.prepare('SELECT * FROM device_identities').get())).toEqual(before);
  });

  test('reports both invalid device stores in one run and keeps their bytes', async () => {
    const { source } = seedIdentity();
    const authPath = path.join(stateDir, 'identity/device-auth.json');
    fs.writeFileSync(source, '{broken identity');
    fs.writeFileSync(authPath, '{broken auth');
    const result = await migrate();
    expect(result.code).toBe(1);
    expect(result.report.warnings.some(value => value.startsWith('[device-identity]'))).toBe(true);
    expect(result.report.warnings.some(value => value.startsWith('[device-auth]'))).toBe(true);
    expect(result.report.remainingPaths).toEqual(expect.arrayContaining([source, authPath]));
    expect(fs.readFileSync(source, 'utf8')).toBe('{broken identity');
    expect(fs.readFileSync(authPath, 'utf8')).toBe('{broken auth');
  });

  test('imports exec policy alongside workspace state and preserves policy on retry', async () => {
    const source = path.join(stateDir, 'exec-approvals.json');
    const policy = { version: 1, defaults: { security: 'allowlist', ask: 'on-miss', askFallback: 'deny' },
      agents: { main: { allowlist: [{ pattern: '/usr/bin/git', id: 'fixture-rule' }] } } };
    fs.writeFileSync(source, JSON.stringify(policy));
    fs.writeFileSync(path.join(workspaces[0], '.openclaw/workspace-state.json'), content);
    const result = await migrate();
    expect(result).toMatchObject({ code: 0, report: { sourceCount: 2, sourceCounts: {
      [OpenClawStartupMigrationOwner.ExecApprovals]: 1, [OpenClawStartupMigrationOwner.Workspace]: 1,
    } } });
    expect(fs.existsSync(source)).toBe(false);
    const raw = withDatabase(db => db.prepare('SELECT raw_json FROM exec_approvals_config').get()?.raw_json);
    expect(JSON.parse(String(raw))).toMatchObject(policy);
    expect((await migrate()).report.status).toBe(OpenClawStartupMigrationStatus.Skipped);
    expect(withDatabase(db => db.prepare('SELECT raw_json FROM exec_approvals_config').get()?.raw_json)).toBe(raw);
  });

  test('retains malformed exec approvals for recovery', async () => {
    const source = path.join(stateDir, 'exec-approvals.json');
    fs.writeFileSync(source, '{broken policy');
    const result = await migrate();
    expect(result.code).toBe(1);
    expect(result.report.remainingPaths).toContain(source);
    expect(fs.readFileSync(source, 'utf8')).toBe('{broken policy');
  });

  test.runIf(process.env.OPENCLAW_STARTUP_MIGRATION_GATEWAY === '1')(
    'starts after a state-only CLI checkpoint and serves config, agents and exec approvals after migration/restart', async () => {
      const { identity, source } = seedIdentity();
      const token = 'startup-migration-isolated-test-token';
      fs.writeFileSync(configPath, JSON.stringify({
        gateway: { mode: 'local', bind: 'loopback', auth: { mode: 'token', token: '${OPENCLAW_GATEWAY_TOKEN}' }, controlUi: { enabled: false } },
        agents: { ownership: 'explicit', entries: { main: { workspace: workspaces[0] } },
          defaults: { workspace: workspaces[0], systemAgent: { agentId: 'main' }, authInheritance: { agentId: 'main' } } },
        memory: { search: { enabled: true, provider: 'none', fallback: 'none', store: { vector: { enabled: false } } } },
        plugins: { allow: ['memory-core'], entries: { 'memory-core': { enabled: true, config: { dreaming: { enabled: false } } } } },
        cron: { enabled: false }, browser: { enabled: false },
      }));
      const env: NodeJS.ProcessEnv = { ...process.env, OPENCLAW_HOME: tempDir, OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_GATEWAY_TOKEN: token, OPENCLAW_SERVICE_REPAIR_POLICY: 'external',
        OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED: '1', NODE_COMPILE_CACHE: path.join(tempDir, 'compile-cache'), NODE_ENV: 'production' };
      delete env.VITEST;
      const cliPath = path.join(runtimeRoot!, 'openclaw.mjs');
      const cli = async (args: string[]) => execFileAsync(process.execPath, [cliPath, ...args], {
        cwd: runtimeRoot, env, windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
      });
      // This is LobsterAI's pre-fork CLI order. Its checkpoint does not certify
      // the Gateway-only identity import; the dedicated helper must check anyway.
      await cli(['memory', 'index', '--force']);
      expect(withDatabase(db => db.prepare("SELECT app_version FROM schema_meta WHERE meta_key = 'state-migrations'").get())).toBeDefined();
      expect(fs.existsSync(source)).toBe(true);
      const configBefore = digest(configPath);
      fs.writeFileSync(path.join(stateDir, 'identity/device-auth.json'), JSON.stringify({
        version: 1, deviceId: identity.deviceId, tokens: {},
      }));
      fs.writeFileSync(path.join(stateDir, 'exec-approvals.json'), JSON.stringify({
        version: 1, defaults: { security: 'allowlist', ask: 'on-miss', askFallback: 'deny' },
      }));
      expect((await migrate()).code).toBe(0);
      expect(digest(configPath)).toBe(configBefore);
      await cli(['memory', 'index', '--force']);

      for (let attempt = 0; attempt < 2; attempt++) {
        const server = net.createServer();
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as net.AddressInfo).port;
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        const gateway = spawn(process.execPath, [cliPath, 'gateway', '--bind', 'loopback', '--port', String(port), '--token', token], {
          cwd: runtimeRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
        const closed = new Promise<void>(resolve => gateway.once('close', () => resolve()));
        let output = '';
        gateway.stdout.on('data', chunk => { output = (output + String(chunk)).slice(-12000); });
        gateway.stderr.on('data', chunk => { output = (output + String(chunk)).slice(-12000); });
        try {
          let started = false;
          const deadline = Date.now() + 60_000;
          while (Date.now() < deadline && gateway.exitCode === null) {
            try {
              const response = await fetch(`http://127.0.0.1:${port}/startupz`, { signal: AbortSignal.timeout(1000) });
              const status = await response.json() as { status?: string };
              if (response.ok && status.status === 'started') { started = true; break; }
            } catch { /* The isolated Gateway has not bound its port yet. */ }
            await new Promise(resolve => setTimeout(resolve, 200));
          }
          expect(started, output.replaceAll(token, '[REDACTED]')).toBe(true);
          for (const method of Object.values(GatewayProbeMethod)) {
            const result = await cli(['gateway', 'call', method, '--url', `ws://127.0.0.1:${port}`, '--token', token, '--json']);
            const response = JSON.parse(result.stdout);
            if (method === GatewayProbeMethod.Config) expect(response.valid).toBe(true);
            if (method === GatewayProbeMethod.Agents) expect(response.agents.some((agent: { id: string }) => agent.id === 'main')).toBe(true);
            if (method === GatewayProbeMethod.ExecApprovals) expect(response.file.defaults.security).toBe('allowlist');
          }
        } finally {
          if (gateway.exitCode === null) gateway.kill();
          await closed;
        }
        expect((await migrate()).report.status).toBe(OpenClawStartupMigrationStatus.Skipped);
        expect(withDatabase(db => db.prepare('SELECT device_id FROM device_identities').get()?.device_id)).toBe(identity.deviceId);
      }
    }, 240_000);

  test('imports both legacy setup formats for all configured workspaces and preserves files/config/empty lock', async () => {
    const markers = [path.join(workspaces[0], '.openclaw/workspace-state.json'), path.join(workspaces[1], 'openclaw-workspace-state.json')];
    for (const marker of markers) fs.writeFileSync(marker, content);
    fs.writeFileSync(`${configPath}.lock`, '');
    const lockMtime = fs.statSync(`${configPath}.lock`).mtimeMs;
    const protectedFiles = [configPath, ...workspaces.flatMap(workspace =>
      ['AGENTS.md', 'SOUL.md', 'USER.md', 'IDENTITY.md', 'MEMORY.md'].map(name => path.join(workspace, name)))];
    const before = protectedFiles.map(digest);
    const result = await migrate();
    expect(result.code).toBe(0);
    expect(result.report).toMatchObject({ status: OpenClawStartupMigrationStatus.Migrated, sourceCount: 2, warnings: [], remainingPaths: [] });
    expect(markers.every(marker => !fs.existsSync(marker))).toBe(true);
    expect(protectedFiles.map(digest)).toEqual(before);
    expect(fs.statSync(`${configPath}.lock`).size).toBe(0);
    expect(fs.statSync(`${configPath}.lock`).mtimeMs).toBe(lockMtime);
    const db = new DatabaseSync(path.join(stateDir, 'state/openclaw.sqlite'), { readOnly: true });
    try {
      const rows = db.prepare('SELECT bootstrap_seeded_at, setup_completed_at FROM workspace_setup_state').all();
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(Array.from({ length: 2 }, () => ({ bootstrap_seeded_at: seededAt, setup_completed_at: completedAt })));
    } finally { db.close(); }
    expect((await migrate()).report.status).toBe(OpenClawStartupMigrationStatus.Skipped);
  });

  test('preserves invalid state and retries successfully after it is repaired', async () => {
    const marker = path.join(workspaces[0], 'openclaw-workspace-state.json');
    fs.writeFileSync(marker, '{broken');
    const failed = await migrate();
    expect(failed.code).toBe(1);
    expect(failed.report.status).toBe(OpenClawStartupMigrationStatus.Failed);
    expect(failed.report.warnings.join(' ')).toContain('invalid JSON');
    expect(fs.readFileSync(marker, 'utf8')).toBe('{broken');
    fs.writeFileSync(marker, content);
    expect((await migrate()).report.status).toBe(OpenClawStartupMigrationStatus.Migrated);
  });

  test('recovers an interrupted Doctor claim', async () => {
    const marker = path.join(workspaces[1], 'openclaw-workspace-state.json.doctor-importing');
    fs.writeFileSync(marker, content);
    const result = await migrate();
    expect(result.code).toBe(0);
    expect(result.report.status).toBe(OpenClawStartupMigrationStatus.Migrated);
    expect(fs.existsSync(marker)).toBe(false);
  });

  test('imports owned attestation files and preserves unrelated sibling files', async () => {
    const attestation = `${workspaces[0]}.attested`;
    const unrelated = `${workspaces[1]}.attested`;
    const generatedHash = digest(path.join(workspaces[0], 'AGENTS.md'));
    fs.writeFileSync(attestation, `openclaw-workspace-attestation:v1\n${seededAt}\ngenerated:AGENTS.md:${generatedHash}\n`);
    fs.writeFileSync(unrelated, 'Unrelated user file');
    const result = await migrate();
    expect(result.code).toBe(0);
    expect(result.report.status).toBe(OpenClawStartupMigrationStatus.Migrated);
    expect(fs.existsSync(attestation)).toBe(false);
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('Unrelated user file');
    const db = new DatabaseSync(path.join(stateDir, 'state/openclaw.sqlite'), { readOnly: true });
    try {
      expect(db.prepare('SELECT COUNT(*) AS count FROM workspace_generated_bootstrap_hashes').get()?.count).toBe(1);
    } finally { db.close(); }
  });

  test('does not create a database when there are no legacy workspace sources', async () => {
    expect((await migrate()).report.status).toBe(OpenClawStartupMigrationStatus.Skipped);
    expect(fs.existsSync(path.join(stateDir, 'state/openclaw.sqlite'))).toBe(false);
  });

  test.each([0, 59])('quarantines a %i-byte zero-filled attestation without changing workspace/config', async (size) => {
    const workspace = fs.realpathSync.native(workspaces[0]);
    const marker = path.join(stateDir, 'workspace-attestations',
      createHash('sha256').update(workspace).digest('hex') + '.attested');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    const bytes = Buffer.alloc(size);
    fs.writeFileSync(marker, bytes);
    const mtimeMs = fs.statSync(marker).mtimeMs;
    const protectedFiles = [configPath, ...workspaces.flatMap(directory =>
      ['AGENTS.md', 'SOUL.md', 'USER.md', 'IDENTITY.md', 'MEMORY.md'].map(name => path.join(directory, name)))];
    const before = protectedFiles.map(digest);
    const result = await migrate();
    expect(result).toMatchObject({
      code: 0,
      report: { status: OpenClawStartupMigrationStatus.Migrated, sourceCount: 1, warnings: [], remainingPaths: [] },
    });
    const quarantine = path.join(stateDir, 'workspace-attestation-quarantine');
    const backups = fs.readdirSync(quarantine).filter(name => name.endsWith('.attested'));
    expect(backups).toHaveLength(1);
    const backupPath = path.join(quarantine, backups[0]);
    expect(fs.readFileSync(backupPath)).toEqual(bytes);
    const metadata = JSON.parse(fs.readFileSync(backupPath.replace(/\.attested$/, '.json'), 'utf8'));
    expect(metadata).toMatchObject({ sourcePath: marker, size, mtimeMs, sha256: digest(backupPath) });
    expect(result.report.changes.join('\n')).toContain(backupPath);
    expect(fs.existsSync(marker)).toBe(false);
    expect(protectedFiles.map(digest)).toEqual(before);
    expect((await migrate()).report.status).toBe(OpenClawStartupMigrationStatus.Skipped);
    expect(fs.readdirSync(quarantine).filter(name => name.endsWith('.attested'))).toEqual(backups);
  });

  test('keeps a full-NUL attestation when the backup cannot be written', async () => {
    const marker = path.join(stateDir, 'workspace-attestations',
      createHash('sha256').update(fs.realpathSync.native(workspaces[0])).digest('hex') + '.attested');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, Buffer.alloc(59));
    fs.writeFileSync(path.join(stateDir, 'workspace-attestation-quarantine'), 'unrelated existing file');
    const result = await migrate();
    expect(result.code).toBe(1);
    expect(result.report.status).toBe(OpenClawStartupMigrationStatus.Failed);
    expect(result.report.warnings.join('\n')).toContain('Failed quarantining');
    expect(result.report.remainingPaths).toContain(marker);
    expect(fs.readFileSync(marker)).toEqual(Buffer.alloc(59));
    expect(fs.existsSync(marker + '.doctor-importing')).toBe(false);
  });
});
