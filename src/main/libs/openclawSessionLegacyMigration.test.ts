import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { OpenClawEngineErrorCode } from '../../shared/openclawEngine/constants';
import { OPENCLAW_STARTUP_MIGRATION_REFUSAL } from './openclawDreamingStartupFailure';
import {
  computeLegacySessionStoreFingerprint,
  LEGACY_SESSION_MIGRATION_RETRY_COOLDOWN_MS,
  LEGACY_SESSION_SQLITE_IMPORT_MODE,
  type LegacySessionMigrationRunner,
  type LegacySessionMigrationRunResult,
  LegacySessionMigrationWarningCode,
  listLegacySessionStorePaths,
  migrateLegacySessionStorageWithDoctor,
  shouldSkipLegacySessionMigrationRetry,
} from './openclawSessionLegacyMigration';

let tempDir = '';
let stateDir = '';
let runtimeRoot = '';
let configPath = '';

function writeFile(filePath: string, content = '{}\n'): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function createWarningImportFixture() {
  const legacyPath = path.join(stateDir, 'agents', 'main', 'sessions', 'sessions.json');
  const archivePath = path.join(stateDir, 'archives', 'sessions.json.imported');
  writeFile(legacyPath);
  return {
    legacyPath,
    archivePath,
    report: {
      mode: LEGACY_SESSION_SQLITE_IMPORT_MODE as string,
      totals: { issues: 2, targets: 1 },
      migrationRun: { manifestPath: path.join(stateDir, 'session-sqlite-migration-runs', 'run.json') },
      targets: [{
        agentId: 'main', storePath: legacyPath, archivedLegacyStoreFiles: [archivePath],
        issues: [
          { code: LegacySessionMigrationWarningCode.EntryInvalid as string, message: 'Session entry is missing a valid sessionId.' },
          { code: LegacySessionMigrationWarningCode.TranscriptMissing as string, message: 'Historical transcript is missing.' },
        ],
      }],
    },
  };
}

function archiveWarningFixture(fixture: ReturnType<typeof createWarningImportFixture>): void {
  fs.mkdirSync(path.dirname(fixture.archivePath), { recursive: true });
  fs.renameSync(fixture.legacyPath, fixture.archivePath);
}

