import { expect, test } from 'vitest';

import {
  formatOpenClawRepairProgress, OPENCLAW_REPAIR_PROGRESS_PREFIX, OpenClawRepairPhase, type OpenClawRepairProgress,
  OpenClawRepairProgressStage, parseOpenClawRepairProgress,
} from './repair';

test('a progress line round-trips with and without measured totals', () => {
  const scan: OpenClawRepairProgress = {
    phase: OpenClawRepairPhase.Snapshot, stage: OpenClawRepairProgressStage.Scan, files: 12, bytes: 3_000,
  };
  const copy: OpenClawRepairProgress = {
    ...scan, stage: OpenClawRepairProgressStage.Copy, files: 0, bytes: 0, totalFiles: 12, totalBytes: 12 * 1024 ** 3,
  };
  for (const progress of [scan, copy]) {
    const line = formatOpenClawRepairProgress(progress);
    expect(line.startsWith(OPENCLAW_REPAIR_PROGRESS_PREFIX)).toBe(true);
    expect(line).not.toContain('\n');
    expect(parseOpenClawRepairProgress(line)).toEqual(progress);
  }
});

test.each([
  ['another line', 'LOBSTERAI_GATEWAY_REPAIR_RESULT={"phase":"snapshot"}'],
  ['broken JSON', `${OPENCLAW_REPAIR_PROGRESS_PREFIX}{"phase":`],
  ['a non-object', `${OPENCLAW_REPAIR_PROGRESS_PREFIX}null`],
  ['an unknown phase', `${OPENCLAW_REPAIR_PROGRESS_PREFIX}{"phase":"doctor","stage":"copy","files":0,"bytes":0}`],
  ['an unknown stage', `${OPENCLAW_REPAIR_PROGRESS_PREFIX}{"phase":"snapshot","stage":"done","files":0,"bytes":0}`],
  ['a negative count', `${OPENCLAW_REPAIR_PROGRESS_PREFIX}{"phase":"snapshot","stage":"copy","files":-1,"bytes":0}`],
  ['a missing count', `${OPENCLAW_REPAIR_PROGRESS_PREFIX}{"phase":"snapshot","stage":"copy","files":1}`],
  ['a text total', `${OPENCLAW_REPAIR_PROGRESS_PREFIX}{"phase":"snapshot","stage":"copy","files":0,"bytes":0,"totalBytes":"9"}`],
])('%s is not progress', (_label, line) => {
  expect(parseOpenClawRepairProgress(line)).toBeUndefined();
});
