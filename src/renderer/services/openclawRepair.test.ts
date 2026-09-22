import { afterEach, expect, test, vi } from 'vitest';

import { OpenClawGatewayRepairErrorCode } from '../../shared/openclawEngine/constants';
import { OpenClawRepairStage } from '../../shared/openclawEngine/repair';
import { i18nService } from './i18n';
import { resolveOpenClawRepairError } from './openclawRepair';

afterEach(() => vi.restoreAllMocks());

test('shows the failure stage, source and diagnostic location without implying a complete backup', () => {
  vi.spyOn(i18nService, 't').mockImplementation(key => `${key}${key.endsWith('Path') ? ' {path}' : ''}`);
  const result = { success: false, failedStage: OpenClawRepairStage.Snapshot,
    errorCode: OpenClawGatewayRepairErrorCode.SnapshotFailed, error: 'EPERM', failurePath: 'source.sqlite', backupPath: 'partial-backup' };
  expect(resolveOpenClawRepairError(result)).toBe([
    'openClawRepairSnapshotFailed', 'EPERM', 'openClawRepairFailurePath source.sqlite', 'openClawRepairFilesPath partial-backup',
  ].join('\n'));
  expect(resolveOpenClawRepairError(result, false)).not.toContain('partial-backup');
});

test('older repair responses retain their actual error', () => {
  expect(resolveOpenClawRepairError({ success: false, error: 'Existing repair error' })).toBe('Existing repair error');
});

test('lock recovery failures state that backup and later repairs have not run', () => {
  vi.spyOn(i18nService, 't').mockImplementation(key => key);
  expect(resolveOpenClawRepairError({ success: false, failedStage: OpenClawRepairStage.LockRecovery,
    error: 'Owner identity unavailable' })).toContain('openClawRepairLockRecoveryFailed');
});
