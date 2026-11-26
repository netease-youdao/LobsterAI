import { describe, expect, test } from 'vitest';

import {
  DataMigrationErrorCode,
  DataMigrationProgressPhase,
} from '../../shared/dataMigration/constants';
import {
  hasPostRestoreActionableNotices,
  mapDataMigrationErrorMessage,
  mapDataMigrationProgressPhaseLabel,
} from './dataMigration';

const identityT = (key: string): string => `t:${key}`;

describe('dataMigration renderer service helpers', () => {
  test('maps structured error codes to localized i18n keys', () => {
    expect(
      mapDataMigrationErrorMessage(DataMigrationErrorCode.LegacyOpenClawUnsupported, 'raw', identityT),
    ).toBe('t:dataMigrationErrorLegacyOpenClaw');
    expect(
      mapDataMigrationErrorMessage(DataMigrationErrorCode.UnsupportedFormat, 'raw', identityT),
    ).toBe('t:dataMigrationErrorUnsupportedFormat');
    expect(
      mapDataMigrationErrorMessage(DataMigrationErrorCode.InsufficientDiskSpace, 'Need 2 GB', identityT),
    ).toBe('Need 2 GB');
  });

  test('maps progress phases to localized labels', () => {
    expect(mapDataMigrationProgressPhaseLabel(DataMigrationProgressPhase.CreatingArchive, identityT))
      .toBe('t:dataMigrationPhaseCreatingArchive');
    expect(mapDataMigrationProgressPhaseLabel(DataMigrationProgressPhase.CreatingRollback, identityT))
      .toBe('t:dataMigrationPhaseCreatingRollback');
  });

  test('detects actionable post-restore notices accurately', () => {
    expect(hasPostRestoreActionableNotices(null)).toBe(false);
    expect(hasPostRestoreActionableNotices({ isCrossMachine: false })).toBe(false);
    expect(hasPostRestoreActionableNotices({ isCrossMachine: true, clearedBrowserCredentialCount: 2 })).toBe(true);
    expect(hasPostRestoreActionableNotices({
      isCrossMachine: true,
      missingDshPlugins: [{ name: 'foo', specifier: '^1.0.0', enabled: true }],
    })).toBe(true);
  });
});
