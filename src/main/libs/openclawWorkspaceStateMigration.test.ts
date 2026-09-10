import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  OPENCLAW_WORKSPACE_MIGRATION_ENTRY,
  OPENCLAW_WORKSPACE_MIGRATION_RESULT_PREFIX,
  type OpenClawWorkspaceMigrationReport,
  OpenClawWorkspaceMigrationStatus,
} from '../../shared/openclawEngine/workspaceMigration';
import { migrateLegacyWorkspaceStateBeforeStartup } from './openclawWorkspaceStateMigration';

let tempDir: string;
const report = (overrides: Partial<OpenClawWorkspaceMigrationReport> = {}): string => (
  OPENCLAW_WORKSPACE_MIGRATION_RESULT_PREFIX + JSON.stringify({
    status: OpenClawWorkspaceMigrationStatus.Migrated,
    sourceCount: 2, changes: ['Migrated workspace setup state to SQLite.'],
    warnings: [], remainingPaths: [], ...overrides,
  })
);

describe('workspace state migration before gateway startup', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-workspace-migration-'));
    fs.writeFileSync(path.join(tempDir, OPENCLAW_WORKSPACE_MIGRATION_ENTRY), '');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function options() {
    return {
      stateDir: path.join(tempDir, 'openclaw', 'state'),
      configPath: path.join(tempDir, 'openclaw', 'state', 'openclaw.json'),
      runtimeRoot: tempDir,
      electronNodeRuntimePath: '/electron/node',
      env: { EXISTING: 'preserved', OPENCLAW_STATE_DIR: '/wrong-state', OPENCLAW_HOME: '/wrong-home' },
    };
  }

  test('runs the focused helper with the gateway state/config and preserves other environment', async () => {
    const runner = vi.fn(async () => ({ code: 0, stdout: `diagnostic line\n${report()}\n`, stderr: '' }));
    const params = options();
    expect(await migrateLegacyWorkspaceStateBeforeStartup({ ...params, runner })).toEqual({
      status: OpenClawWorkspaceMigrationStatus.Migrated,
    });
    expect(runner).toHaveBeenCalledWith('/electron/node', [path.join(tempDir, OPENCLAW_WORKSPACE_MIGRATION_ENTRY)], {
      cwd: tempDir,
      env: {
        EXISTING: 'preserved', OPENCLAW_HOME: path.dirname(params.stateDir),
        OPENCLAW_STATE_DIR: params.stateDir, OPENCLAW_CONFIG_PATH: params.configPath,
        OPENCLAW_SERVICE_REPAIR_POLICY: 'external', ELECTRON_RUN_AS_NODE: '1',
      },
      timeoutMs: 180_000,
    });
  });

  test('does not log a migration on an already migrated installation', async () => {
    const runner = vi.fn(async () => ({
      code: 0, stdout: report({ status: OpenClawWorkspaceMigrationStatus.Skipped, sourceCount: 0, changes: [] }), stderr: '',
    }));
    expect(await migrateLegacyWorkspaceStateBeforeStartup({ ...options(), runner })).toEqual({
      status: OpenClawWorkspaceMigrationStatus.Skipped,
    });
    expect(console.log).not.toHaveBeenCalled();
  });

  test('logs the quarantine backup when another source prevents startup', async () => {
    const change = 'Quarantined corrupt workspace attestation; backup: /state/workspace-attestation-quarantine/copy.attested.';
    const runner = vi.fn(async () => ({
      code: 1,
      stdout: report({
        status: OpenClawWorkspaceMigrationStatus.Failed,
        changes: [change], warnings: ['Another source is invalid'], remainingPaths: ['/state/other-source'],
      }),
      stderr: '',
    }));
    expect((await migrateLegacyWorkspaceStateBeforeStartup({ ...options(), runner })).status)
      .toBe(OpenClawWorkspaceMigrationStatus.Failed);
    expect(console.log).toHaveBeenCalledWith('[OpenClaw] Workspace state migration: ' + change);
  });

  test.each([
    { code: 0, stdout: report({ remainingPaths: ['/workspace/.openclaw/workspace-state.json'] }), stderr: '', expected: 'Unmigrated workspace state' },
    { code: 0, stdout: report({ warnings: ['Gateway owns this state directory'] }), stderr: '', expected: 'Gateway owns this state directory' },
    { code: 1, stdout: report({ status: OpenClawWorkspaceMigrationStatus.Failed, warnings: ['legacy workspace setup contains invalid JSON'] }), stderr: '', expected: 'invalid JSON' },
    { code: 1, stdout: report(), stderr: '', expected: 'exit code 1' },
    { code: 0, stdout: '', stderr: '', expected: 'verified completion' },
    { code: 0, stdout: OPENCLAW_WORKSPACE_MIGRATION_RESULT_PREFIX + '{}', stderr: '', expected: 'verified completion' },
    { code: 1, stdout: '', stderr: 'Cannot find package dependency', expected: 'Cannot find package dependency' },
  ])('blocks unverified migration: $expected', async ({ expected, ...result }) => {
    const runner = vi.fn(async () => result);
    expect(await migrateLegacyWorkspaceStateBeforeStartup({ ...options(), runner })).toEqual({
      status: OpenClawWorkspaceMigrationStatus.Failed, error: expect.stringContaining(expected),
    });
  });

  test('fails when an old runtime lacks the helper', async () => {
    fs.unlinkSync(path.join(tempDir, OPENCLAW_WORKSPACE_MIGRATION_ENTRY));
    const runner = vi.fn();
    expect(await migrateLegacyWorkspaceStateBeforeStartup({ ...options(), runner })).toEqual({
      status: OpenClawWorkspaceMigrationStatus.Failed, error: expect.stringContaining('helper is missing'),
    });
    expect(runner).not.toHaveBeenCalled();
  });

  test('keeps process/timeout errors retryable', async () => {
    const runner = vi.fn(async () => { throw new Error('migration timed out'); });
    expect(await migrateLegacyWorkspaceStateBeforeStartup({ ...options(), runner })).toEqual({
      status: OpenClawWorkspaceMigrationStatus.Failed, error: 'migration timed out',
    });
  });
});
