// Run against a rebuilt runtime, using only temporary state and synthetic credentials:
// OPENCLAW_STARTUP_MIGRATION_RUNTIME=<runtime> npm test -- openclawAuthProfileMigration
import { execFile } from 'node:child_process';
import { createCipheriv, createHash } from 'node:crypto';
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

const runtimeRoot = process.env.OPENCLAW_STARTUP_MIGRATION_RUNTIME;
const execFileAsync = promisify(execFile);
const profileId = 'lobsterai-server:fixture';
const fixtureCredential = {
  type: 'api_key', provider: 'lobsterai-server', key: 'synthetic-api-key-only',
  email: 'fixture@example.invalid', displayName: 'Migration fixture',
  copyToAgents: false, metadata: { accountId: 'synthetic-account' },
};
const fixtureState = {
  version: 1, order: { 'lobsterai-server': [profileId] },
  lastGood: { 'lobsterai-server': profileId },
  usageStats: { [profileId]: { lastUsed: 123, errorCount: 2 } },
};
const sidecarSeed = 'synthetic-sidecar-seed-only';
let tempDir: string;
let stateDir: string;
let configPath: string;
let agentDir: string;
let pluginMarker: string;
let configBytes: string;

describe.skipIf(!runtimeRoot)('bundled OpenClaw auth profile migration', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-auth-migration-integration-'));
    stateDir = path.join(tempDir, 'state');
    configPath = path.join(stateDir, 'openclaw.json');
    agentDir = path.join(stateDir, 'agents/agent/agent');
    pluginMarker = path.join(tempDir, 'plugin-was-loaded');
    const pluginDir = path.join(tempDir, 'must-not-load-plugin');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(pluginDir);
    fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({
      name: 'auth-migration-fixture-plugin', version: '1.0.0', type: 'module',
      openclaw: { extensions: ['./index.mjs'] },
    }));
    fs.writeFileSync(path.join(pluginDir, 'openclaw.plugin.json'), JSON.stringify({
      id: 'auth-migration-fixture-plugin', configSchema: { type: 'object', additionalProperties: false },
    }));
    fs.writeFileSync(path.join(pluginDir, 'index.mjs'),
      `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(pluginMarker)}, 'loaded'); throw new Error('Migration loaded a plugin');`);
    configBytes = JSON.stringify({
      meta: { lastTouchedVersion: '2026.8.1' },
      agents: { ownership: 'explicit', entries: { agent: {} },
        defaults: { systemAgent: { agentId: 'agent' }, authInheritance: { agentId: 'agent' } } },
      logging: { file: path.join(tempDir, 'migration.log') },
      // Deliberately invalid under general Doctor validation: this repair owns only state.
      channels: { discord: { accounts: { fixture: { dm: { policy: 'open', allowFrom: ['*'] } } } } },
      plugins: { allow: ['auth-migration-fixture-plugin'], load: { paths: [pluginDir] } },
      models: { providers: { 'lobsterai-server': { baseUrl: 'https://example.invalid/v1', models: [] } } },
    }, null, 2);
    fs.writeFileSync(configPath, configBytes);
  });

  afterEach(() => {
    if (!path.resolve(tempDir).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
      throw new Error('Refusing to clean up outside the temporary fixture directory');
    }
    try {
      expect(fs.readFileSync(configPath, 'utf8')).toBe(configBytes);
      expect(fs.existsSync(pluginMarker)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  async function migrate(): Promise<{ code: number; report: OpenClawStartupMigrationReport }> {
    // Do not inherit a developer's agent dir, credential directory, OAuth key or HOME.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      HOME: tempDir, USERPROFILE: tempDir, APPDATA: path.join(tempDir, 'appdata'),
      XDG_CONFIG_HOME: path.join(tempDir, 'config'), TMPDIR: tempDir, TEMP: tempDir, TMP: tempDir,
      OPENCLAW_HOME: tempDir, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_AUTH_PROFILE_SECRET_KEY: sidecarSeed,
      // Also prevents the legacy sidecar reader from probing the real macOS Keychain.
      VITEST: 'true',
    };
    let stdout = '';
    let stderr = '';
    let code = 0;
    try {
      ({ stdout, stderr } = await execFileAsync(process.execPath,
        [path.join(runtimeRoot!, OPENCLAW_STARTUP_MIGRATION_ENTRY)],
        { cwd: runtimeRoot, env, windowsHide: true, timeout: 30_000 }));
    } catch (error) {
      const failure = error as Error & { code: number; stdout: string; stderr: string };
      if (failure.code !== 1) throw error;
      ({ stdout, stderr, code } = failure);
    }
    const line = stdout.split(/\r?\n/).find(value => value.startsWith(OPENCLAW_STARTUP_MIGRATION_RESULT_PREFIX));
    expect(line, (stdout + stderr).slice(-3000)).toBeDefined();
    return { code, report: JSON.parse(line!.slice(OPENCLAW_STARTUP_MIGRATION_RESULT_PREFIX.length)) };
  }

  function writeSource(filename: string, value: unknown, directory = agentDir): { source: string; bytes: string } {
    fs.mkdirSync(directory, { recursive: true });
    const source = path.join(directory, filename);
    const bytes = typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
    fs.writeFileSync(source, bytes, { mode: 0o600 });
    return { source, bytes };
  }

  function archives(source: string): string[] {
    return fs.readdirSync(path.dirname(source))
      .filter(name => name.startsWith(path.basename(source) + '.migrated-'))
      .map(name => path.join(path.dirname(source), name));
  }

  function expectArchived(fixture: { source: string; bytes: string }): void {
    expect(fs.existsSync(fixture.source)).toBe(false);
    const matches = archives(fixture.source);
    expect(matches).toHaveLength(1);
    expect(fs.readFileSync(matches[0], 'utf8')).toBe(fixture.bytes);
  }

  function readStore(directory = agentDir): { secrets: Record<string, unknown>; state: Record<string, unknown> } {
    const db = new DatabaseSync(path.join(directory, 'openclaw-agent.sqlite'), { readOnly: true });
    try {
      const secrets = db.prepare("SELECT store_json FROM auth_profile_store WHERE store_key = 'primary'").get();
      const state = db.prepare("SELECT state_json FROM auth_profile_state WHERE state_key = 'primary'").get();
      return {
        secrets: JSON.parse(String(secrets?.store_json ?? '{}')),
        state: JSON.parse(String(state?.state_json ?? '{}')),
      };
    } finally { db.close(); }
  }

  function expectAuthConfigWrite(before: Record<string, unknown>, auth: unknown): void {
    const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    // Canonical config writes also stamp the existing OpenClaw model-policy migration.
    expect(after).toEqual({ ...before, auth, meta: {
      lastTouchedVersion: '2026.8.1', migrations: { modelPolicyAllowlist: true },
    } });
    configBytes = fs.readFileSync(configPath, 'utf8');
  }

  test('migrates the configured non-main agent credentials and rotation state without running Doctor', async () => {
    const sources = [
      writeSource('auth-profiles.json', { version: 1, profiles: { [profileId]: fixtureCredential } }),
      writeSource('auth-state.json', fixtureState),
      writeSource('auth.json', { xai: { type: 'api_key', provider: 'xai', key: 'synthetic-legacy-key' } }),
    ];
    const result = await migrate();
    expect(result).toMatchObject({ code: 0, report: {
      status: OpenClawStartupMigrationStatus.Migrated, warnings: [], remainingPaths: [],
      sourceCounts: { [OpenClawStartupMigrationOwner.AuthProfiles]: 3 },
    } });
    expect(readStore()).toMatchObject({
      secrets: { version: 1, profiles: {
        [profileId]: fixtureCredential,
        'xai:default': { type: 'api_key', provider: 'xai', key: 'synthetic-legacy-key' },
      } },
      state: fixtureState,
    });
    sources.forEach(expectArchived);
    const before = readStore();
    expect((await migrate()).report).toMatchObject({
      status: OpenClawStartupMigrationStatus.Skipped, warnings: [], remainingPaths: [],
      sourceCounts: { [OpenClawStartupMigrationOwner.AuthProfiles]: 0 },
    });
    expect(readStore()).toEqual(before);
    sources.forEach(expectArchived);
  });

  test('retires empty legacy profile stores on the first attempt instead of blocking every task', async () => {
    const source = writeSource('auth-profiles.json', { version: 1, profiles: {} });
    const result = await migrate();
    expect(result).toMatchObject({ code: 0, report: {
      status: OpenClawStartupMigrationStatus.Migrated, warnings: [], remainingPaths: [],
      sourceCounts: { [OpenClawStartupMigrationOwner.AuthProfiles]: 1 },
    } });
    expectArchived(source);
    expect((await migrate()).report.status).toBe(OpenClawStartupMigrationStatus.Skipped);
  });

  test('keeps existing SQLite credentials and state when a conflicting legacy file reappears', async () => {
    writeSource('auth-profiles.json', { ...fixtureState, profiles: { [profileId]: fixtureCredential } });
    expect((await migrate()).code).toBe(0);
    const canonical = readStore();
    const source = writeSource('auth-profiles.json', {
      version: 1,
      profiles: {
        [profileId]: { ...fixtureCredential, key: 'synthetic-stale-key' },
        'xai:additional': { type: 'api_key', provider: 'xai', key: 'synthetic-new-key' },
      },
      lastGood: { 'lobsterai-server': 'xai:additional' },
      usageStats: { [profileId]: { lastUsed: 1, errorCount: 99 } },
    });
    expect((await migrate()).code).toBe(0);
    expect(readStore()).toMatchObject({
      secrets: { profiles: {
        [profileId]: fixtureCredential,
        'xai:additional': { type: 'api_key', provider: 'xai', key: 'synthetic-new-key' },
      } },
      state: canonical.state,
    });
    expect(fs.existsSync(source.source)).toBe(false);
    expect(archives(source.source)).toHaveLength(2);
    expect(archives(source.source).map(file => fs.readFileSync(file, 'utf8'))).toContain(source.bytes);
  });

  test.each(['{}', '{"version":1,"profiles":null}'])('rejects unreadable SQLite credential shapes without legacy files: %s', async (raw) => {
    const source = writeSource('auth-profiles.json', { version: 1, profiles: { [profileId]: fixtureCredential } });
    expect((await migrate()).code).toBe(0);
    expectArchived(source);
    const db = new DatabaseSync(path.join(agentDir, 'openclaw-agent.sqlite'));
    try { db.prepare("UPDATE auth_profile_store SET store_json = ? WHERE store_key = 'primary'").run(raw); }
    finally { db.close(); }
    const result = await migrate();
    expect(result).toMatchObject({ code: 1, report: {
      status: OpenClawStartupMigrationStatus.Failed,
      sourceCounts: { [OpenClawStartupMigrationOwner.AuthProfiles]: 0 },
    } });
    expect(result.report.warnings.join(' ')).toContain('Auth profile SQLite store');
    expect(readStore().secrets).toEqual(JSON.parse(raw));
    expectArchived(source);
  });

  test('imports inline config credentials before removing only their secret fields', async () => {
    const before = JSON.parse(configBytes);
    before.auth = { profiles: { [profileId]: {
      provider: 'lobsterai-server', mode: 'api_key', key: 'synthetic-inline-config-key',
      email: 'fixture@example.invalid',
    } } };
    configBytes = JSON.stringify(before, null, 2);
    fs.writeFileSync(configPath, configBytes);
    const result = await migrate();
    expect(result.code, JSON.stringify(result.report)).toBe(0);
    expect(readStore().secrets).toMatchObject({ profiles: {
      [profileId]: { type: 'api_key', provider: 'lobsterai-server', key: 'synthetic-inline-config-key' },
    } });
    expectAuthConfigWrite(before, { profiles: { [profileId]: {
      provider: 'lobsterai-server', mode: 'api_key', email: 'fixture@example.invalid',
    } } });
    expect((await migrate()).report.status).toBe(OpenClawStartupMigrationStatus.Skipped);
  });

  test.each([false, true])('preserves AWS SDK profile metadata in config with credentials=%s', async (includeCredential) => {
    const before = JSON.parse(configBytes);
    const source = writeSource('auth-profiles.json', { version: 1, profiles: {
      'amazon-bedrock:fixture': { type: 'aws-sdk', provider: 'amazon-bedrock', displayName: 'Synthetic AWS role' },
      ...(includeCredential ? { [profileId]: fixtureCredential } : {}),
    } });
    const result = await migrate();
    expect(result.code, JSON.stringify(result.report)).toBe(0);
    if (includeCredential) {
      expect(readStore().secrets).toMatchObject({ profiles: { [profileId]: fixtureCredential } });
    }
    expectAuthConfigWrite(before, { profiles: {
      'amazon-bedrock:fixture': { provider: 'amazon-bedrock', mode: 'aws-sdk', displayName: 'Synthetic AWS role' },
    } });
    expectArchived(source);
    expect((await migrate()).report.status).toBe(OpenClawStartupMigrationStatus.Skipped);
  });

  test('retains AWS auth source when config persistence fails and completes safely on retry', async () => {
    const before = JSON.parse(configBytes);
    const invalidConfig = { ...before, auth: { profiles: {
      'invalid:fixture': { provider: 'fixture', mode: 'invalid-fixture-mode' },
    } } };
    configBytes = JSON.stringify(invalidConfig, null, 2);
    fs.writeFileSync(configPath, configBytes);
    const source = writeSource('auth-profiles.json', { version: 1, profiles: {
      'amazon-bedrock:fixture': { type: 'aws-sdk', provider: 'amazon-bedrock' },
      [profileId]: fixtureCredential,
    } });
    // Legacy auth issues may enter the owner, but the canonical writer must reject
    // an unrelated invalid auth mode before retiring the sole AWS metadata source.
    const failed = await migrate();
    expect(failed.code, JSON.stringify(failed.report)).toBe(1);
    expect(failed.report.status).toBe(OpenClawStartupMigrationStatus.Failed);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(configBytes);
    expect(fs.readFileSync(source.source, 'utf8')).toBe(source.bytes);
    expect(archives(source.source)).toEqual([]);
    configBytes = JSON.stringify(before, null, 2);
    fs.writeFileSync(configPath, configBytes);
    const retried = await migrate();
    expect(retried.code, JSON.stringify(retried.report)).toBe(0);
    expectAuthConfigWrite(before, { profiles: {
      'amazon-bedrock:fixture': { provider: 'amazon-bedrock', mode: 'aws-sdk' },
    } });
    expect(readStore().secrets).toMatchObject({ profiles: { [profileId]: fixtureCredential } });
    expectArchived(source);
    expect((await migrate()).report.status).toBe(OpenClawStartupMigrationStatus.Skipped);
  });

  test('discovers orphan agents and configured custom agent directories', async () => {
    const orphanDir = path.join(stateDir, 'agents/retired-agent/agent');
    const customDir = path.join(tempDir, 'custom auth owner');
    const config = JSON.parse(configBytes);
    config.agents.entries.custom = { agentDir: customDir };
    configBytes = JSON.stringify(config, null, 2);
    fs.writeFileSync(configPath, configBytes);
    const sources = [orphanDir, customDir].map(directory =>
      writeSource('auth-profiles.json', { version: 1, profiles: { [profileId]: fixtureCredential } }, directory));
    expect((await migrate()).report).toMatchObject({
      status: OpenClawStartupMigrationStatus.Migrated, warnings: [], remainingPaths: [],
      sourceCounts: { [OpenClawStartupMigrationOwner.AuthProfiles]: 2 },
    });
    for (const directory of [orphanDir, customDir]) {
      expect(readStore(directory).secrets).toMatchObject({ profiles: { [profileId]: fixtureCredential } });
    }
    sources.forEach(expectArchived);
  });

  test('archives malformed input without pretending that credentials were imported', async () => {
    const source = writeSource('auth-profiles.json', '{ malformed credentials\n');
    const result = await migrate();
    expect(result.code).toBe(0);
    expect(result.report.status).toBe(OpenClawStartupMigrationStatus.Migrated);
    expect(result.report.warnings).toEqual([]);
    expect(result.report.notices.join(' ')).toContain('Archived unparseable auth profile input without import');
    expectArchived(source);
    const dbPath = path.join(agentDir, 'openclaw-agent.sqlite');
    if (fs.existsSync(dbPath)) expect(readStore().secrets).not.toHaveProperty('profiles.' + profileId);
  });

  test('imports a valid auth.json sibling and archives malformed auth-profiles bytes for recovery', async () => {
    const invalid = writeSource('auth-profiles.json', '{ malformed credentials\n');
    const valid = writeSource('auth.json', { xai: { type: 'api_key', provider: 'xai', key: 'synthetic-sibling-key' } });
    expect((await migrate()).code).toBe(0);
    expect(readStore().secrets).toMatchObject({ profiles: {
      'xai:default': { type: 'api_key', provider: 'xai', key: 'synthetic-sibling-key' },
    } });
    expectArchived(invalid);
    expectArchived(valid);
  });

  test('recovers encrypted OAuth sidecars before importing profiles into SQLite', async () => {
    const legacyId = 'openai-codex:migration-fixture';
    const ref = { source: 'openclaw-credentials', provider: 'openai-codex', id: '0123456789abcdef0123456789abcdef' };
    const material = { access: 'synthetic-access', refresh: 'synthetic-refresh', idToken: 'synthetic-id-token' };
    const iv = Buffer.alloc(12, 7);
    const key = createHash('sha256').update(`openclaw:auth-profile-oauth:${sidecarSeed}`).digest();
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`${ref.id}\0${legacyId}\0${ref.provider}`));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(material)), cipher.final()]);
    const sidecar = writeSource(`${ref.id}.json`, {
      version: 1, profileId: legacyId, provider: ref.provider,
      encrypted: { algorithm: 'aes-256-gcm', iv: iv.toString('base64url'),
        tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') },
    }, path.join(stateDir, 'credentials/auth-profiles'));
    const original = writeSource('auth-profiles.json', { version: 1, profiles: {
      [legacyId]: { type: 'oauth', provider: ref.provider, oauthRef: ref,
        expires: 1_900_000_000_000, accountId: 'synthetic-oauth-account', email: 'fixture@example.invalid' },
    } });
    expect((await migrate()).code).toBe(0);
    expect(readStore().secrets).toMatchObject({ profiles: {
      'openai:migration-fixture': { type: 'oauth', provider: 'openai', ...material,
        expires: 1_900_000_000_000, accountId: 'synthetic-oauth-account', email: 'fixture@example.invalid' },
    } });
    expect(fs.existsSync(sidecar.source)).toBe(false);
    expect(fs.existsSync(original.source)).toBe(false);
    const backup = fs.readdirSync(agentDir).find(name => name.startsWith('auth-profiles.json.oauth-ref.') && name.endsWith('.bak'));
    expect(backup).toBeDefined();
    expect(fs.readFileSync(path.join(agentDir, backup!), 'utf8')).toBe(original.bytes);
  });
});
