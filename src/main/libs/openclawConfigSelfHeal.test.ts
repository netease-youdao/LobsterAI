import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  healOpenClawConfigUnrecognizedKeys,
  OpenClawConfigSelfHealStatus,
  parseOpenClawConfigValidateOutput,
  removeUnrecognizedOpenClawConfigKeys,
} from './openclawConfigSelfHeal';
import type { StartupMigrationRunner } from './openclawStartupStateMigration';

// Keys LobsterAI wrote before aligning with the v2026.8.1 schema; that runtime rejects them.
const retiredConfig = () => ({
  gateway: { mode: 'local' },
  tools: { loopDetection: { enabled: true, historySize: 48, warningThreshold: 6, detectors: { pingPong: true } } },
  session: { maintenance: { rotateBytes: 1_000 } },
  cron: { enabled: true, maxConcurrentRuns: 3 },
});

// Shape of `openclaw config validate --json` from the bundled v2026.8.1 CLI.
const retiredIssues = [
  { path: 'tools.loopDetection', message: 'Unrecognized keys: "historySize", "warningThreshold", "detectors"' },
  { path: 'session.maintenance', message: 'Unrecognized key: "rotateBytes"' },
  { path: 'cron', message: 'Unrecognized key: "maxConcurrentRuns"' },
];

describe('removeUnrecognizedOpenClawConfigKeys', () => {
  test('removes exactly the keys OpenClaw reported and leaves the rest', () => {
    const original = retiredConfig();
    const { config, removed } = removeUnrecognizedOpenClawConfigKeys(original, retiredIssues);

    expect(config).toEqual({
      gateway: { mode: 'local' },
      tools: { loopDetection: { enabled: true } },
      session: { maintenance: {} },
      cron: { enabled: true },
    });
    expect(removed).toEqual([
      'tools.loopDetection.historySize',
      'tools.loopDetection.warningThreshold',
      'tools.loopDetection.detectors',
      'session.maintenance.rotateBytes',
      'cron.maxConcurrentRuns',
    ]);
    expect(original.cron).toEqual({ enabled: true, maxConcurrentRuns: 3 });
  });

  test('resolves the root marker, dotted keys and array indices, and ignores other issue kinds', () => {
    const { config, removed } = removeUnrecognizedOpenClawConfigKeys({
      stale: true,
      models: { 'qwen3.6-plus': { legacyFlag: 1, name: 'Qwen' } },
      agents: { list: [{ id: 'main', retired: 1 }] },
      plugins: { entries: { compat: { config: {} } } },
    }, [
      { path: '<root>', message: 'Unrecognized key: "stale"' },
      { path: 'models.qwen3.6-plus', message: 'Unrecognized key: "legacyFlag"' },
      { path: 'agents.list.0', message: 'Unrecognized key: "retired"' },
      { path: 'plugins.entries.compat.config', message: 'invalid config: must match a schema in anyOf' },
      { path: 'plugins.load.paths', message: 'plugin: plugin path not found: /old/third-party-extensions' },
      { path: 'missing.path', message: 'Unrecognized key: "x"' },
    ]);

    expect(config).toEqual({
      models: { 'qwen3.6-plus': { name: 'Qwen' } },
      agents: { list: [{ id: 'main' }] },
      plugins: { entries: { compat: { config: {} } } },
    });
    expect(removed).toEqual(['stale', 'models.qwen3.6-plus.legacyFlag', 'agents.list.0.retired']);
  });

  test('keeps retired keys that dedicated migrations still carry forward', () => {
    const { config, removed } = removeUnrecognizedOpenClawConfigKeys({
      plugins: {
        installs: { demo: { source: 'npm', spec: 'demo@1.0.0' } },
        bundledDiscovery: 'compat',
        retired: true,
      },
    }, [{ path: 'plugins', message: 'Unrecognized keys: "installs", "bundledDiscovery", "retired"' }]);

    expect(config).toEqual({
      plugins: { installs: { demo: { source: 'npm', spec: 'demo@1.0.0' } }, bundledDiscovery: 'compat' },
    });
    expect(removed).toEqual(['plugins.retired']);
  });
});

describe('parseOpenClawConfigValidateOutput', () => {
  test('reads the CLI JSON report and rejects unrelated output', () => {
    expect(parseOpenClawConfigValidateOutput(JSON.stringify({
      ok: false, error: { type: 'cli_error', message: 'OpenClaw config is invalid' }, valid: false, issues: retiredIssues,
    }, null, 2))).toEqual({ valid: false, issues: retiredIssues });
    expect(parseOpenClawConfigValidateOutput('{"valid":true,"path":"/state/openclaw.json","warnings":[]}'))
      .toEqual({ valid: true, issues: [] });
    expect(parseOpenClawConfigValidateOutput('Segmentation fault')).toBeNull();
    expect(parseOpenClawConfigValidateOutput('{"ok":false}')).toBeNull();
  });
});

