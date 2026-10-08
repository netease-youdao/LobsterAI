import { describe, expect, test } from 'vitest';

import { OpenClawDreamingStateLabel } from '../../shared/openclawEngine/dreamingRecovery';
import { createDreamingStartupFailureCollector, extractDreamingStartupFailure, OPENCLAW_STARTUP_MIGRATION_REFUSAL } from './openclawDreamingStartupFailure';

const detail = (label: string = OpenClawDreamingStateLabel.DailyIngestion, operation = 'imported') =>
  `- Skipped Memory Core ${label} import for C:\\工作区\\main because the legacy source could not be ${operation}: SyntaxError: Unexpected non-whitespace character after JSON at position 414 (line 23 column 1)`;

describe('current startup Memory Core failure evidence', () => {
  test('captures all four owners and import/comparison failures after the terminal refusal', () => {
    const output = [OPENCLAW_STARTUP_MIGRATION_REFUSAL, ...Object.values(OpenClawDreamingStateLabel).map(label => detail(label, 'compared'))].join('\n');
    expect(extractDreamingStartupFailure('', output)).toContain('(4 source(s))');
  });

  test('retains evidence past 80 lines, across byte chunks and a split UTF-8 character', () => {
    const collector = createDreamingStartupFailureCollector();
    const raw = Buffer.from(`\u001b[31m[openclaw] Reason: ${OPENCLAW_STARTUP_MIGRATION_REFUSAL}\u001b[0m\r\n${detail()}\n`
      + '- unrelated migration notice\n'.repeat(120) + '    at startup (runtime.js:42:5)');
    for (let offset = 0; offset < raw.length; offset += 7) collector.write(raw.subarray(offset, offset + 7));
    expect(collector.finish()).toContain('(1 source(s))');
  });

  test('extracts a structured CLI cause before UI truncation without quoting private JSON', () => {
    const message = `${OPENCLAW_STARTUP_MIGRATION_REFUSAL}\n${detail()} PRIVATE_MEMORY_SNIPPET\n` + '- notice\n'.repeat(600);
    const output = 'diagnostic\n' + JSON.stringify({ ok: false, error: { type: 'cli_error', message } });
    const failure = extractDreamingStartupFailure(output, 'Config warnings: plugin unavailable');
    expect(failure).toContain('Memory Core legacy JSON');
    expect(failure).not.toContain('PRIVATE_MEMORY_SNIPPET');
    expect(failure!.length).toBeLessThan(500);
  });

  test.each([
    detail(),
    `${detail()}\n${OPENCLAW_STARTUP_MIGRATION_REFUSAL}\n- unrelated cause`,
    `${OPENCLAW_STARTUP_MIGRATION_REFUSAL}\n${detail().replace('SyntaxError:', 'Error: EACCES')}`,
    `${OPENCLAW_STARTUP_MIGRATION_REFUSAL}\n${detail('unknown owner')}`,
    `${OPENCLAW_STARTUP_MIGRATION_REFUSAL}\n    at startup\n${detail()}`,
    `${OPENCLAW_STARTUP_MIGRATION_REFUSAL}\n${detail()}\n${OPENCLAW_STARTUP_MIGRATION_REFUSAL}\n- unrelated cause`,
  ])('does not authorize recovery from warnings or another cause (%#)', output => {
    expect(extractDreamingStartupFailure('', output)).toBeUndefined();
  });

  test('does not inherit evidence from a previous process or an oversized line', () => {
    const first = createDreamingStartupFailureCollector();
    first.write(`${OPENCLAW_STARTUP_MIGRATION_REFUSAL}\n${detail()}`);
    expect(first.finish()).toBeDefined();
    const next = createDreamingStartupFailureCollector();
    next.write(OPENCLAW_STARTUP_MIGRATION_REFUSAL + 'x'.repeat(40_000));
    next.write('\n' + detail());
    expect(next.finish()).toBeUndefined();
  });

  test('prefers an unrelated final CLI cause over diagnostic stderr', () => {
    const stdout = JSON.stringify({ ok: false, error: { type: 'cli_error', message: 'Port already in use' } });
    expect(extractDreamingStartupFailure(stdout, `${OPENCLAW_STARTUP_MIGRATION_REFUSAL}\n${detail()}`)).toBeUndefined();
  });
});
