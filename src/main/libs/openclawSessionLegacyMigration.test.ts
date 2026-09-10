import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  LEGACY_SESSION_SQLITE_IMPORT_MODE,
  type LegacySessionMigrationRunner,
  type LegacySessionMigrationRunResult,
  LegacySessionMigrationWarningCode,
  listLegacySessionStorePaths,
  migrateLegacySessionStorageWithDoctor,
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
});
