import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  DREAMING_RECOVERY_REPORT_VERSION, OpenClawDreamingRecoveryOutcome as Outcome,
  OpenClawDreamingRecoveryStage as Stage, OpenClawDreamingStateFile as File,
} from '../../shared/openclawEngine/dreamingRecovery';
import {
  OPENCLAW_STARTUP_COMPATIBILITY_ENTRY, OPENCLAW_STARTUP_COMPATIBILITY_RESULT_PREFIX,
  OPENCLAW_STARTUP_COMPATIBILITY_VERSION, OpenClawStartupCompatibilityMode as Mode,
} from '../../shared/openclawEngine/startupCompatibility';
import { OpenClawStartupMigrationStatus as Status } from '../../shared/openclawEngine/startupMigration';
import { readDreamingRecoverySummary } from './openclawDreamingRecovery';
import { runOpenClawStartupCompatibility } from './openclawStartupCompatibility';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-dreaming-report-'));
  fs.writeFileSync(path.join(root, OPENCLAW_STARTUP_COMPATIBILITY_ENTRY), '');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unexpected fixture path');
  fs.rmSync(root, { recursive: true, force: true });
});

const report = () => ({
  reportVersion: DREAMING_RECOVERY_REPORT_VERSION, runtimeVersion: OPENCLAW_STARTUP_COMPATIBILITY_VERSION,
  operation: Mode.RepairDreamingState, status: Status.Migrated as Status, changes: [], backups: [],
  dreaming: {
    reportVersion: DREAMING_RECOVERY_REPORT_VERSION, runtimeVersion: OPENCLAW_STARTUP_COMPATIBILITY_VERSION,
    outcome: Outcome.Recovered as Outcome, blockers: [] as string[], manifestPath: path.join(root, 'manifest.json'),
    files: [{ fileName: File.DailyIngestion, stage: Stage.Verified as Stage, agentIds: ['main'], size: 10,
      sha256: 'a'.repeat(64), sourcePath: path.join(root, File.DailyIngestion),
      backupPath: path.join(root, 'backup'), isolatedPath: path.join(root, 'isolated') }],
  },
});
const run = (value: unknown, code = 0) => runOpenClawStartupCompatibility({
  stateDir: root, configPath: path.join(root, 'openclaw.json'), runtimeRoot: root, electronNodeRuntimePath: process.execPath,
  env: {}, mode: Mode.RepairDreamingState,
  runner: async () => ({ code, stdout: OPENCLAW_STARTUP_COMPATIBILITY_RESULT_PREFIX + JSON.stringify(value), stderr: '' }),
});

describe('dreaming recovery report contract', () => {
  test('passes a verified summary through the existing runner', async () => {
    expect(await run(report())).toMatchObject({ status: Status.Migrated,
      dreamingRecovery: { affectedWorkspaceCount: 1, quarantinedFileCount: 1, pendingFileCount: 0 } });
  });

  test('preserves partial progress and the real blocker when recovery fails', async () => {
    const value = report();
    value.status = Status.Failed;
    value.dreaming.outcome = Outcome.Blocked;
    value.dreaming.files[0].stage = Stage.Isolated;
    value.dreaming.blockers.push('EPERM fixture');
    expect(await run({ ...value, error: 'EPERM fixture' }, 1)).toMatchObject({ status: Status.Failed, error: 'EPERM fixture',
      dreamingRecovery: { quarantinedFileCount: 0, pendingFileCount: 1 } });
  });

  test('keeps verified isolation progress but fails startup on a maintenance cleanup error', async () => {
    expect(await run({ ...report(), status: Status.Failed, error: 'Migration lock release failed.' }, 1))
      .toMatchObject({ status: Status.Failed, error: 'Migration lock release failed.', dreamingRecovery: { quarantinedFileCount: 1 } });
  });

  test('rejects missing versions, mismatched modes, incomplete isolation and inconsistent outcomes', async () => {
    const value = report();
    for (const invalid of [
      { ...value, reportVersion: undefined },
      { ...value, operation: Mode.RepairBindings },
      { ...value, runtimeVersion: 'future' },
      { ...value, dreaming: { ...value.dreaming, files: [{ ...value.dreaming.files[0], stage: Stage.BackedUp }] } },
      { ...value, status: Status.Skipped },
      { ...value, dreaming: { ...value.dreaming, files: [{ ...value.dreaming.files[0], sourcePath: 'relative/path' }] } },
    ]) expect((await run(invalid)).status).toBe(Status.Failed);
  });

  test('a healthy install can read empty recovery history without creating state', () => {
    expect(readDreamingRecoverySummary(root)).toBeUndefined();
    expect(fs.readdirSync(root)).toEqual([OPENCLAW_STARTUP_COMPATIBILITY_ENTRY]);
  });
});