describe('openclawSessionLegacyMigration', () => {
  test.each([false, true])('classifies the Agent media migration requirement from CLI output, json=%s', async json => {
    const legacy = path.join(stateDir, 'agents', 'main', 'sessions', 'sessions.json');
    writeFile(legacy);
    const cause = `OpenClaw agent database ${path.join(stateDir, 'agents', 'main', 'agent', 'openclaw-agent.sqlite')} uses schema version 1; run openclaw doctor --fix to migrate persisted media before using it.`;
    const result = await migrateLegacySessionStorageWithDoctor({
      stateDir, configPath, runtimeRoot, electronNodeRuntimePath: process.execPath, env: {},
      runner: async () => ({ code: 1,
        stdout: json ? JSON.stringify({ ok: false, error: { type: 'cli_error', message: cause } }) : '',
        stderr: 'Config warnings: unrelated plugin warning\n[openclaw] Reason: ' + cause,
      }),
    });
    expect(result).toMatchObject({ status: 'failed', errorCode: OpenClawEngineErrorCode.AgentMediaMigrationRequired });
    expect(fs.readFileSync(legacy, 'utf8')).toBe('{}\n');
  });
  test('preserves dreaming failure classification from a long structured CLI error', async () => {
    writeFile(path.join(stateDir, 'agents', 'main', 'sessions', 'sessions.json'));
    const message = `${OPENCLAW_STARTUP_MIGRATION_REFUSAL}\n- Skipped Memory Core session ingestion import for fixture because the legacy source could not be imported: SyntaxError: invalid JSON\n`
      + '- another migration warning\n'.repeat(200);
    const result = await migrateLegacySessionStorageWithDoctor({
      stateDir, configPath, runtimeRoot, electronNodeRuntimePath: process.execPath, env: {},
      runner: async () => ({ code: 1, stdout: JSON.stringify({ ok: false, error: { type: 'cli_error', message } }), stderr: '' }),
    });
    expect(result).toMatchObject({ status: 'failed', errorCode: OpenClawEngineErrorCode.MemoryDreamingMigrationFailed });
    if (result.status === 'failed') expect(result.error).toContain('session ingestion');
  });
  test('surfaces the incident SQLite cli_error instead of duplicate-plugin warnings', async () => {
    writeFile(path.join(stateDir, 'agents', 'main', 'sessions', 'sessions.json'));
    const cause = `SQLite schema is incomplete or noncanonical for ${path.join(stateDir, 'state', 'openclaw.sqlite')}: column definitions differ for current_conversation_bindings`;
    const runner = vi.fn<LegacySessionMigrationRunner>().mockResolvedValue({
      code: 1,
      stderr: 'Config warnings: plugins.entries.openclaw-weixin: duplicate plugin id\nplugins.entries.acpx: plugin not installed\n[openclaw] Could not start the CLI.\n[openclaw] Reason: ' + cause,
      stdout: JSON.stringify({ ok: false, error: { type: 'cli_error', message: cause } }),
    });
    const result = await migrateLegacySessionStorageWithDoctor({
      stateDir, configPath, runtimeRoot, electronNodeRuntimePath: process.execPath, env: {}, runner,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain(cause);
      expect(result.error).not.toContain('Config warnings');
    }
  });
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-openclaw-session-migration-'));
    stateDir = path.join(tempDir, 'openclaw', 'state');
    runtimeRoot = path.join(tempDir, 'runtime');
    configPath = path.join(stateDir, 'openclaw.json');
    writeFile(path.join(runtimeRoot, 'openclaw.mjs'), 'console.log("openclaw");\n');
    writeFile(configPath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('skips when no legacy session stores exist', async () => {
    const runner = vi.fn<LegacySessionMigrationRunner>();

    const result = await migrateLegacySessionStorageWithDoctor({
      stateDir,
      configPath,
      runtimeRoot,
      electronNodeRuntimePath: process.execPath,
      env: {},
      runner,
    });

    expect(result).toEqual({ status: 'skipped', reason: 'no-legacy-session-files' });
    expect(runner).not.toHaveBeenCalled();
  });

  test('discovers shared and per-agent default legacy stores', () => {
    const sharedPath = path.join(stateDir, 'sessions', 'sessions.json');
    const mainPath = path.join(stateDir, 'agents', 'main', 'sessions', 'sessions.json');
    const workerPath = path.join(stateDir, 'agents', 'worker', 'sessions', 'sessions.json');
    writeFile(sharedPath);
    writeFile(mainPath);
    writeFile(workerPath);

    expect(listLegacySessionStorePaths(stateDir)).toEqual([sharedPath, mainPath, workerPath]);
  });

  test('runs official doctor with the same state and config then verifies migration', async () => {
    const legacyPath = path.join(stateDir, 'agents', 'main', 'sessions', 'sessions.json');
    writeFile(legacyPath, '{"agent:main:main":{"sessionId":"existing"}}\n');
    const runner = vi.fn<LegacySessionMigrationRunner>().mockImplementation(async () => {
      fs.renameSync(legacyPath, `${legacyPath}.migrated`);
      return { code: 0, stdout: 'migrated', stderr: '' };
    });

    const result = await migrateLegacySessionStorageWithDoctor({
      stateDir,
      configPath,
      runtimeRoot,
      electronNodeRuntimePath: process.execPath,
      env: { EXISTING: '1' },
      runner,
    });

    expect(result).toEqual({ status: 'migrated', code: 0, migratedPaths: [legacyPath] });
    expect(runner).toHaveBeenCalledTimes(1);
    const [command, args, options] = runner.mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(args).toEqual([
      path.join(runtimeRoot, 'openclaw.mjs'),
      'doctor',
      '--session-sqlite',
      'import',
      '--session-sqlite-all-agents',
      '--json',
    ]);
    expect(options.cwd).toBe(runtimeRoot);
    expect(options.env.EXISTING).toBe('1');
    expect(options.env.OPENCLAW_HOME).toBe(path.dirname(stateDir));
    expect(options.env.OPENCLAW_STATE_DIR).toBe(stateDir);
    expect(options.env.OPENCLAW_CONFIG_PATH).toBe(configPath);
    expect(options.env.OPENCLAW_SERVICE_REPAIR_POLICY).toBe('external');
    expect(options.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  test('surfaces the doctor cause before long config warnings without hiding diagnostic logs', async () => {
    writeFile(path.join(stateDir, 'agents', 'main', 'sessions', 'sessions.json'));
    const warning = `[config] warnings: ${'duplicate plugin id; '.repeat(300)}`;
    const cause = "Cannot find package 'openclaw' imported from /runtime/discord/dist/owner-access.js";
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runner = vi.fn<LegacySessionMigrationRunner>().mockResolvedValue({
      code: 1,
      stdout: 'Earlier memory migration completed.',
      stderr: `${warning}\n${cause}\n    at packageResolve (node:internal/modules/esm/resolve:762:9)\n`,
    });

    const result = await migrateLegacySessionStorageWithDoctor({
      stateDir, configPath, runtimeRoot, electronNodeRuntimePath: process.execPath, env: {}, runner,
    });

    expect(result).toMatchObject({ code: 1, error: expect.stringContaining(cause) });
    if (!('error' in result)) throw new Error('Expected migration failure');
    expect(result.error.slice(0, 500)).toContain(cause);
    expect(result.error).not.toContain('duplicate plugin id');
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('duplicate plugin id'));
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('Earlier memory migration completed.'));
  });

  test('keeps a useful failure when doctor emits only warnings', async () => {
    writeFile(path.join(stateDir, 'agents', 'main', 'sessions', 'sessions.json'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const runner = vi.fn<LegacySessionMigrationRunner>().mockResolvedValue({
      code: 1, stdout: '', stderr: '[config] warnings: duplicate plugin id\n',
    });

    const result = await migrateLegacySessionStorageWithDoctor({
      stateDir, configPath, runtimeRoot, electronNodeRuntimePath: process.execPath, env: {}, runner,
    });

    expect(result).toMatchObject({
      code: 1,
      error: 'OpenClaw legacy session migration failed with exit code 1.',
    });
  });

  test.each(['│', '|'])('reports wrapped stdout validation errors with %s borders', async (border) => {
    writeFile(path.join(stateDir, 'agents', 'main', 'sessions', 'sessions.json'));
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runner = vi.fn<LegacySessionMigrationRunner>().mockResolvedValue({
      code: 1,
      stderr: 'Config clobber snapshot cap reached: rotating oldest snapshots.\n',
      stdout: [
        '│ Doctor could not apply config fixes: the repaired config still fails │',
        '│ validation. │',
        "│ - channels.qqbot.allowFrom: invalid config for plugin qqbot: must have │",
        "│   required property 'allowFrom' │",
        '│ - channels.qqbot.accounts: invalid config for plugin qqbot: must not │',
        '│   be valid │',
        '│ No config changes were written. │',
      ].join('\n').replaceAll('│', border),
    });
    const result = await migrateLegacySessionStorageWithDoctor({
      stateDir, configPath, runtimeRoot, electronNodeRuntimePath: process.execPath, env: {}, runner,
    });
    expect(result).toMatchObject({
      status: 'failed', code: 1,
      error: expect.stringContaining("channels.qqbot.allowFrom: invalid config for plugin qqbot: must have required property 'allowFrom'"),
    });
    if (!('error' in result)) throw new Error('Expected migration failure');
    expect(result.error).not.toContain('snapshot');
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('rotating oldest snapshots'));
  });

  test('surfaces structured session import issues', async () => {
    writeFile(path.join(stateDir, 'agents', 'main', 'sessions', 'sessions.json'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const runner = vi.fn<LegacySessionMigrationRunner>().mockResolvedValue({
      code: 1, stderr: '',
      stdout: JSON.stringify({ targets: [{ agentId: 'main', issues: [{ message: 'Transcript validation failed' }] }] }),
    });
    const result = await migrateLegacySessionStorageWithDoctor({
      stateDir, configPath, runtimeRoot, electronNodeRuntimePath: process.execPath, env: {}, runner,
    });
    expect(result).toMatchObject({
      status: 'failed', error: expect.stringContaining('main: Transcript validation failed'),
    });
  });

  test('continues after warning-only import only when every discovered store has an existing archive', async () => {
    const fixture = createWarningImportFixture();
    const workerPath = path.join(stateDir, 'agents', 'worker', 'sessions', 'sessions.json');
    const workerArchive = path.join(stateDir, 'archives', 'worker-sessions.json.imported');
    writeFile(workerPath);
    fixture.report.targets.push({ agentId: 'worker', storePath: workerPath, archivedLegacyStoreFiles: [workerArchive], issues: [] });
    fixture.report.totals.targets += 1;
    const logWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logInfo = vi.spyOn(console, 'log').mockImplementation(() => {});
    const runner = vi.fn<LegacySessionMigrationRunner>().mockImplementation(async () => {
      archiveWarningFixture(fixture);
      fs.renameSync(workerPath, workerArchive);
      return { code: 1, stdout: JSON.stringify(fixture.report), stderr: '' };
    });

    const result = await migrateLegacySessionStorageWithDoctor({
      stateDir, configPath, runtimeRoot, electronNodeRuntimePath: process.execPath, env: {}, runner,
    });

    expect(result).toEqual({ status: 'migrated', code: 1, migratedPaths: [fixture.legacyPath, workerPath] });
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('completed with warnings'));
    expect(logInfo).toHaveBeenCalledWith(expect.stringContaining(JSON.stringify(fixture.report.migrationRun.manifestPath)));
    expect(fs.readFileSync(fixture.archivePath, 'utf8')).toBe('{}\n');
  });

  test('shows a blocking issue from a later target before an invalid-entry warning and logs issue counts', async () => {
    const fixture = createWarningImportFixture();
    const blockerCode = 'sqlite_transcript_count_mismatch';
    const sessionKey = 'agent:worker:historical-session';
    const logInfo = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const stdout = JSON.stringify({
      ...fixture.report,
      totals: { issues: 3, targets: 2 },
      targets: [...fixture.report.targets, {
        agentId: 'worker', storePath: path.join(stateDir, 'agents', 'worker', 'sessions', 'sessions.json'),
        issues: [{ code: blockerCode, message: 'SQLite transcript has 8 events; source has 9.', sessionKey }],
      }],
    });
    const runner = vi.fn<LegacySessionMigrationRunner>().mockResolvedValue({ code: 1, stdout, stderr: '' });

    const result = await migrateLegacySessionStorageWithDoctor({
      stateDir, configPath, runtimeRoot, electronNodeRuntimePath: process.execPath, env: {}, runner,
    });

    expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining(`worker: [${blockerCode}]`) });
    if (!('error' in result)) throw new Error('Expected migration failure');
    expect(result.error).toContain(sessionKey);
    expect(result.error).not.toContain('missing a valid sessionId');
    expect(logInfo).toHaveBeenCalledWith(expect.stringContaining(`"${blockerCode}":1`));
    expect(logInfo).toHaveBeenCalledWith(expect.stringContaining(JSON.stringify(fixture.report.migrationRun.manifestPath)));
  });

  const rejectedWarningImports: Array<{
    name: string;
    mutate: (fixture: ReturnType<typeof createWarningImportFixture>, result: LegacySessionMigrationRunResult) => void;
  }> = [
    { name: 'terminated process', mutate: (_fixture, result) => { result.code = null; } },
    { name: 'unexpected exit code', mutate: (_fixture, result) => { result.code = 2; } },
    { name: 'exception after report', mutate: (_fixture, result) => { result.stderr = 'Error: SQLite finalization failed'; } },
    { name: 'different doctor mode', mutate: (fixture) => { fixture.report.mode = 'validate'; } },
    { name: 'mismatched issue total', mutate: (fixture) => { fixture.report.totals.issues += 1; } },
    { name: 'mismatched target total', mutate: (fixture) => { fixture.report.totals.targets += 1; } },
    { name: 'unknown issue code', mutate: (fixture) => { fixture.report.targets[0].issues[0].code = 'future_blocking_issue'; } },
    { name: 'unreported archive', mutate: (fixture) => { fixture.report.targets[0].archivedLegacyStoreFiles = []; } },
    { name: 'missing archive file', mutate: (fixture) => { fs.unlinkSync(fixture.archivePath); } },
    { name: 'uncovered source store', mutate: (fixture) => { fixture.report.targets[0].storePath = path.join(stateDir, 'other.json'); } },
    { name: 'remaining source store', mutate: (fixture) => { fs.copyFileSync(fixture.archivePath, fixture.legacyPath); } },
    { name: 'newly created source store', mutate: () => { writeFile(path.join(stateDir, 'agents', 'new', 'sessions', 'sessions.json')); } },
  ];

  test.each(rejectedWarningImports)('rejects warning-only completion with $name', async ({ mutate }) => {
    const fixture = createWarningImportFixture();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const runner = vi.fn<LegacySessionMigrationRunner>().mockImplementation(async () => {
      archiveWarningFixture(fixture);
      const result: LegacySessionMigrationRunResult = { code: 1, stdout: '', stderr: '' };
      mutate(fixture, result);
      result.stdout = JSON.stringify(fixture.report);
      return result;
    });

    const result = await migrateLegacySessionStorageWithDoctor({
      stateDir, configPath, runtimeRoot, electronNodeRuntimePath: process.execPath, env: {}, runner,
    });

    expect(result.status).toBe('failed');
  });

  test.each(['', 'not JSON', '{"mode":"import","targets":null}', '{"mode":"import","targets":[]}'])(
    'does not infer success from missing stores with an incomplete report: %s', async (stdout) => {
      const fixture = createWarningImportFixture();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const runner = vi.fn<LegacySessionMigrationRunner>().mockImplementation(async () => {
        archiveWarningFixture(fixture);
        return { code: 1, stdout, stderr: '' };
      });
      const result = await migrateLegacySessionStorageWithDoctor({
        stateDir, configPath, runtimeRoot, electronNodeRuntimePath: process.execPath, env: {}, runner,
      });
      expect(result.status).toBe('failed');
    },
  );

  test('fails closed when doctor exits successfully but leaves the legacy store', async () => {
    const legacyPath = path.join(stateDir, 'agents', 'main', 'sessions', 'sessions.json');
    writeFile(legacyPath);
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runner = vi.fn<LegacySessionMigrationRunner>().mockResolvedValue({
      code: 0,
      stdout: 'A legacy store was retained by doctor.',
      stderr: '',
    });

    const result = await migrateLegacySessionStorageWithDoctor({
      stateDir,
      configPath,
      runtimeRoot,
      electronNodeRuntimePath: process.execPath,
      env: {},
      runner,
    });

    expect(result).toEqual({
      status: 'failed',
      code: 0,
      error: 'OpenClaw doctor completed but 1 legacy session store(s) remain.',
    });
    expect(fs.existsSync(legacyPath)).toBe(true);
    expect(logError).toHaveBeenCalledWith(expect.stringContaining(JSON.stringify(legacyPath)));
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('modifiedAt'));
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('A legacy store was retained by doctor.'));
  });

  test('records lock owner and residual stores when doctor reports contention', async () => {
    const legacyPath = path.join(stateDir, 'agents', 'main', 'sessions', 'sessions.json');
    writeFile(legacyPath);
    const lockPayload = JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() });
    writeFile(`${configPath}.lock`, lockPayload);
    const logWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = vi.fn<LegacySessionMigrationRunner>().mockResolvedValue({
      code: 1, stdout: '', stderr: `file lock timeout for ${configPath}`,
    });
    const result = await migrateLegacySessionStorageWithDoctor({
      stateDir, configPath, runtimeRoot, electronNodeRuntimePath: process.execPath, env: {}, runner,
    });
    expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('file lock timeout') });
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining(`"ownerPid":${process.pid}`));
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('"ownerAlive":true'));
    expect(fs.readFileSync(`${configPath}.lock`, 'utf8')).toBe(lockPayload);
    expect(fs.existsSync(legacyPath)).toBe(true);
  });

  test('does not run when the bundled OpenClaw CLI is missing', async () => {
    fs.rmSync(path.join(runtimeRoot, 'openclaw.mjs'));
    writeFile(path.join(stateDir, 'agents', 'main', 'sessions', 'sessions.json'));
    const runner = vi.fn<LegacySessionMigrationRunner>();

    const result = await migrateLegacySessionStorageWithDoctor({
      stateDir,
      configPath,
      runtimeRoot,
      electronNodeRuntimePath: process.execPath,
      env: {},
      runner,
    });

    expect(result).toEqual({ status: 'skipped', reason: 'missing-openclaw-cli' });
    expect(runner).not.toHaveBeenCalled();
  });

  test('keeps the Node [cause] line next to the doctor exception', async () => {
    writeFile(path.join(stateDir, 'agents', 'main', 'sessions', 'sessions.json'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const runner = vi.fn<LegacySessionMigrationRunner>().mockResolvedValue({
      code: 1,
      stdout: '',
      stderr: [
        'Error: Unable to create private Windows SQLite directory: C:\\Users\\u\\AppData\\Local\\Temp\\openclaw-session-import-1',
        '    at createPrivateSqliteDirectorySync (file:///C:/app/dist/sqlite.js:10:5)',
        '  [cause]: Error: PowerShell failed (status=1, exit=1); stderr: Add-Type : Cannot add type.',
        '      at buildPowerShellFailureCause (file:///C:/app/dist/sqlite.js:20:9)',
      ].join('\n'),
    });

    const result = await migrateLegacySessionStorageWithDoctor({
      stateDir, configPath, runtimeRoot, electronNodeRuntimePath: process.execPath, env: {}, runner,
    });

    expect(result.status).toBe('failed');
    expect(result).toMatchObject({
      error: expect.stringContaining(
        'Unable to create private Windows SQLite directory: C:\\Users\\u\\AppData\\Local\\Temp\\openclaw-session-import-1'
        + ' (cause: Error: PowerShell failed (status=1, exit=1); stderr: Add-Type : Cannot add type.)',
      ),
    });
  });

  test('skips automatic doctor reruns while a failure for unchanged stores is fresh', () => {
    const legacyPath = path.join(stateDir, 'agents', 'main', 'sessions', 'sessions.json');
    writeFile(legacyPath);
    const fingerprint = computeLegacySessionStoreFingerprint(stateDir);
    const previous = { at: 1_000_000, error: 'boom', fingerprint };
    const soon = previous.at + 7_000;
    const skip = (reason: string, now = soon, current = fingerprint) =>
      shouldSkipLegacySessionMigrationRetry({ previous, fingerprint: current, reason, now });

    expect(skip('ensure-running-for-cowork')).toBe(true);
    expect(skip('restart:config-sync:mcp')).toBe(true);
    expect(skip('manual-repair')).toBe(false);
    expect(skip('restart:ipc-manual')).toBe(false);
    expect(skip('bootstrap:manual-retry')).toBe(false);
    expect(skip('ensure-running-for-cowork', previous.at + LEGACY_SESSION_MIGRATION_RETRY_COOLDOWN_MS)).toBe(false);

    writeFile(legacyPath, '{"changed":true}\n');
    expect(skip('ensure-running-for-cowork', soon, computeLegacySessionStoreFingerprint(stateDir))).toBe(false);
    expect(shouldSkipLegacySessionMigrationRetry({ previous: null, fingerprint, reason: 'auto', now: soon })).toBe(false);
  });
});