describe('healOpenClawConfigUnrecognizedKeys', () => {
  let tmpDir: string;
  let stateDir: string;
  let configPath: string;
  let runtimeRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-openclaw-config-heal-'));
    stateDir = path.join(tmpDir, 'openclaw', 'state');
    runtimeRoot = path.join(tmpDir, 'runtime');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, 'openclaw.mjs'), '');
    configPath = path.join(stateDir, 'openclaw.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const healWith = (runner: StartupMigrationRunner) => healOpenClawConfigUnrecognizedKeys({
    configPath, stateDir, runtimeRoot, electronNodeRuntimePath: '/electron/node', env: { EXISTING: 'kept' }, runner,
    now: new Date('2026-09-18T12:00:00.000Z'),
  });

  test('rewrites the config, keeps a backup and validates again', async () => {
    fs.writeFileSync(configPath, JSON.stringify(retiredConfig()));
    const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const runner: StartupMigrationRunner = async (command, args, options) => {
      calls.push({ command, args, env: options.env });
      const current = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ReturnType<typeof retiredConfig>;
      const valid = !('historySize' in current.tools.loopDetection);
      return { code: valid ? 0 : 1, stderr: '', stdout: JSON.stringify({ valid, issues: valid ? [] : retiredIssues }) };
    };

    const result = await healWith(runner);

    const backupPath = `${configPath}.before-self-heal-2026-09-18T12-00-00-000Z`;
    expect(result).toEqual({
      status: OpenClawConfigSelfHealStatus.Healed,
      removed: expect.arrayContaining(['cron.maxConcurrentRuns', 'session.maintenance.rotateBytes']),
      backupPath,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].command).toBe('/electron/node');
    expect(calls[0].args).toEqual([path.join(runtimeRoot, 'openclaw.mjs'), 'config', 'validate', '--json']);
    expect(calls[0].env).toMatchObject({
      EXISTING: 'kept',
      OPENCLAW_HOME: path.dirname(stateDir),
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      ELECTRON_RUN_AS_NODE: '1',
    });
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({
      gateway: { mode: 'local' },
      tools: { loopDetection: { enabled: true } },
      session: { maintenance: {} },
      cron: { enabled: true },
    });
    expect(JSON.parse(fs.readFileSync(backupPath, 'utf8'))).toEqual(retiredConfig());
  });

  test('leaves the file untouched when nothing is removable or the config is already valid', async () => {
    const content = JSON.stringify({ plugins: { load: { paths: ['/old/third-party-extensions'] } } });
    fs.writeFileSync(configPath, content);
    const issues = [{ path: 'plugins.load.paths', message: 'plugin: plugin path not found: /old/third-party-extensions' }];
    const invalid: StartupMigrationRunner = async () => ({
      code: 1, stderr: '', stdout: JSON.stringify({ valid: false, issues }),
    });
    await expect(healWith(invalid)).resolves.toEqual({
      status: OpenClawConfigSelfHealStatus.Invalid, removed: [], issues,
    });
    expect(fs.readFileSync(configPath, 'utf8')).toBe(content);

    const valid: StartupMigrationRunner = async () => ({ code: 0, stderr: '', stdout: '{"valid":true,"warnings":[]}' });
    await expect(healWith(valid)).resolves.toEqual({ status: OpenClawConfigSelfHealStatus.Valid });
    expect(fs.readdirSync(stateDir)).toEqual(['openclaw.json']);
  });

  test('does not overwrite a config that changed while the CLI was validating it', async () => {
    fs.writeFileSync(configPath, JSON.stringify(retiredConfig()));
    const synced = `${JSON.stringify({ gateway: { mode: 'local' }, cron: { enabled: true } })}\n`;
    const runner: StartupMigrationRunner = async () => {
      fs.writeFileSync(configPath, synced);
      return { code: 1, stderr: '', stdout: JSON.stringify({ valid: false, issues: retiredIssues }) };
    };

    await expect(healWith(runner)).resolves.toEqual({
      status: OpenClawConfigSelfHealStatus.Skipped, reason: 'config-changed',
    });
    expect(fs.readFileSync(configPath, 'utf8')).toBe(synced);
    expect(fs.readdirSync(stateDir)).toEqual(['openclaw.json']);
  });

  test('skips without a bundled CLI, a config file or a parseable report', async () => {
    const neverRuns: StartupMigrationRunner = async () => { throw new Error('must not run'); };
    await expect(healWith(neverRuns)).resolves.toEqual({
      status: OpenClawConfigSelfHealStatus.Skipped, reason: 'missing-config',
    });

    fs.writeFileSync(configPath, JSON.stringify(retiredConfig()));
    const silent: StartupMigrationRunner = async () => ({ code: 1, stderr: '', stdout: '' });
    await expect(healWith(silent)).resolves.toEqual({
      status: OpenClawConfigSelfHealStatus.Skipped, reason: 'unparseable-validate-output',
    });

    fs.rmSync(path.join(runtimeRoot, 'openclaw.mjs'));
    await expect(healWith(neverRuns)).resolves.toEqual({
      status: OpenClawConfigSelfHealStatus.Skipped, reason: 'missing-openclaw-cli',
    });
  });
});
